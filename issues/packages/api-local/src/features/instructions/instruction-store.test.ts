import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { openSqliteStore, SqliteStore } from "../../sqlite-store.js";
import { createSqliteExecutor } from "../../db/sqlite-executor.js";
import { runMigrations } from "../../db/migration-runner.js";
import { migrations } from "../../migrations/index.js";
import { transformLegacySqliteV7 } from "../../migrations/legacy-v7-direct.js";

let directory: string;
let store: SqliteStore;

it("inspects and resets the complete personal instruction set to requesting release defaults", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	const items = [
		{ key: "agent/issues", kind: "agent" as const, body: "Agent <!-- include:fragment/rules -->" },
		{ key: "skill/prepare", kind: "skill" as const, body: "Skill <!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" }
	];
	await store.importInstructionBundle({ version, items });
	const personal = await store.createInstructionFragment({ version, key: "fragment/personal", body: "Personal" });
	const saved = await store.saveInstructionSource({ version, key: "fragment/rules", body: "<!-- include:fragment/personal -->", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: items.map((item) => ({ ...item, body: `New ${item.body}` })) });
	const next = { version: "2.0.0" };
	const before = await store.listInstructionSources(next);
	const proposal = await store.inspectInstructionResetAll(next);
	expect(proposal).toMatchObject({
		...next, overrides: [{ currentSource: { ...saved, version: next.version }, proposedSource: { body: "New Rules", source: { type: "default", revision: 3 } } }],
		personalFragments: [{ ...personal, version: next.version }],
		affectedInstructions: ["agent/issues", "skill/prepare"],
		expectedRevisions: [{ key: "fragment/personal", expectedRevision: 1 }, { key: "fragment/rules", expectedRevision: 2 }]
	});
	expect(await store.listInstructionSources(next)).toEqual(before);
	await store.resetInstructionAll({ ...next, expectedRevisions: proposal.expectedRevisions });
	expect((await store.listInstructionSources(next)).items).toHaveLength(3);
	expect(await store.retrieveInstruction({ ...next, key: "skill/prepare" })).toMatchObject({ body: "New Skill New Rules", source: { type: "default" } });
	expect((await store.listInstructionHistory({ ...next, key: saved.key })).revisions[0]).toMatchObject({ body: "New Rules", source: { type: "default", revision: 3 } });
	await store.importInstructionBundle({ version, items });
	await store.importInstructionBundle({ version: next.version, items: items.map((item) => ({ ...item, body: `New ${item.body}` })) });
	await store.close();
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	expect(await store.retrieveInstruction({ version, key: "skill/prepare" })).toMatchObject({ body: "Skill Rules", source: { type: "default" } });
});

it("includes overrides absent from the requested release and clears them across releases", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/retired" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "skill", body: "Original default" }] });
	const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: "skill/current", kind: "skill", body: "Current default" }] });
	const proposal = await store.inspectInstructionResetAll({ version: "2.0.0" });
	expect(proposal).toMatchObject({ overrides: [{ currentSource: { key: input.key, body: saved.body }, proposedSource: null }], expectedRevisions: [{ key: input.key, expectedRevision: 2 }] });
	await store.resetInstructionAll({ version: proposal.version, expectedRevisions: proposal.expectedRevisions });
	expect(await store.readInstructionSource(input)).toMatchObject({ body: "Original default", source: { type: "default", revision: 3 } });
	expect((await store.listInstructionHistory(input)).revisions[0]).toMatchObject({ body: "Original default", source: { type: "default", revision: 3 } });
	expect(await store.inspectInstructionResetAll({ version: "2.0.0" })).toMatchObject({ overrides: [], personalFragments: [], expectedRevisions: [] });
});

it("resets a personal fragment whose key is supplied by a newer release default", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] });
	await store.createInstructionFragment({ version: "1.0.0", key: "fragment/new-default", body: "Personal" });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: "fragment/new-default", kind: "fragment", body: "New default" }] });
	const input = { version: "2.0.0", key: "fragment/new-default" };
	const proposal = await store.inspectInstructionResetAll(input);
	expect(proposal).toMatchObject({ overrides: [], personalFragments: [{ key: input.key, body: "Personal" }] });
	await store.resetInstructionAll({ version: input.version, expectedRevisions: proposal.expectedRevisions });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "New default", source: { type: "default" } });
});

it("resets a hidden override and a personal fragment with the same key", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const key = "fragment/shared-key";
	await store.importInstructionBundle({ version: "1.0.0", items: [{ key, kind: "fragment", body: "Default" }] });
	await store.saveInstructionSource({ version: "1.0.0", key, body: "Override", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: "skill/current", kind: "skill", body: "Current" }] });
	await store.createInstructionFragment({ version: "2.0.0", key, body: "Personal" });
	const proposal = await store.inspectInstructionResetAll({ version: "2.0.0" });
	expect(proposal).toMatchObject({ overrides: [{ currentSource: { key, body: "Override" }, proposedSource: null }], personalFragments: [{ key, body: "Personal" }] });
	expect(proposal.expectedRevisions).toEqual([
		{ key, sourceType: "override", expectedRevision: 2 },
		{ key, sourceType: "personal", expectedRevision: 1 }
	]);
	for (const sourceType of ["override", "personal"] as const) {
		const expectedRevisions = proposal.expectedRevisions.map((item) => ({ ...item, expectedRevision: item.expectedRevision + (item.sourceType === sourceType ? 1 : 0) }));
		await expect(store.resetInstructionAll({ version: proposal.version, expectedRevisions })).rejects.toMatchObject({ reason: "revision-conflict", currentInspection: proposal });
		expect(await store.inspectInstructionResetAll({ version: proposal.version })).toEqual(proposal);
	}
	await store.resetInstructionAll({ version: proposal.version, expectedRevisions: proposal.expectedRevisions });
	expect(await store.inspectInstructionResetAll({ version: "2.0.0" })).toMatchObject({ overrides: [], personalFragments: [] });
	expect(await store.readInstructionSource({ version: "1.0.0", key })).toMatchObject({ body: "Default", source: { type: "default", revision: 3 } });
});

it.each(["edit", "add", "remove"] as const)("rejects a Reset All proposal after an owner item %s without partial changes", async (change) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "skill", body: "Default" }] });
	await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	const fragment = await store.createInstructionFragment({ ...input, key: "fragment/personal", body: "Personal fragment" });
	const proposal = await store.inspectInstructionResetAll(input);
	if (change === "edit") await store.saveInstructionSource({ ...input, body: "New personal", expectedRevision: 2 });
	if (change === "add") await store.createInstructionFragment({ ...input, key: "fragment/added", body: "Added" });
	if (change === "remove") await store.removeInstructionFragment({ ...input, key: fragment.key, expectedRevision: 1 });
	const before = await store.listInstructionSources(input);
	const history = await store.listInstructionHistory(input);
	await expect(store.resetInstructionAll({ version: input.version, expectedRevisions: proposal.expectedRevisions })).rejects.toMatchObject({ reason: "revision-conflict" });
	expect(await store.listInstructionSources(input)).toEqual(before);
	expect(await store.listInstructionHistory(input)).toEqual(history);
});

it.each(["missing", "cycle"] as const)("rejects Reset All with a %s default dependency without changing the owner set", async (failure) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "fragment/rules" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "fragment", body: "Default" }] });
	await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	await store.createInstructionFragment({ ...input, key: "fragment/personal", body: "Personal fragment" });
	const proposal = await store.inspectInstructionResetAll(input);
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: input.key, kind: "fragment", body: `<!-- include:fragment/${failure === "missing" ? "missing" : "rules"} -->` }] });
	const next = { ...input, version: "2.0.0" };
	const before = await store.listInstructionSources(next);
	const history = await store.listInstructionHistory(next);
	await expect(store.resetInstructionAll({ version: next.version, expectedRevisions: proposal.expectedRevisions })).rejects.toMatchObject({ reason: "invalid-source" });
	await expect(store.inspectInstructionResetAll(next)).rejects.toMatchObject({ reason: "invalid-source" });
	await expect(store.resetInstructionAll({ version: "missing", expectedRevisions: [] })).rejects.toThrow("defaults unavailable");
	expect(await store.listInstructionSources(next)).toEqual(before);
	expect(await store.listInstructionHistory(next)).toEqual(history);
});

it("inspects nested dependencies and reverse impact without changing saved source", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [
		{ key: input.key, kind: "skill", body: "<!-- include:fragment/rules --> <!-- include:fragment/rules -->" },
		{ key: "agent/issues", kind: "agent", body: "<!-- include:fragment/end -->" },
		{ key: "fragment/rules", kind: "fragment", body: "<!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "End" }
	] });
	const saved = await store.saveInstructionSource({ ...input, key: "fragment/end", body: "Personal end", expectedRevision: 1 });
	const before = await store.listInstructionSources(input);
	const history = await store.listInstructionHistory({ ...input, key: saved.key });
	expect(await store.inspectInstructionDependencies(input)).toEqual({
		...input, source: before.items.find((item) => item.key === input.key)!.source,
		dependencies: [
			{ key: "fragment/end", direct: false, source: saved.source },
			{ key: "fragment/rules", direct: true, source: before.items.find((item) => item.key === "fragment/rules")!.source }
		],
		affectedInstructions: [], modifiedFragments: ["fragment/end"]
	});
	expect(await store.inspectInstructionDependencies({ ...input, key: saved.key })).toMatchObject({
		dependencies: [], affectedInstructions: ["agent/issues", input.key], modifiedFragments: [saved.key]
	});
	expect(await store.listInstructionSources(input)).toEqual(before);
	expect(await store.listInstructionHistory({ ...input, key: saved.key })).toEqual(history);
});

it.each(["missing", "not-fragment"] as const)("reports %s references for the requested release without fallback", async (reason) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [
		{ key: input.key, kind: "skill", body: "<!-- include:fragment/removed -->" },
		{ key: "fragment/removed", kind: "fragment", body: "Old release" }
	] });
	const saved = await store.saveInstructionSource({ ...input, body: "Retained <!-- include:fragment/removed -->", expectedRevision: 1 });
	const next = { ...input, version: "2.0.0" };
	await store.importInstructionBundle({ version: next.version, items: [
		{ key: input.key, kind: "skill", body: "New default" },
		{ key: "fragment/rules", kind: "fragment", body: "<!-- include:skill/other -->" },
		{ key: "skill/other", kind: "skill", body: "<!-- include:fragment/hidden -->" },
		{ key: "fragment/hidden", kind: "fragment", body: "Hidden" }
	] });
	const selected = reason === "missing" ? next : { ...next, key: "fragment/rules" };
	expect(await store.inspectInstructionDependencies(selected)).toMatchObject({
		...selected,
		dependencies: [{ key: reason === "missing" ? "fragment/removed" : "skill/other", direct: true, source: null, reason }]
	});
	expect(await store.readInstructionSource(next)).toMatchObject({ body: saved.body, source: saved.source });
	expect((await store.listInstructionHistory(next)).revisions).toHaveLength(1);
	await expect(store.inspectInstructionDependencies({ ...next, version: "unavailable" })).rejects.toThrow("defaults unavailable");
	await expect(store.inspectInstructionDependencies({ ...next, key: "skill/unknown" })).rejects.toThrow("Instruction not found");
	await store.close();
	await expect(store.inspectInstructionDependencies(next)).rejects.toThrow();
});

it("compares source with the requested release default without changing saved content", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
		await store.importInstructionBundle({ version, items: [{ key: input.key, kind: "skill", body: `Default ${version}` }] });
	}
	expect(await store.compareInstructionSource(input)).toMatchObject({
		...input, different: false, newerDefaultVersions: ["2.0.0", "3.0.0"],
		currentSource: { body: "Default 1.0.0", source: { type: "default" } },
		defaultSource: { version: "1.0.0", body: "Default 1.0.0", source: { type: "default", revision: 1 } }
	});
	const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	const next = { ...input, version: "2.0.0" };
	const before = await store.readInstructionSource(next);
	const history = await store.listInstructionHistory(next);
	expect(await store.compareInstructionSource(next)).toMatchObject({
		...next, different: true, newerDefaultVersions: ["3.0.0"], currentSource: before,
		defaultSource: { version: "2.0.0", body: "Default 2.0.0", source: { type: "default", revision: 1 } }
	});
	expect(before.source).toEqual(saved.source);
	expect(await store.readInstructionSource(next)).toEqual(before);
	expect(await store.listInstructionHistory(next)).toEqual(history);
});

it("compares matching overrides and personal fragments and rejects unavailable comparison sources", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "skill", body: "Default" }] });
	const saved = await store.saveInstructionSource({ ...input, body: "Default", expectedRevision: 1 });
	expect(await store.compareInstructionSource(input)).toMatchObject({ currentSource: saved, different: false, newerDefaultVersions: [] });
	const personalInput = { ...input, key: "fragment/personal" };
	const personal = await store.createInstructionFragment({ ...personalInput, body: "Personal" });
	expect(await store.compareInstructionSource(personalInput)).toEqual({ ...personalInput, currentSource: personal, defaultSource: null, different: null, newerDefaultVersions: [] });
	await expect(store.compareInstructionSource({ ...input, version: "missing" })).rejects.toThrow("defaults unavailable");
	await expect(store.compareInstructionSource({ ...input, key: "skill/missing" })).rejects.toThrow("Instruction not found");
	expect(await store.readInstructionSource(input)).toEqual(saved);
	expect((await store.listInstructionHistory(input)).revisions).toEqual([saved]);
	await store.close();
	await expect(store.compareInstructionSource(input)).rejects.toThrow();
});

it.each(["agent", "skill", "fragment"] as const)("resets only the selected %s override and follows later release defaults", async (kind) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: `${kind}/prepare` };
	await store.importInstructionBundle({ version: input.version, items: [
		{ key: input.key, kind, body: "Default <!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules" }
	] });
	const fragment = await store.saveInstructionSource({ version: input.version, key: "fragment/rules", body: "Personal rules", expectedRevision: 1 });
	const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	const reset = await store.resetInstructionSource({ ...input, expectedRevision: saved.source.revision });
	expect(reset).toMatchObject({ body: "Default <!-- include:fragment/rules -->", source: { type: "default", revision: 3 } });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Default Personal rules", source: reset.source });
	expect(await store.readInstructionSource({ ...input, key: "fragment/rules" })).toEqual(fragment);
	expect((await store.listInstructionHistory(input)).revisions).toEqual([reset, saved]);
	await store.close();
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	expect(await store.readInstructionRevision({ ...input, revision: reset.source.revision })).toEqual(reset);
	await store.importInstructionBundle({ version: "2.0.0", items: [
		{ key: input.key, kind, body: "New default <!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "New rules" }
	] });
	expect(await store.retrieveInstruction({ ...input, version: "2.0.0" })).toMatchObject({ body: "New default Personal rules", source: { type: "default", revision: 3 } });
	await expect(store.saveInstructionSource({ ...input, body: "Stale", expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict" });
	const edited = await store.saveInstructionSource({ ...input, body: "Edited after reset", expectedRevision: reset.source.revision });
	expect(edited.source).toMatchObject({ type: "override", revision: 4, defaultVersion: input.version });
	const restored = await store.restoreInstructionRevision({ ...input, revision: reset.source.revision, expectedRevision: edited.source.revision });
	expect(restored).toMatchObject({ body: reset.body, source: { type: "override", revision: 5 } });
	expect((await store.listInstructionHistory(input)).revisions).toEqual([restored, edited, reset, saved]);
});

it("inspects reset changes and remaining nested fragment overrides without saving", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "fragment/rules" };
	await store.importInstructionBundle({ version: input.version, items: [
		{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
		{ key: input.key, kind: "fragment", body: "Default <!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "End" }
	] });
	await store.saveInstructionSource({ ...input, key: "fragment/end", body: "Personal end", expectedRevision: 1 });
	const saved = await store.saveInstructionSource({ ...input, body: "Personal rules", expectedRevision: 1 });
	const before = await store.listInstructionSources(input);
	expect(await store.inspectInstructionReset(input)).toMatchObject({
		...input, currentSource: saved,
		proposedSource: { body: "Default <!-- include:fragment/end -->", source: { type: "default", revision: 3 } },
		affectedInstructions: ["skill/prepare"], modifiedFragments: ["fragment/end"]
	});
	expect(await store.listInstructionSources(input)).toEqual(before);
	expect((await store.listInstructionHistory(input)).revisions).toEqual([saved]);
});

it.each(["missing", "cycle"] as const)("rejects stale and %s resets without changing source or history", async (failure) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "fragment/rules" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "fragment", body: "Old" }] });
	const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: input.key, kind: "fragment", body: `<!-- include:fragment/${failure === "missing" ? "missing" : "rules"} -->` }] });
	const next = { ...input, version: "2.0.0" };
	const before = await store.listInstructionSources(next);
	const history = await store.listInstructionHistory(next);
	await expect(store.resetInstructionSource({ ...next, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict" });
	await expect(store.resetInstructionSource({ ...next, expectedRevision: saved.source.revision })).rejects.toMatchObject({ reason: "invalid-source" });
	await expect(store.inspectInstructionReset(next)).rejects.toThrow();
	expect(await store.listInstructionSources(next)).toEqual(before);
	expect(await store.listInstructionHistory(next)).toEqual(history);
});

it("retains saved instruction source revisions after reopening storage", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "skill", body: "Default" }] });
	const first = await store.saveInstructionSource({ ...input, body: "First", expectedRevision: 1 });
	const second = await store.saveInstructionSource({ ...input, body: "Second", expectedRevision: first.source.revision });
	await store.close();
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	expect(await store.listInstructionHistory(input)).toEqual({ ...input, revisions: [second, first] });
	expect(await store.readInstructionRevision({ ...input, revision: first.source.revision })).toEqual(first);
	expect(await store.readInstructionSource(input)).toEqual(second);
});

it.each(["agent", "skill", "fragment", "personal"] as const)("restores %s history as a new active revision without changing defaults", async (kind) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: kind === "personal" ? "fragment/personal" : `${kind}/example` };
	await store.importInstructionBundle({ version: input.version, items: [{ key: kind === "personal" ? "skill/example" : input.key, kind: kind === "personal" ? "skill" : kind, body: "Default" }] });
	const first = kind === "personal"
		? await store.createInstructionFragment({ ...input, body: "First" })
		: await store.saveInstructionSource({ ...input, body: "First", expectedRevision: 1 });
	const second = await store.saveInstructionSource({ ...input, body: "Second", expectedRevision: first.source.revision });
	const restored = await store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: second.source.revision });
	expect(restored).toMatchObject({ ...first, source: { ...first.source, revision: second.source.revision + 1 } });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "First", source: restored.source });
	expect(await store.listInstructionHistory(input)).toEqual({ ...input, revisions: [restored, second, first] });
	await store.importInstructionBundle({ version: input.version, items: [{ key: kind === "personal" ? "skill/example" : input.key, kind: kind === "personal" ? "skill" : kind, body: "Default" }] });
});

it.each(["missing", "cycle"] as const)("rejects invalid restores with a %s dependency without changing source or history", async (failure) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	const input = { version, key: "fragment/rules" };
	await store.importInstructionBundle({ version, items: [{ key: input.key, kind: "fragment", body: "Default" }] });
	await store.createInstructionFragment({ version, key: "fragment/personal", body: "Personal" });
	const first = await store.saveInstructionSource({ ...input, body: "<!-- include:fragment/personal -->", expectedRevision: 1 });
	const second = await store.saveInstructionSource({ ...input, body: "Current", expectedRevision: first.source.revision });
	if (failure === "missing") await store.removeInstructionFragment({ version, key: "fragment/personal", expectedRevision: 1 });
	else await store.saveInstructionSource({ version, key: "fragment/personal", body: "<!-- include:fragment/rules -->", expectedRevision: 1 });
	const history = await store.listInstructionHistory(input);
	await expect(store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: second });
	await expect(store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: second.source.revision })).rejects.toMatchObject({ reason: "invalid-source", currentSource: second });
	await expect(store.restoreInstructionRevision({ ...input, revision: 999, expectedRevision: second.source.revision })).rejects.toThrow("revision not found");
	await expect(store.restoreInstructionRevision({ ...input, version: "missing", revision: first.source.revision, expectedRevision: second.source.revision })).rejects.toThrow("defaults unavailable");
	expect(await store.readInstructionSource(input)).toEqual(second);
	expect(await store.listInstructionHistory(input)).toEqual(history);
});

it("carries overrides across releases and reports changed default dependencies", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "A" },
		{ key: "skill/unchanged", kind: "skill", body: "A unchanged" },
		{ key: "fragment/rules", kind: "fragment", body: "A rules <!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "A end" }
	] });
	const saved = await store.saveInstructionSource({ version: "1.0.0", key: "skill/prepare", body: "Personal <!-- include:fragment/rules -->", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "B <!-- include:fragment/rules --> <!-- include:fragment/new -->" },
		{ key: "skill/unchanged", kind: "skill", body: "B unchanged" },
		{ key: "fragment/rules", kind: "fragment", body: "B rules <!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "B end" },
		{ key: "fragment/new", kind: "fragment", body: "New" }
	] });
	const input = { version: "2.0.0", key: "skill/prepare" };
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Personal B rules B end", source: saved.source });
	expect(await store.retrieveInstruction({ ...input, key: "skill/unchanged" })).toMatchObject({ body: "B unchanged", source: { type: "default" } });
	const source = await store.readInstructionSource(input);
	expect(source).toMatchObject({ body: saved.body, source: saved.source, releaseChanges: {
		defaultVersion: "2.0.0", newerDefaultAvailable: true, defaultChanged: true,
		dependencies: { added: ["fragment/new"], removed: [], changed: ["fragment/end", "fragment/rules"] }
	} });
	expect((await store.listInstructionSources(input)).items.find((item) => item.key === input.key)).toEqual(expect.objectContaining({ releaseChanges: source.releaseChanges }));
	const savedAgain = await store.saveInstructionSource({ ...input, body: "Edited under B <!-- include:fragment/rules -->", expectedRevision: saved.source.revision });
	expect(savedAgain.source).toMatchObject({ type: "override", defaultVersion: "1.0.0", revision: 3 });
	expect(await store.readInstructionSource(input)).toMatchObject({ body: savedAgain.body, source: savedAgain.source, releaseChanges: source.releaseChanges });
	const restored = await store.restoreInstructionRevision({ ...input, revision: saved.source.revision, expectedRevision: savedAgain.source.revision });
	expect(restored.source).toMatchObject({ type: "override", defaultVersion: "1.0.0", revision: 4 });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Personal B rules B end", source: restored.source });
});

it("does not label an older requested default as newer than an override baseline", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	for (const version of ["1.0.0", "2.0.0"]) {
		await store.importInstructionBundle({ version, items: [{ key: "skill/prepare", kind: "skill", body: version }] });
	}
	const saved = await store.saveInstructionSource({ version: "2.0.0", key: "skill/prepare", body: "Personal", expectedRevision: 1 });
	expect(await store.readInstructionSource({ version: "1.0.0", key: "skill/prepare" })).toMatchObject({
		body: saved.body, source: saved.source, releaseChanges: { defaultVersion: "1.0.0", newerDefaultAvailable: false }
	});
});

it.each(["missing", "cycle"])("rejects a release update with a %s dependency without falling back", async (failure) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "A <!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "A rules" }
	] });
	const saved = await store.saveInstructionSource({ version: "1.0.0", key: "skill/prepare", body: "Personal <!-- include:fragment/rules -->", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "B <!-- include:fragment/rules -->" },
		...(failure === "cycle" ? [{ key: "fragment/rules", kind: "fragment" as const, body: "<!-- include:fragment/rules -->" }] : [])
	] });
	const input = { version: "2.0.0", key: "skill/prepare" };
	await expect(store.retrieveInstruction(input)).rejects.toThrow(failure === "missing" ? "fragment not found" : "cycle");
	expect(await store.readInstructionSource(input)).toMatchObject({ body: saved.body, source: saved.source, releaseChanges: {
		dependencies: { added: [], removed: failure === "missing" ? ["fragment/rules"] : [], changed: failure === "cycle" ? ["fragment/rules"] : [] }
	} });
	expect((await store.retrieveInstruction({ ...input, version: "1.0.0" })).body).toBe("Personal A rules");
});

it("rejects invalid previews without source changes or fragment history entries", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [{ key: input.key, kind: "skill", body: "Saved" }] });
	await store.createInstructionFragment({ version: input.version, key: "fragment/personal", body: "Personal" });
	const before = await store.listInstructionSources(input);
	for (const changes of [
		[],
		[{ key: "skill/missing", body: "Missing" }],
		[{ key: input.key, body: "First" }, { key: input.key, body: "Duplicate" }],
		[{ key: input.key, body: "Partial <!-- include:fragment/missing -->" }],
		[{ key: input.key, body: "<!-- include:skill/prepare -->" }],
		[{ key: "fragment/personal", body: "<!-- include:fragment/personal -->" }],
		[{ key: input.key, body: null as unknown as string }]
	]) {
		await expect(store.previewInstruction({ ...input, changes })).rejects.toThrow();
		expect(await store.listInstructionSources(input)).toEqual(before);
	}
	const changes = [{ key: "fragment/personal", body: "Unsaved" }];
	await store.previewInstruction({ ...input, key: "fragment/personal", changes });
	await expect(store.previewInstruction({ ...input, version: "missing", changes })).rejects.toThrow("defaults unavailable");
	await store.removeInstructionFragment({ version: input.version, key: "fragment/personal", expectedRevision: 1 });
	expect((await store.createInstructionFragment({ version: input.version, key: "fragment/personal", body: "Recreated" })).source.revision).toBe(3);
	await store.close();
	await expect(store.previewInstruction({ ...input, changes })).rejects.toThrow();
});

it("rejects invalid instruction batches without changing sources or fragment history", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	await store.importInstructionBundle({ version, items: [
		{ key: "skill/prepare", kind: "skill", body: "Prepare" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules" }
	] });
	await store.createInstructionFragment({ version, key: "fragment/personal", body: "Personal" });
	const before = await store.listInstructionSources({ version });
	const removal = { operation: "remove" as const, key: "fragment/personal", expectedRevision: 1 };
	for (const changes of [
		[removal, { operation: "save" as const, key: "skill/prepare", body: "Changed", expectedRevision: 2 }],
		[{ operation: "save" as const, key: "skill/prepare", body: "Changed", expectedRevision: 1 }, { ...removal, expectedRevision: 2 }],
		[removal, { operation: "save" as const, key: "fragment/rules", body: "<!-- include:fragment/rules -->", expectedRevision: 1 }],
		[removal, { operation: "save" as const, key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 1 }],
		[removal, { ...removal }],
		[{ operation: "save" as const, key: "skill/prepare", body: "Changed", expectedRevision: 1 }, { operation: "remove" as const, key: "fragment/rules", expectedRevision: 1 }],
		[]
	]) {
		await expect(store.commitInstructionChanges({ version, changes })).rejects.toThrow();
		expect(await store.listInstructionSources({ version })).toEqual(before);
	}
	await store.removeInstructionFragment({ version, key: "fragment/personal", expectedRevision: 1 });
	expect((await store.createInstructionFragment({ version, key: "fragment/personal", body: "Recreated" })).source.revision).toBe(3);
});

it("validates saved references outside the requested release during a batch removal", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] });
	await store.createInstructionFragment({ version: "1.0.0", key: "fragment/personal", body: "Personal" });
	await store.saveInstructionSource({ version: "1.0.0", key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 1 });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: "skill/new", kind: "skill", body: "New" }] });
	await expect(store.commitInstructionChanges({ version: "2.0.0", changes: [
		{ operation: "save", key: "skill/new", body: "Changed", expectedRevision: 1 },
		{ operation: "remove", key: "fragment/personal", expectedRevision: 1 }
	] })).rejects.toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
	expect((await store.readInstructionSource({ version: "2.0.0", key: "skill/new" })).source.type).toBe("default");
	expect((await store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).body).toBe("Personal");
});

it("creates a personal fragment that can be saved, retrieved, and removed", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	await store.importInstructionBundle({ version, items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] });
	const input = { version, key: "fragment/personal" };
	const created = await store.createInstructionFragment({ ...input, body: "Personal" });
	expect(created).toMatchObject({ ...input, kind: "fragment", body: "Personal", source: { type: "personal", revision: 1 } });
	await store.close();
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	expect(await store.readInstructionSource(input)).toEqual(created);
	const saved = await store.saveInstructionSource({ ...input, body: "Changed", expectedRevision: 1 });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Changed", source: saved.source });
	await store.removeInstructionFragment({ ...input, expectedRevision: saved.source.revision });
	await expect(store.readInstructionSource(input)).rejects.toThrow("Instruction not found");
	expect((await store.listInstructionSources({ version })).items.map((item) => item.key)).toEqual(["skill/prepare"]);
});

it("rejects invalid fragment creation and protects referenced or newer fragment revisions", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	await store.importInstructionBundle({ version, items: [
		{ key: "skill/prepare", kind: "skill", body: "Prepare" },
		{ key: "fragment/default", kind: "fragment", body: "Default" }
	] });
	for (const key of ["skill/new", "fragment/", "fragment/Bad"]) {
		await expect(store.createInstructionFragment({ version, key, body: "Invalid" })).rejects.toMatchObject({ reason: "invalid-source" });
	}
	await expect(store.createInstructionFragment({ version, key: "fragment/invalid", body: "<!-- include:fragment/missing -->" })).rejects.toMatchObject({ reason: "invalid-source" });
	await expect(store.createInstructionFragment({ version, key: "fragment/cycle", body: "<!-- include:fragment/cycle -->" })).rejects.toMatchObject({ reason: "invalid-source" });
	const input = { version, key: "fragment/personal" };
	const created = await store.createInstructionFragment({ ...input, body: "Personal" });
	await expect(store.createInstructionFragment({ ...input, body: "Duplicate" })).rejects.toMatchObject({ reason: "already-exists", currentSource: created });
	await expect(store.removeInstructionFragment({ version, key: "fragment/default", expectedRevision: 1 })).rejects.toMatchObject({ reason: "not-personal" });
	await store.saveInstructionSource({ version, key: "skill/prepare", expectedRevision: 1, body: "<!-- include:fragment/personal -->" });
	await expect(store.removeInstructionFragment({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"], currentSource: created });
	expect((await store.retrieveInstruction({ version, key: "skill/prepare" })).body).toBe("Personal");
	await store.saveInstructionSource({ version, key: "skill/prepare", expectedRevision: 2, body: "Prepare" });
	const saved = await store.saveInstructionSource({ ...input, expectedRevision: 1, body: "Newer" });
	await expect(store.removeInstructionFragment({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: saved });
	expect(await store.readInstructionSource(input)).toEqual(saved);
	await store.removeInstructionFragment({ ...input, expectedRevision: 2 });
	const recreated = await store.createInstructionFragment({ ...input, body: "Recreated" });
	expect(recreated.source.revision).toBe(4);
	await expect(store.removeInstructionFragment({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: recreated });
});

it("protects saved references when a newer release omits the referring item", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] });
	await store.createInstructionFragment({ version: "1.0.0", key: "fragment/personal", body: "Personal" });
	await store.saveInstructionSource({ version: "1.0.0", key: "skill/prepare", expectedRevision: 1, body: "<!-- include:fragment/personal -->" });
	await store.importInstructionBundle({ version: "2.0.0", items: [{ key: "skill/new", kind: "skill", body: "New" }] });
	await expect(store.removeInstructionFragment({ version: "2.0.0", key: "fragment/personal", expectedRevision: 1 })).rejects.toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
	expect((await store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).body).toBe("Personal");
});

it("reads source Markdown and activates a saved override on the next retrieval", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const input = { version: "1.0.0", key: "skill/prepare" };
	await store.importInstructionBundle({ version: input.version, items: [
		{ key: input.key, kind: "skill", body: "Default <!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules" }
	] });
	const loaded = await store.retrieveInstruction(input);
	const source = await store.readInstructionSource(input);
	expect(source.body).toBe("Default <!-- include:fragment/rules -->");
	const saved = await store.saveInstructionSource({ ...input, body: "Personal <!-- include:fragment/rules -->", expectedRevision: source.source.revision });
	expect(saved).toMatchObject({ body: "Personal <!-- include:fragment/rules -->", source: { type: "override", revision: 2, defaultVersion: input.version } });
	expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Personal Rules", source: saved.source });
	expect(loaded.body).toBe("Default Rules");
});

it("lists each item category and rejects stale or invalid saves without changing source", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const version = "1.0.0";
	await store.importInstructionBundle({ version, items: [
		{ key: "agent/agent-issues", kind: "agent", body: "Agent" },
		{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules" }
	] });
	const catalog = await store.listInstructionSources({ version });
	expect(catalog.items.map((item) => item.kind).sort()).toEqual(["agent", "fragment", "skill"]);
	for (const item of catalog.items) {
		const input = { version, key: item.key };
		const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
		await expect(store.saveInstructionSource({ ...input, body: "Stale", expectedRevision: 1 })).rejects.toMatchObject({ message: expect.stringContaining("revision conflict"), reason: "revision-conflict", currentSource: saved });
		for (const body of ["<!-- include:fragment/missing -->", "<!-- include:skill/prepare -->", "<!-- include:fragment/rules -->"]) {
			if (body.includes("fragment/rules") && item.kind !== "fragment") continue;
			await expect(store.saveInstructionSource({ ...input, body, expectedRevision: 2 })).rejects.toMatchObject({ reason: "invalid-source", currentSource: saved });
		}
		expect(await store.readInstructionSource(input)).toEqual(saved);
	}
	await expect(store.saveInstructionSource({ version, key: "skill/new", body: "New", expectedRevision: 1 })).rejects.toThrow("Instruction not found");
	await expect(store.listInstructionSources({ version: "missing" })).rejects.toThrow("defaults unavailable");
	await store.close();
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	expect((await store.listInstructionSources({ version })).items.every((item) => item.source.type === "override")).toBe(true);
	await store.importInstructionBundle({ version, items: [
		{ key: "agent/agent-issues", kind: "agent", body: "Agent" },
		{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules" }
	] });
});

afterEach(async () => {
	await store?.close();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

it("persists a release bundle and retrieves complete Markdown after repeat import and reopen", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	const dbPath = path.join(directory, "test.db");
	({ store } = await openSqliteStore(dbPath));
	const bundle = {
		version: "1.2.3",
		items: [{ key: "skill/prepare", kind: "skill" as const, body: "# Prepare\n\nRead the complete initiative.\n" }]
	};
	await store.importInstructionBundle(bundle);
	await store.importInstructionBundle(bundle);
	await store.close();
	({ store } = await openSqliteStore(dbPath));
	expect(await store.retrieveInstruction({ version: "1.2.3", key: "skill/prepare" })).toMatchObject({
		key: "skill/prepare",
		kind: "skill",
		body: bundle.items[0].body,
		version: "1.2.3",
		source: { type: "default", revision: 1 }
	});
});

it("rejects changed or invalid bundles without changing stored defaults", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const item = { key: "agent/agent-issues", kind: "agent" as const, body: "# Agent\n" };
	await store.importInstructionBundle({ version: "1.0.0", items: [item] });
	await expect(store.importInstructionBundle({ version: "1.0.0", items: [{ ...item, body: "Changed" }] })).rejects.toThrow("immutable");
	await expect(store.importInstructionBundle({ version: "2.0.0", items: [item, item] })).rejects.toThrow();
	await expect(store.retrieveInstruction({ version: "2.0.0", key: item.key })).rejects.toThrow("defaults unavailable");
	await expect(store.importInstructionBundle({ version: "3.0.0", items: [{ ...item, key: "" }] })).rejects.toThrow("Invalid instruction");
	expect(await store.retrieveInstruction({ version: "1.0.0", key: item.key })).toMatchObject({ body: item.body });
});

it("assembles nested and repeated fragments in text order with snapshot metadata", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "Start\n<!-- include:fragment/rules -->\nAgain <!-- include:fragment/end -->\n" },
		{ key: "fragment/rules", kind: "fragment", body: "Rules <!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "End" }
	] });
	const result = await store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" });
	expect(result).toMatchObject({
		body: "Start\nRules End\nAgain End\n",
		source: { type: "default", revision: 1 },
		fragments: [
			{ key: "fragment/rules", source: { type: "default", revision: 1 } },
			{ key: "fragment/end", source: { type: "default", revision: 1 } }
		]
	});
	await store.importInstructionBundle({ version: "2.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: "New release" }
	] });
	expect(await store.retrieveInstruction({ version: "2.0.0", key: "skill/prepare" })).toMatchObject({ body: "New release", version: "2.0.0" });
	expect(result.body).toBe("Start\nRules End\nAgain End\n");
});

it.each([
	{ target: "skill/other", fragmentBody: "End", error: "must target a fragment" },
	{ target: "agent/other", fragmentBody: "End", error: "must target a fragment" },
	{ target: "fragment/rules", fragmentBody: "<!-- include:fragment/end -->", error: "cycle" },
	{ target: "fragment/rules", fragmentBody: "<!-- include:fragment/missing -->", error: "fragment not found" }
])("rejects invalid include graphs without returning partial instructions ($target, $error)", async ({ target, fragmentBody, error }) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: `Prefix <!-- include:${target} --> suffix` },
		{ key: "skill/other", kind: "skill", body: "Other skill" },
		{ key: "agent/other", kind: "agent", body: "Other agent" },
		{ key: "fragment/rules", kind: "fragment", body: "<!-- include:fragment/end -->" },
		{ key: "fragment/end", kind: "fragment", body: fragmentBody }
	] });
	await expect(store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).rejects.toThrow(error);
});

it("validates the complete dependency graph before returning a requested instruction", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "Prepare" },
		{ key: "fragment/first", kind: "fragment", body: "<!-- include:fragment/second -->" },
		{ key: "fragment/second", kind: "fragment", body: "Second" },
		{ key: "fragment/unused", kind: "fragment", body: "<!-- include:fragment/unused -->" }
	] });
	await expect(store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).rejects.toThrow("cycle");
});

it("returns deeply nested instructions without stack overflow or truncation", async () => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-"));
	({ store } = await openSqliteStore(path.join(directory, "test.db")));
	const depth = 8000;
	await store.importInstructionBundle({ version: "1.0.0", items: [
		{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/0 -->" },
		...Array.from({ length: depth }, (_, index) => ({
			key: `fragment/${index}`, kind: "fragment" as const,
			body: index === depth - 1 ? "Complete" : `<!-- include:fragment/${index + 1} -->`
		}))
	] });
	const result = await store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" });
	expect(result.body).toBe("Complete");
	expect(result.fragments).toHaveLength(depth);
});

it.each([false, true])("upgrades an existing database and preserves tracker data (legacy checkpoint: %s)", async (legacyCheckpoint) => {
	directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instructions-upgrade-"));
	const dbPath = path.join(directory, "test.db");
	if (legacyCheckpoint) copyFileSync(fileURLToPath(new URL("../../migrations/__fixtures__/schema-v7.db", import.meta.url)), dbPath);
	const previous = createSqliteExecutor(dbPath);
	previous.tenantId = "fixture";
	if (legacyCheckpoint) await transformLegacySqliteV7(previous);
	await runMigrations(previous, migrations.slice(0, migrations.findIndex((migration) => migration.id === "instruction-history")));
	await new SqliteStore(previous).importInstructionBundle({ version: "1.0.0", items: [{ key: "skill/prepare", kind: "skill", body: "Prepare." }] });
	const contentHash = createHash("sha256").update("Existing source").digest("hex");
	previous.drizzle.run(sql`INSERT INTO instruction_overrides (item_key, kind, body, revision, content_hash, default_version)
		VALUES ('skill/prepare', 'skill', 'Existing source', 4, ${contentHash}, '1.0.0')`);
	previous.close();
	({ store } = await openSqliteStore(dbPath));
	expect(await store.readInstructionRevision({ version: "1.0.0", key: "skill/prepare", revision: 4 })).toMatchObject({
		body: "Existing source", source: { type: "override", revision: 4, contentHash, defaultVersion: "1.0.0" }
	});
	const entity = await store.createEntity({ kind: "initiative", title: "Existing work" });
	await store.importInstructionBundle({ version: "1.0.0", items: [{ key: "skill/prepare", kind: "skill", body: "Prepare." }] });
	await store.close();
	({ store } = await openSqliteStore(dbPath));
	expect((await store.getEntityDetails(entity.reference)).entity.title).toBe("Existing work");
	expect(await store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).toMatchObject({ body: "Existing source" });
});