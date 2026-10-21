import { createHash, randomUUID } from "node:crypto";
import { HttpStore, LocalAuthProvider, type StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, installInstructionBundle, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { createApiServer, type ApiServerHandle } from "./index.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

/**
 * `HttpStore` is proven the same way `PgStore` is (ISS46): the shared
 * `runStorageDriverContractSuite` behavioral contract, run here against a
 * real running JSON-RPC gate (`createApiServer`) backed by real Postgres -
 * not a mocked HTTP layer. This is the tracer bullet ISS40's remaining
 * slices (backend selection, CLI seam, site server) build on.
 */
describe("HttpStore over a real JSON-RPC gate", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let authProvider: LocalAuthProvider;
	let handle: ApiServerHandle;

	it("inspects and atomically resets the complete owner set over RPC and PostgreSQL", async () => {
		const tenantId = createTestTenantId();
		const otherTenant = createTestTenantId();
		const versions = [`reset-all-${randomUUID()}`, `reset-all-next-${randomUUID()}`, `reset-all-personal-${randomUUID()}`];
		const items = [
			{ key: "skill/prepare", kind: "skill" as const, body: "Default <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" },
			{ key: "fragment/shared-key", kind: "fragment" as const, body: "Shared default" },
			{ key: "skill/retired", kind: "skill" as const, body: "Retired default" }
		];
		await installInstructionBundle(adminPool, { version: versions[0], items });
		await installInstructionBundle(adminPool, { version: versions[1], items: [...items.filter((item) => !["skill/retired", "fragment/shared-key"].includes(item.key)).map((item) => ({ ...item, body: `New ${item.body}` })), { key: "fragment/private", kind: "fragment", body: "Official private" }] });
		await installInstructionBundle(adminPool, { version: versions[2], items: items.filter((item) => item.key !== "fragment/shared-key") });
		const input = { version: versions[0], key: "skill/prepare" };
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		const others = [new PgStore(appPool, tenantId, "other-project", { tenantId, userId: "bob" }), new PgStore(appPool, otherTenant, "other-project", { tenantId: otherTenant, userId: "alice" })];
		try {
			for (const other of others) {
				await other.createInstructionFragment({ ...input, key: "fragment/private", body: "Other private" });
				await other.saveInstructionSource({ ...input, body: "Other override", expectedRevision: 1 });
			}
			await store.createInstructionFragment({ ...input, key: "fragment/private", body: "Private" });
			await store.saveInstructionSource({ ...input, key: "fragment/rules", body: "<!-- include:fragment/private -->", expectedRevision: 1 });
			await store.saveInstructionSource({ ...input, key: "skill/retired", body: "Retained", expectedRevision: 1 });
			await store.saveInstructionSource({ ...input, key: "fragment/shared-key", body: "Shared override", expectedRevision: 1 });
			const next = { version: versions[1] };
			await store.createInstructionFragment({ version: versions[2], key: "fragment/shared-key", body: "Shared personal" });
			const proposal = await store.inspectInstructionResetAll(next);
			expect(proposal).toMatchObject({ overrides: [
				{ currentSource: { key: "fragment/rules" }, proposedSource: { body: "New Rules" } },
				{ currentSource: { key: "fragment/shared-key" }, proposedSource: null },
				{ currentSource: { key: "skill/retired" }, proposedSource: null }
			], personalFragments: [{ key: "fragment/private" }, { key: "fragment/shared-key" }], affectedInstructions: ["skill/prepare", "skill/retired"] });
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.inspectInstructionResetAll(next)).toEqual(proposal);
			const before = await store.inspectInstructionResetAll(next);
			await expect(store.resetInstructionAll({ ...next, expectedRevisions: [] })).rejects.toMatchObject({ reason: "revision-conflict", currentInspection: proposal });
			expect(await store.inspectInstructionResetAll(next)).toEqual(before);
			await store.resetInstructionAll({ ...next, expectedRevisions: proposal.expectedRevisions });
			expect(await direct.retrieveInstruction({ ...next, key: input.key })).toMatchObject({ body: "New Default New Rules", source: { type: "default" } });
			expect(await direct.retrieveInstruction({ ...next, key: "fragment/private" })).toMatchObject({ body: "Official private", source: { type: "default" } });
			expect(await direct.readInstructionSource({ ...input, key: "skill/retired" })).toMatchObject({ body: "Retired default", source: { type: "default", revision: 3 } });
			expect(await direct.readInstructionSource({ ...input, key: "fragment/shared-key" })).toMatchObject({ body: "Shared default", source: { type: "default", revision: 3 } });
			for (const other of others) {
				expect(await other.readInstructionSource(input)).toMatchObject({ body: "Other override", source: { type: "override", revision: 2 } });
				expect(await other.readInstructionSource({ ...input, key: "fragment/private" })).toMatchObject({ body: "Other private" });
			}
			expect(await store.inspectInstructionResetAll(next)).toMatchObject({ overrides: [], personalFragments: [], expectedRevisions: [] });
			await store.resetInstructionAll({ ...next, expectedRevisions: [] });
			await installInstructionBundle(adminPool, { version: versions[0], items });
		} finally {
			await store.close();
			for (const table of ["instruction_personal_fragments", "instruction_history", "instruction_overrides"]) await adminPool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::text[])`, [[tenantId, otherTenant]]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [versions]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [versions]);
		}
	});

	it.each(["missing", "cycle"] as const)("rejects Reset All with a %s cloud default dependency without partial changes", async (failure) => {
		const tenantId = createTestTenantId();
		const versions = [`reset-all-invalid-${randomUUID()}`, `reset-all-invalid-next-${randomUUID()}`];
		const input = { version: versions[0], key: "fragment/rules" };
		await installInstructionBundle(adminPool, { version: input.version, items: [{ key: input.key, kind: "fragment", body: "Default" }] });
		await installInstructionBundle(adminPool, { version: versions[1], items: [{ key: input.key, kind: "fragment", body: `<!-- include:fragment/${failure === "missing" ? "missing" : "rules"} -->` }] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
			await store.createInstructionFragment({ ...input, key: "fragment/personal", body: "Private" });
			const proposal = await store.inspectInstructionResetAll(input);
			const next = { ...input, version: versions[1] };
			const before = await store.listInstructionSources(next);
			const history = await store.listInstructionHistory(next);
			await expect(store.resetInstructionAll({ version: next.version, expectedRevisions: proposal.expectedRevisions })).rejects.toMatchObject({ reason: "invalid-source" });
			await expect(store.inspectInstructionResetAll(next)).rejects.toMatchObject({ reason: "invalid-source" });
			expect(await store.listInstructionSources(next)).toEqual(before);
			expect(await store.listInstructionHistory(next)).toEqual(history);
		} finally {
			await store.close();
			for (const table of ["instruction_personal_fragments", "instruction_history", "instruction_overrides"]) await adminPool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [versions]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [versions]);
		}
	});

	it("inspects owner-scoped dependencies and impact over RPC and PostgreSQL", async () => {
		const tenantId = createTestTenantId();
		const versions = [`dependencies-${randomUUID()}`, `dependencies-next-${randomUUID()}`];
		const input = { version: versions[0], key: "skill/prepare" };
		const items = [
			{ key: input.key, kind: "skill" as const, body: "<!-- include:fragment/rules -->" },
			{ key: "agent/issues", kind: "agent" as const, body: "<!-- include:fragment/end -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "<!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment" as const, body: "End" }
		];
		await installInstructionBundle(adminPool, { version: input.version, items });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const personal = await store.createInstructionFragment({ ...input, key: "fragment/private", body: "Private" });
			const saved = await store.saveInstructionSource({ ...input, key: "fragment/rules", body: "<!-- include:fragment/private --> <!-- include:fragment/end -->", expectedRevision: 1 });
			const before = await store.listInstructionSources(input);
			const history = await store.listInstructionHistory({ ...input, key: saved.key });
			const inspection = await store.inspectInstructionDependencies(input);
			expect(inspection).toMatchObject({ ...input, dependencies: [
				{ key: "fragment/end", direct: false, source: { type: "default" } },
				{ key: personal.key, direct: false, source: personal.source },
				{ key: saved.key, direct: true, source: saved.source }
			], affectedInstructions: [], modifiedFragments: [personal.key, saved.key] });
			expect(await store.inspectInstructionDependencies({ ...input, key: "fragment/end" })).toMatchObject({ affectedInstructions: ["agent/issues", input.key] });
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.inspectInstructionDependencies(input)).toEqual(inspection);
			for (const owner of [{ tenantId, userId: "bob" }, { tenantId: createTestTenantId(), userId: "alice" }]) {
				const token = await authProvider.issueToken(owner);
				const other = new HttpStore({ baseUrl: handle.url, tenantId: owner.tenantId, bearerToken: token });
				try {
					expect(await other.inspectInstructionDependencies(input)).toMatchObject({ dependencies: [
						{ key: "fragment/end", source: { type: "default" } }, { key: "fragment/rules", source: { type: "default" } }
					], modifiedFragments: [] });
					await expect(other.inspectInstructionDependencies({ ...input, key: personal.key })).rejects.toThrow("Instruction not found");
				} finally { await other.close(); }
			}
			await installInstructionBundle(adminPool, { version: versions[1], items: items.filter((item) => item.key !== "fragment/end").map((item) => item.key === saved.key ? { ...item, body: "New rules" } : item) });
			expect(await store.inspectInstructionDependencies({ ...input, version: versions[1] })).toMatchObject({ dependencies: [
				{ key: "fragment/end", source: null, reason: "missing" },
				{ key: personal.key, source: personal.source }, { key: saved.key, source: saved.source }
			] });
			await expect(store.inspectInstructionDependencies({ ...input, version: "missing" })).rejects.toThrow("defaults unavailable");
			expect(await store.listInstructionSources(input)).toEqual(before);
			expect(await store.listInstructionHistory({ ...input, key: saved.key })).toEqual(history);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [versions]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [versions]);
		}
	});

	it("compares release defaults over RPC and PostgreSQL without changing owner content", async () => {
		const tenantId = createTestTenantId();
		const suffix = randomUUID();
		const versions = [`1.0.0-${suffix}`, `2.0.0-${suffix}`, `3.0.0-${suffix}`];
		const key = `skill/compare-${suffix}`;
		for (const version of versions) {
			await installInstructionBundle(adminPool, { version, items: [{ key, kind: "skill", body: `Default ${version}` }] });
		}
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const original = { version: versions[0], key };
			expect(await store.compareInstructionSource(original)).toMatchObject({ different: false, newerDefaultVersions: versions.slice(1) });
			const saved = await store.saveInstructionSource({ ...original, body: "Personal", expectedRevision: 1 });
			const input = { version: versions[1], key };
			const before = await store.readInstructionSource(input);
			const history = await store.listInstructionHistory(input);
			const comparison = await store.compareInstructionSource(input);
			expect(comparison).toMatchObject({
				...input, currentSource: before, different: true, newerDefaultVersions: [versions[2]],
				defaultSource: { version: input.version, body: `Default ${input.version}`, source: { type: "default", revision: 1 } }
			});
			expect(comparison.currentSource.source).toEqual(saved.source);
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.compareInstructionSource(input)).toEqual(comparison);
			for (const owner of [{ tenantId, userId: "bob" }, { tenantId: createTestTenantId(), userId: "alice" }]) {
				const token = await authProvider.issueToken(owner);
				const other = new HttpStore({ baseUrl: handle.url, tenantId: owner.tenantId, bearerToken: token });
				try {
					expect(await other.compareInstructionSource(input)).toMatchObject({ different: false, currentSource: { body: `Default ${input.version}`, source: { type: "default" } } });
				} finally {
					await other.close();
				}
			}
			const personal = await store.createInstructionFragment({ version: input.version, key: "fragment/personal", body: "Personal fragment" });
			expect(await store.compareInstructionSource({ version: input.version, key: personal.key })).toMatchObject({ currentSource: personal, defaultSource: null, different: null, newerDefaultVersions: [] });
			await expect(store.compareInstructionSource({ ...input, version: "missing" })).rejects.toThrow("defaults unavailable");
			await expect(store.compareInstructionSource({ ...input, key: "skill/missing" })).rejects.toThrow("Instruction not found");
			expect(await store.readInstructionSource(input)).toEqual(before);
			expect(await store.listInstructionHistory(input)).toEqual(history);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [versions]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [versions]);
		}
	});

	it("resets one owner source over RPC without resetting fragments or other owners", async () => {
		const tenantId = createTestTenantId();
		const version = `instruction-reset-${randomUUID()}`;
		const input = { version, key: "skill/prepare" };
		const bundle = { version, items: [
			{ key: input.key, kind: "skill" as const, body: "Default <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" }
		] };
		await installInstructionBundle(adminPool, bundle);
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const fragment = await store.saveInstructionSource({ ...input, key: "fragment/rules", body: "Personal rules", expectedRevision: 1 });
			const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
			const inspection = await store.inspectInstructionReset(input);
			expect(inspection).toMatchObject({ currentSource: saved, proposedSource: { body: bundle.items[0].body }, affectedInstructions: [input.key], modifiedFragments: ["fragment/rules"] });
			expect(await store.readInstructionSource(input)).toEqual(saved);
			await expect(store.resetInstructionSource({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: saved });
			const reset = await store.resetInstructionSource({ ...input, expectedRevision: saved.source.revision });
			expect(reset).toMatchObject({ body: bundle.items[0].body, source: { type: "default", revision: 3 } });
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.retrieveInstruction(input)).toMatchObject({ body: "Default Personal rules", source: reset.source });
			expect(await direct.readInstructionSource({ ...input, key: "fragment/rules" })).toEqual(fragment);
			expect((await store.listInstructionHistory(input)).revisions).toEqual([reset, saved]);
			for (const owner of [{ tenantId, userId: "bob" }, { tenantId: createTestTenantId(), userId: "alice" }]) {
				const token = await authProvider.issueToken(owner);
				const other = new HttpStore({ baseUrl: handle.url, tenantId: owner.tenantId, bearerToken: token });
				try {
					expect(await other.inspectInstructionReset(input)).toMatchObject({ currentSource: { source: { type: "default", revision: 1 } }, modifiedFragments: [] });
					await other.resetInstructionSource({ ...input, expectedRevision: 1 });
					expect(await store.readInstructionSource(input)).toEqual(reset);
				} finally {
					await other.close();
					await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1 AND user_id = $2", [owner.tenantId, owner.userId]);
				}
			}
			await installInstructionBundle(adminPool, bundle);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it.each(["missing", "cycle"] as const)("rejects a %s cloud reset without changing owner source or history", async (failure) => {
		const tenantId = createTestTenantId();
		const version = `instruction-reset-invalid-${randomUUID()}`;
		const nextVersion = `${version}-next`;
		const input = { version, key: "fragment/rules" };
		await installInstructionBundle(adminPool, { version, items: [{ key: input.key, kind: "fragment", body: "Default" }] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
			await installInstructionBundle(adminPool, { version: nextVersion, items: [{ key: input.key, kind: "fragment", body: `<!-- include:fragment/${failure === "missing" ? "missing" : "rules"} -->` }] });
			const next = { ...input, version: nextVersion };
			const before = await store.readInstructionSource(next);
			const history = await store.listInstructionHistory(next);
			await expect(store.resetInstructionSource({ ...next, expectedRevision: saved.source.revision })).rejects.toMatchObject({ reason: "invalid-source", currentSource: { body: saved.body, source: saved.source } });
			await expect(store.inspectInstructionReset(next)).rejects.toThrow();
			expect(await store.readInstructionSource(next)).toEqual(before);
			expect(await store.listInstructionHistory(next)).toEqual(history);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [[version, nextVersion]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [[version, nextVersion]]);
		}
	});

	it("reads owner history and restores a revision over RPC with conflict and graph protection", async () => {
		const tenantId = createTestTenantId();
		const version = `instruction-history-${randomUUID()}`;
		const input = { version, key: "skill/prepare" };
		await installInstructionBundle(adminPool, { version, items: [{ key: input.key, kind: "skill", body: "Default" }] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const personalInput = { version, key: "fragment/personal" };
			const created = await store.createInstructionFragment({ ...personalInput, body: "Personal" });
			const edited = await store.saveInstructionSource({ ...personalInput, body: "Edited", expectedRevision: created.source.revision });
			const personalRestored = await store.restoreInstructionRevision({ ...personalInput, revision: created.source.revision, expectedRevision: edited.source.revision });
			expect(personalRestored).toMatchObject({ body: "Personal", source: { type: "personal", revision: 3 } });
			expect(await store.listInstructionHistory(personalInput)).toEqual({ ...personalInput, revisions: [personalRestored, edited, created] });
			const first = await store.saveInstructionSource({ ...input, body: "First <!-- include:fragment/personal -->", expectedRevision: 1 });
			const second = await store.saveInstructionSource({ ...input, body: "Second", expectedRevision: first.source.revision });
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await store.listInstructionHistory(input)).toEqual({ ...input, revisions: [second, first] });
			expect(await direct.readInstructionRevision({ ...input, revision: first.source.revision })).toEqual(first);
			expect(await store.readInstructionRevision({ ...input, revision: first.source.revision })).toEqual(first);
			for (const owner of [{ tenantId, userId: "bob" }, { tenantId: createTestTenantId(), userId: "alice" }]) {
				const token = await authProvider.issueToken(owner);
				const other = new HttpStore({ baseUrl: handle.url, tenantId: owner.tenantId, bearerToken: token });
				try {
					expect(await other.listInstructionHistory(input)).toEqual({ ...input, revisions: [] });
					await expect(other.readInstructionRevision({ ...input, revision: first.source.revision })).rejects.toThrow("revision not found");
					await expect(other.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: 1 })).rejects.toThrow("revision not found");
				} finally {
					await other.close();
				}
			}
			await expect(store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: second });
			const restored = await store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: second.source.revision });
			expect(restored).toMatchObject({ body: first.body, source: { ...first.source, revision: second.source.revision + 1 } });
			expect(await direct.retrieveInstruction(input)).toMatchObject({ body: "First Personal", source: restored.source });
			const cleared = await store.saveInstructionSource({ ...input, body: "Cleared", expectedRevision: restored.source.revision });
			await store.removeInstructionFragment({ ...personalInput, expectedRevision: personalRestored.source.revision });
			const history = await store.listInstructionHistory(input);
			await expect(store.restoreInstructionRevision({ ...input, revision: first.source.revision, expectedRevision: cleared.source.revision })).rejects.toMatchObject({ reason: "invalid-source", currentSource: cleared });
			await expect(store.readInstructionRevision({ ...input, revision: 999 })).rejects.toThrow("revision not found");
			expect(await store.readInstructionSource(input)).toEqual(cleared);
			expect(await store.listInstructionHistory(input)).toEqual(history);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it("carries owner overrides across releases with default and dependency metadata over RPC", async () => {
		const tenantId = createTestTenantId();
		const suffix = randomUUID();
		const version = `1.0.0-${suffix}`;
		const nextVersion = `2.0.0-${suffix}`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "A" },
			{ key: "skill/unchanged", kind: "skill", body: "A unchanged" },
			{ key: "fragment/rules", kind: "fragment", body: "A rules <!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment", body: "A end" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const saved = await store.saveInstructionSource({ version, key: "skill/prepare", body: "Personal <!-- include:fragment/rules -->", expectedRevision: 1 });
			await installInstructionBundle(adminPool, { version: nextVersion, items: [
				{ key: "skill/prepare", kind: "skill", body: "B <!-- include:fragment/rules --> <!-- include:fragment/new -->" },
				{ key: "skill/unchanged", kind: "skill", body: "B unchanged" },
				{ key: "fragment/rules", kind: "fragment", body: "B rules <!-- include:fragment/end -->" },
				{ key: "fragment/end", kind: "fragment", body: "B end" },
				{ key: "fragment/new", kind: "fragment", body: "New" }
			] });
			const input = { version: nextVersion, key: "skill/prepare" };
			expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Personal B rules B end", source: saved.source });
			expect(await store.retrieveInstruction({ ...input, key: "skill/unchanged" })).toMatchObject({ body: "B unchanged", source: { type: "default" } });
			const source = await store.readInstructionSource(input);
			expect(source).toMatchObject({ body: saved.body, source: saved.source, releaseChanges: {
				defaultVersion: nextVersion, newerDefaultAvailable: true, defaultChanged: true,
				dependencies: { added: ["fragment/new"], removed: [], changed: ["fragment/end", "fragment/rules"] }
			} });
			expect((await store.listInstructionSources(input)).items.find((item) => item.key === input.key)).toEqual(expect.objectContaining({ releaseChanges: source.releaseChanges }));
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.readInstructionSource(input)).toEqual(source);
			const savedAgain = await store.saveInstructionSource({ ...input, body: "Edited under B <!-- include:fragment/rules -->", expectedRevision: saved.source.revision });
			expect(savedAgain.source).toMatchObject({ type: "override", defaultVersion: version, revision: 3 });
			expect(await direct.readInstructionSource(input)).toMatchObject({ body: savedAgain.body, source: savedAgain.source, releaseChanges: source.releaseChanges });
			const token = await authProvider.issueToken({ tenantId, userId: "bob" });
			const other = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken: token });
			try {
				expect(await other.readInstructionSource(input)).toMatchObject({ body: "B <!-- include:fragment/rules --> <!-- include:fragment/new -->", source: { type: "default" } });
			} finally {
				await other.close();
			}
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [[version, nextVersion]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [[version, nextVersion]]);
		}
	});

	it.each(["missing", "cycle"])("rejects a cloud release update with a %s dependency without falling back", async (failure) => {
		const tenantId = createTestTenantId();
		const version = `release-invalid-${randomUUID()}`;
		const nextVersion = `${version}-next`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "A <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment", body: "A rules" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const saved = await store.saveInstructionSource({ version, key: "skill/prepare", body: "Personal <!-- include:fragment/rules -->", expectedRevision: 1 });
			await installInstructionBundle(adminPool, { version: nextVersion, items: [
				{ key: "skill/prepare", kind: "skill", body: "B <!-- include:fragment/rules -->" },
				...(failure === "cycle" ? [{ key: "fragment/rules", kind: "fragment" as const, body: "<!-- include:fragment/rules -->" }] : [])
			] });
			const input = { version: nextVersion, key: "skill/prepare" };
			await expect(store.retrieveInstruction(input)).rejects.toThrow(failure === "missing" ? "fragment not found" : "cycle");
			expect(await store.readInstructionSource(input)).toMatchObject({ body: saved.body, source: saved.source, releaseChanges: {
				newerDefaultAvailable: null,
				dependencies: { added: [], removed: failure === "missing" ? ["fragment/rules"] : [], changed: failure === "cycle" ? ["fragment/rules"] : [] }
			} });
			expect((await store.retrieveInstruction({ ...input, version })).body).toBe("Personal A rules");
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1::text[])", [[version, nextVersion]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1::text[])", [[version, nextVersion]]);
		}
	});

	it("previews pending bodies over RPC from one owner snapshot without writes", async () => {
		const tenantId = createTestTenantId();
		const version = `instruction-preview-${randomUUID()}`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "Saved <!-- include:fragment/first --> <!-- include:fragment/second -->" },
			{ key: "fragment/first", kind: "fragment", body: "First" },
			{ key: "fragment/second", kind: "fragment", body: "Second" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		const input = { version, key: "skill/prepare" };
		try {
			await store.createInstructionFragment({ version, key: "fragment/personal", body: "Personal" });
			const before = await store.listInstructionSources({ version });
			const loaded = await store.retrieveInstruction(input);
			const changes = [
				{ key: input.key, body: "Pending <!-- include:fragment/first --> Again <!-- include:fragment/second -->" },
				{ key: "fragment/first", body: "New <!-- include:fragment/second -->" },
				{ key: "fragment/second", body: "End <!-- include:fragment/personal -->" },
				{ key: "fragment/personal", body: "Unsaved" }
			];
			expect(await store.previewInstruction({ ...input, changes })).toMatchObject({
				pending: true, version, pendingKeys: ["fragment/first", "fragment/personal", "fragment/second", input.key],
				body: "Pending New End Unsaved Again End Unsaved", source: loaded.source
			});
			const direct = new PgStore(appPool, tenantId, "another-project", { tenantId, userId: "alice" });
			expect(await direct.previewInstruction({ ...input, changes })).toEqual(await store.previewInstruction({ ...input, changes }));
			for (const body of ["<!-- include:fragment/missing -->", "<!-- include:skill/prepare -->", "<!-- include:fragment/first -->"]) {
				await expect(store.previewInstruction({ ...input, changes: [{ key: "fragment/first", body }] })).rejects.toThrow();
			}
			await expect(store.previewInstruction({ ...input, version: "missing", changes })).rejects.toThrow("defaults unavailable");
			const token = await authProvider.issueToken({ tenantId, userId: "bob" });
			const other = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken: token });
			try {
				await expect(other.previewInstruction({ ...input, changes })).rejects.toThrow("Instruction not found");
			} finally {
				await other.close();
			}
			expect(await store.listInstructionSources({ version })).toEqual(before);
			expect(await store.retrieveInstruction(input)).toEqual(loaded);
			await store.removeInstructionFragment({ version, key: "fragment/personal", expectedRevision: 1 });
			expect((await store.createInstructionFragment({ version, key: "fragment/personal", body: "Recreated" })).source.revision).toBe(3);
			const writing = store.commitInstructionChanges({ version, changes: [
				{ operation: "save", key: "fragment/first", body: "New first", expectedRevision: 1 },
				{ operation: "save", key: "fragment/second", body: "New second", expectedRevision: 1 }
			] });
			const previews = await Promise.all(Array.from({ length: 20 }, () => store.previewInstruction({ ...input, changes: [
				{ key: input.key, body: "Pending <!-- include:fragment/first --> <!-- include:fragment/second -->" }
			] })));
			await writing;
			for (const preview of previews) {
				expect(["Pending First Second", "Pending New first New second"]).toContain(preview.body);
				expect(preview.fragments[0].source.revision).toBe(preview.fragments[1].source.revision);
			}
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it("commits instruction batches through RPC without partial writes or retrievals", async () => {
		const tenantId = createTestTenantId();
		const version = `instruction-batch-${randomUUID()}`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "Old <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment", body: "rules" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			await store.createInstructionFragment({ version, key: "fragment/personal", body: "Personal" });
			await store.saveInstructionSource({ version, key: "skill/prepare", body: "Old <!-- include:fragment/personal -->", expectedRevision: 1 });
			const before = await store.listInstructionSources({ version });
			for (const change of [
				{ operation: "save" as const, key: "skill/prepare", body: "New", expectedRevision: 1 },
				{ operation: "save" as const, key: "skill/prepare", body: "<!-- include:fragment/missing -->", expectedRevision: 2 }
			]) {
				await expect(store.commitInstructionChanges({ version, changes: [
					{ operation: "remove", key: "fragment/personal", expectedRevision: 1 }, change
				] })).rejects.toMatchObject({ reason: change.expectedRevision === 1 ? "revision-conflict" : "invalid-source" });
				expect(await store.listInstructionSources({ version })).toEqual(before);
			}
			const token = await authProvider.issueToken({ tenantId, userId: "bob" });
			const other = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken: token });
			try {
				await expect(other.commitInstructionChanges({ version, changes: [
					{ operation: "save", key: "fragment/rules", body: "Other", expectedRevision: 1 },
					{ operation: "remove", key: "fragment/personal", expectedRevision: 1 }
				] })).rejects.toThrow("Instruction not found");
				expect((await other.readInstructionSource({ version, key: "fragment/rules" })).body).toBe("rules");
			} finally {
				await other.close();
			}
			const writing = store.commitInstructionChanges({ version, changes: [
				{ operation: "remove", key: "fragment/personal", expectedRevision: 1 },
				{ operation: "save", key: "skill/prepare", body: "New <!-- include:fragment/rules -->", expectedRevision: 2 },
				{ operation: "save", key: "fragment/rules", body: "rules changed", expectedRevision: 1 }
			] });
			const reads = await Promise.all(Array.from({ length: 20 }, () => store.retrieveInstruction({ version, key: "skill/prepare" })));
			const result = await writing;
			expect(result.changes.map((change) => change.source.source.revision)).toEqual([2, 3, 2]);
			for (const read of reads) expect(["Old Personal", "New rules changed"]).toContain(read.body);
			expect((await store.retrieveInstruction({ version, key: "skill/prepare" })).body).toBe("New rules changed");
			const direct = new PgStore(appPool, tenantId, "second", { tenantId, userId: "alice" });
			await expect(direct.readInstructionSource({ version, key: "fragment/personal" })).rejects.toThrow("Instruction not found");
			expect((await direct.createInstructionFragment({ version, key: "fragment/personal", body: "Recreated" })).source.revision).toBe(3);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it("creates and removes personal fragments with owner isolation and revision protection", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const version = `personal-fragments-${randomUUID()}`;
		const nextVersion = `${version}-next`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "Prepare" },
			{ key: "fragment/default", kind: "fragment", body: "Default" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken, projectIdentity: "first" });
		const input = { version, key: "fragment/personal" };
		try {
			const created = await store.createInstructionFragment({ ...input, body: "Personal" });
			expect(created).toMatchObject({ ...input, kind: "fragment", source: { type: "personal", revision: 1 } });
			const direct = new PgStore(appPool, tenantId, "second", { tenantId, userId: "alice" });
			expect(await direct.readInstructionSource(input)).toEqual(created);
			for (const [ownerTenant, userId] of [[tenantId, "bob"], [otherTenantId, "alice"]]) {
				const token = await authProvider.issueToken({ tenantId: ownerTenant, userId });
				const other = new HttpStore({ baseUrl: handle.url, tenantId: ownerTenant, bearerToken: token });
				await expect(other.readInstructionSource(input)).rejects.toThrow("Instruction not found");
				await expect(other.removeInstructionFragment({ ...input, expectedRevision: 1 })).rejects.toThrow("Instruction not found");
				expect(await other.createInstructionFragment({ ...input, body: "Other owner" })).toMatchObject({ body: "Other owner", source: { revision: 1 } });
				expect(await store.readInstructionSource(input)).toEqual(created);
				await other.close();
			}
			await expect(store.createInstructionFragment({ ...input, body: "Duplicate" })).rejects.toMatchObject({ reason: "already-exists", currentSource: created });
			for (const [key, body] of [["skill/new", "New"], ["fragment/missing", "<!-- include:fragment/absent -->"], ["fragment/cycle", "<!-- include:fragment/cycle -->"]]) {
				await expect(store.createInstructionFragment({ version, key, body })).rejects.toMatchObject({ reason: "invalid-source" });
			}
			await expect(store.removeInstructionFragment({ version, key: "fragment/default", expectedRevision: 1 })).rejects.toMatchObject({ reason: "not-personal" });
			await store.saveInstructionSource({ version, key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 1 });
			await expect(store.removeInstructionFragment({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"], currentSource: created });
			expect((await store.retrieveInstruction({ version, key: "skill/prepare" })).body).toBe("Personal");
			await store.saveInstructionSource({ version, key: "skill/prepare", body: "Prepare", expectedRevision: 2 });
			const saved = await store.saveInstructionSource({ ...input, body: "Newer", expectedRevision: 1 });
			await expect(store.removeInstructionFragment({ ...input, expectedRevision: 1 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: saved });
			await direct.removeInstructionFragment({ ...input, expectedRevision: 2 });
			await expect(store.readInstructionSource(input)).rejects.toThrow("Instruction not found");
			const recreated = await store.createInstructionFragment({ ...input, body: "Recreated" });
			expect(recreated.source.revision).toBe(4);
			await expect(store.removeInstructionFragment({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ reason: "revision-conflict", currentSource: recreated });
			await store.saveInstructionSource({ version, key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 3 });
			await installInstructionBundle(adminPool, { version: nextVersion, items: [{ key: "skill/new", kind: "skill", body: "New" }] });
			await expect(store.removeInstructionFragment({ ...input, version: nextVersion, expectedRevision: 4 })).rejects.toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
			expect((await store.retrieveInstruction({ version, key: "skill/prepare" })).body).toBe("Recreated");
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = ANY($1)", [[tenantId, otherTenantId]]);
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = ANY($1)", [[tenantId, otherTenantId]]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1)", [[version, nextVersion]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1)", [[version, nextVersion]]);
		}
	});

	it("validates concurrent fragment saves against the committed final graph", async () => {
		const tenantId = createTestTenantId();
		const version = `graph-writes-${randomUUID()}`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/first -->" },
			{ key: "fragment/first", kind: "fragment", body: "First" },
			{ key: "fragment/second", kind: "fragment", body: "Second" }
		] });
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		try {
			const results = await Promise.allSettled([
				store.saveInstructionSource({ version, key: "fragment/first", body: "<!-- include:fragment/second -->", expectedRevision: 1 }),
				store.saveInstructionSource({ version, key: "fragment/second", body: "<!-- include:fragment/first -->", expectedRevision: 1 })
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const failed = results.find((result) => result.status === "rejected");
			expect(failed).toMatchObject({ status: "rejected", reason: { reason: "invalid-source", message: expect.stringContaining("cycle"), currentSource: { source: { revision: 1 } } } });
			expect(["First", "Second"]).toContain((await store.retrieveInstruction({ version, key: "skill/prepare" })).body);
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
		handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider,
			pool: appPool,
			port: 4492
		});
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
	});

	afterAll(async () => {
		handle.server.close();
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	async function openHttpTestStore(): Promise<StorageDriver> {
		const tenantId = createTestTenantId();
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const aliceToken = await authProvider.issueToken({ userId: "entra:alice", tenantId, displayName: "Alice" });
		const bobToken = await authProvider.issueToken({ userId: "entra:bob", tenantId, displayName: "Bob" });
		const commentAuthorToken = await authProvider.issueToken({ userId: "entra:comment-author", tenantId, displayName: "Comment Author" });
		return new HttpStore({
			baseUrl: handle.url,
			bearerToken,
			tenantId,
			identityBearerToken: (identity) => ({ "entra:alice": aliceToken, "entra:bob": bobToken, "entra:comment-author": commentAuthorToken }[identity.userId])
		});
	}

	// Every identity-scoped store shares one tenant, so the contract can assert
	// that two identities stay separate inside it rather than trivially passing
	// because they were in different tenants all along.
	let contractTenantId: string | undefined;
	async function openHttpTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
		contractTenantId ??= createTestTenantId();
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: contractTenantId });
		const aliceToken = await authProvider.issueToken({ userId: "entra:alice", tenantId: contractTenantId, displayName: "Alice" });
		const bobToken = await authProvider.issueToken({ userId: "entra:bob", tenantId: contractTenantId, displayName: "Bob" });
		const commentAuthorToken = await authProvider.issueToken({ userId: "entra:comment-author", tenantId: contractTenantId, displayName: "Comment Author" });
		return new HttpStore({
			baseUrl: handle.url,
			bearerToken,
			tenantId: contractTenantId,
			projectIdentity,
			identityBearerToken: (identity) => ({ "entra:alice": aliceToken, "entra:bob": bobToken, "entra:comment-author": commentAuthorToken }[identity.userId])
		});
	}

	beforeEach(() => {
		contractTenantId = undefined;
	});

	runStorageDriverContractSuite({
		label: "HttpStore (JSON-RPC gate over Postgres)",
		openStore: openHttpTestStore,
		openStoreForProject: openHttpTestStoreForProject
	});

	// Tenant administration is deliberately excluded from the shared contract
	// (Postgres RLS makes it structurally per-backend, see
	// storage-driver-contract.ts) so it gets its own bespoke coverage here,
	// mirroring pg-store.test.ts's "tenant administration" describe block.
	describe("tenant administration", () => {
		it("reports its own tenant summary once it has rows", async () => {
			const store = await openHttpTestStore();
			try {
				expect(await store.listTenants()).toEqual([]);

				await store.createEntity({ kind: "initiative", title: "Payments" });

				const tenants = await store.listTenants();
				expect(tenants).toHaveLength(1);
				expect(tenants[0]?.id).toBe(store.tenantId);
			} finally {
				await store.close();
			}
		});

		it("rejects deleting a different tenant, surfacing the gate's error message", async () => {
			const store = await openHttpTestStore();
			const otherTenantId = createTestTenantId();
			try {
				await expect(store.deleteTenant(otherTenantId)).rejects.toThrow(/own tenant/);
			} finally {
				await store.close();
			}
		});

		it("renames its own tenant, moving its entities to the new id", async () => {
			const store = await openHttpTestStore();
			const newTenantId = createTestTenantId();
			try {
				const previousTenantId = store.tenantId;
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

				const renamed = await store.renameTenant(previousTenantId, newTenantId);
				expect(renamed.newTenantId).toBe(newTenantId);

				const renamedToken = await authProvider.issueToken({ userId: "user-1", tenantId: newTenantId });
				const renamedStore = new HttpStore({ baseUrl: handle.url, bearerToken: renamedToken, tenantId: newTenantId });
				try {
					const details = await renamedStore.getEntityDetails(initiative.id);
					expect(details.entity.title).toBe("Payments");
				} finally {
					await renamedStore.close();
				}
			} finally {
				await store.close();
			}
		});
	});

	it("rejects an unauthenticated request with a thrown error", async () => {
		const store = new HttpStore({ baseUrl: handle.url, bearerToken: "not-a-real-token", tenantId: createTestTenantId() });

		await expect(store.listEntities("initiative")).rejects.toThrow();
	});

	it("installs immutable official releases and retrieves the requested release through PostgreSQL and HTTP", async () => {
		const key = "skill/prepare";
		const version = `instructions-${randomUUID()}`;
		const bundle = { version, items: [{ key, kind: "skill" as const, body: "# Prepare\n\nComplete release instructions.\n" }] };
		await Promise.all([installInstructionBundle(adminPool, bundle), installInstructionBundle(adminPool, bundle)]);
		await installInstructionBundle(adminPool, { ...bundle, version: `${version}-new`, items: [{ ...bundle.items[0], body: "New instructions." }] });
		await migratePgDatabase(adminPool);
		const store = await openHttpTestStore();
		try {
			expect(await store.retrieveInstruction({ version, key })).toMatchObject({
				key, kind: "skill", body: bundle.items[0].body, version,
				source: { type: "default", revision: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
			});
			const direct = new PgStore(appPool, store.tenantId).withAuthenticatedIdentity({ tenantId: store.tenantId, userId: "user-1" });
			expect(await direct.retrieveInstruction({ version, key })).toEqual(await store.retrieveInstruction({ version, key }));
			await expect(installInstructionBundle(adminPool, { ...bundle, items: [{ ...bundle.items[0], body: "Changed" }] })).rejects.toThrow("immutable");
			await expect(installInstructionBundle(adminPool, { ...bundle, version: `${version}-invalid`, items: [bundle.items[0], bundle.items[0]] })).rejects.toThrow("Invalid instruction");
			await expect(installInstructionBundle(appPool, { ...bundle, version: `${version}-client` })).rejects.toThrow();
			await expect(appPool.query("UPDATE instruction_defaults SET body = 'Changed' WHERE version = $1", [version])).rejects.toThrow("permission denied");
			expect((await store.retrieveInstruction({ version, key })).body).toBe(bundle.items[0].body);
			await expect(store.retrieveInstruction({ version: `${version}-invalid`, key })).rejects.toThrow("defaults unavailable");
			await expect(store.retrieveInstruction({ version: `${version}-client`, key })).rejects.toThrow("defaults unavailable");
			await expect(store.retrieveInstruction({ version, key: "skill/missing" })).rejects.toThrow("Instruction not found");
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1)", [[version, `${version}-new`]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1)", [[version, `${version}-new`]]);
		}
	});

	it("uses authenticated owner instructions across projects without exposing another user or tenant", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const version = `owner-${randomUUID()}`;
		const requestedVersion = `${version}-new`;
		const key = "agent/agent-issues";
		const body = "# Personal agent\n";
		const contentHash = createHash("sha256").update(body).digest("hex");
		await installInstructionBundle(adminPool, { version, items: [{ key, kind: "agent", body: "# Official agent\n" }] });
		await installInstructionBundle(adminPool, { version: requestedVersion, items: [{ key, kind: "agent", body: "# New official agent\n" }] });
		try {
			await adminPool.query(`INSERT INTO instruction_overrides (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
				VALUES ($1, $2, $3, 'agent', $4, 2, $5, $6)`, [tenantId, "alice", key, body, contentHash, version]);
			for (const [ownerTenant, userId, projectIdentity] of [
				[tenantId, "alice", "first-project"],
				[tenantId, "alice", "second-project"],
				[tenantId, "bob", "first-project"],
				[otherTenantId, "alice", "first-project"]
			]) {
				const bearerToken = await authProvider.issueToken({ tenantId: ownerTenant, userId });
				const store = new HttpStore({ baseUrl: handle.url, tenantId: ownerTenant, bearerToken, projectIdentity });
				const result = await store.retrieveInstruction({ version: requestedVersion, key });
				if (ownerTenant === tenantId && userId === "alice") {
					expect(result).toMatchObject({ body, version: requestedVersion, source: { type: "override", revision: 2, contentHash, defaultVersion: version } });
				} else {
					expect(result).toMatchObject({ body: "# New official agent\n", version: requestedVersion, source: { type: "default" } });
				}
				await store.close();
			}
			const bearerToken = await authProvider.issueToken({ tenantId, userId: "bob" });
			const forged = await fetch(`${handle.url}/rpc`, {
				method: "POST",
				headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: "forged-owner", method: "retrieveInstruction", params: { version: requestedVersion, key, tenantId, userId: "alice" } })
			});
			expect(await forged.json()).toMatchObject({ result: { body: "# New official agent\n", source: { type: "default" } } });
			const client = await appPool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.instruction_user_id', 'bob', true)", [tenantId]);
				expect((await client.query("SELECT body FROM instruction_overrides WHERE item_key = $1", [key])).rows).toEqual([]);
				await expect(client.query("UPDATE instruction_overrides SET body = 'Changed' WHERE item_key = $1 RETURNING body", [key]))
					.resolves.toMatchObject({ rows: [] });
			} finally {
				await client.query("ROLLBACK");
				client.release();
			}
		} finally {
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = ANY($1)", [[version, requestedVersion]]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = ANY($1)", [[version, requestedVersion]]);
		}
	});

	it("manages instruction sources with owner isolation and revision protection through PostgreSQL RPC", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const version = `management-${randomUUID()}`;
		const bundle = { version, items: [
			{ key: "agent/agent-issues", kind: "agent" as const, body: "Agent" },
			{ key: "skill/prepare", kind: "skill" as const, body: "<!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" }
		] };
		await installInstructionBundle(adminPool, bundle);
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken, projectIdentity: "first" });
		try {
			const catalog = await store.listInstructionSources({ version });
			expect(catalog.items.map((item) => item.kind).sort()).toEqual(["agent", "fragment", "skill"]);
			for (const item of catalog.items) {
				const input = { version, key: item.key };
				const source = await store.readInstructionSource(input);
				expect(source.body).toBe(bundle.items.find((original) => original.key === item.key)!.body);
				const loaded = await store.retrieveInstruction(input);
				const saved = await store.saveInstructionSource({ ...input, body: "Personal", expectedRevision: 1 });
				expect(saved).toMatchObject({ body: "Personal", source: { type: "override", revision: 2, defaultVersion: version } });
				await expect(store.saveInstructionSource({ ...input, body: "Stale", expectedRevision: 1 })).rejects.toMatchObject({ message: expect.stringContaining("revision conflict"), reason: "revision-conflict", currentSource: saved });
				await expect(store.saveInstructionSource({ ...input, body: "<!-- include:fragment/missing -->", expectedRevision: 2 })).rejects.toMatchObject({ message: expect.stringContaining("fragment not found"), reason: "invalid-source", currentSource: saved });
				await expect(store.saveInstructionSource({ ...input, body: "<!-- include:skill/prepare -->", expectedRevision: 2 })).rejects.toThrow("must target a fragment");
				expect(await store.readInstructionSource(input)).toEqual(saved);
				expect(await store.retrieveInstruction(input)).toMatchObject({ body: "Personal", source: saved.source });
				expect(loaded).not.toEqual(await store.retrieveInstruction(input));
			}
			const input = { version, key: "fragment/rules" };
			await expect(store.saveInstructionSource({ ...input, body: "<!-- include:fragment/rules -->", expectedRevision: 2 })).rejects.toThrow("cycle");
			const concurrent = await Promise.allSettled([
				store.saveInstructionSource({ ...input, body: "First", expectedRevision: 2 }),
				store.saveInstructionSource({ ...input, body: "Second", expectedRevision: 2 })
			]);
			expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
			const direct = new PgStore(appPool, tenantId, "second", { tenantId, userId: "alice" });
			expect(await direct.listInstructionSources({ version })).toEqual(await store.listInstructionSources({ version }));
			for (const [ownerTenant, userId] of [[tenantId, "bob"], [otherTenantId, "alice"]]) {
				const token = await authProvider.issueToken({ tenantId: ownerTenant, userId });
				const other = new HttpStore({ baseUrl: handle.url, tenantId: ownerTenant, bearerToken: token });
				expect((await other.listInstructionSources({ version })).items.every((item) => item.source.type === "default")).toBe(true);
				const response = await fetch(`${handle.url}/rpc`, {
					method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "save", method: "saveInstructionSource", params: { version, key: input.key, body: "Other", expectedRevision: 1, tenantId, userId: "alice" } })
				});
				expect(await response.json()).toMatchObject({ result: { body: "Other", source: { revision: 2 } } });
				expect((await store.readInstructionSource(input)).source.revision).toBe(3);
				await other.close();
			}
			await installInstructionBundle(adminPool, bundle);
			await expect(store.saveInstructionSource({ version, key: "skill/new", body: "New", expectedRevision: 1 })).rejects.toThrow("Instruction not found");
			await expect(store.listInstructionSources({ version: "missing" })).rejects.toThrow("defaults unavailable");
		} finally {
			await store.close();
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = ANY($1)", [[tenantId, otherTenantId]]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it("rejects instruction retrieval when storage is unavailable", async () => {
		const pool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		const tenantId = createTestTenantId();
		const store = new PgStore(pool, tenantId).withAuthenticatedIdentity({ tenantId, userId: "alice" });
		await pool.end();
		await expect(store.retrieveInstruction({ version: "1.0.0", key: "skill/prepare" })).rejects.toThrow("Cannot use a pool after calling end");
	});

	it("assembles owner-scoped nested fragments through PostgreSQL and HTTP with revision metadata", async () => {
		const tenantId = createTestTenantId();
		const version = `assembly-${randomUUID()}`;
		const items = [
			{ key: "skill/prepare", kind: "skill" as const, body: "Default <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules <!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment" as const, body: "Default end" }
		];
		await installInstructionBundle(adminPool, { version, items });
		try {
			for (const [key, kind, body, revision] of [
				["skill/prepare", "skill", "Personal <!-- include:fragment/rules --> / <!-- include:fragment/end -->", 2],
				["fragment/end", "fragment", "Personal end", 3]
			] as const) {
				await adminPool.query(`INSERT INTO instruction_overrides (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
					VALUES ($1, 'alice', $2, $3, $4, $5, $6, $7)`, [tenantId, key, kind, body, revision, createHash("sha256").update(body).digest("hex"), version]);
			}
			const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
			const http = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
			const direct = new PgStore(appPool, tenantId).withAuthenticatedIdentity({ tenantId, userId: "alice" });
			const result = await http.retrieveInstruction({ version, key: "skill/prepare" });
			expect(result).toMatchObject({
				body: "Personal Rules Personal end / Personal end",
				source: { type: "override", revision: 2, defaultVersion: version },
				fragments: [
					{ key: "fragment/rules", source: { type: "default", revision: 1 } },
					{ key: "fragment/end", source: { type: "override", revision: 3, defaultVersion: version } }
				]
			});
			expect(await direct.retrieveInstruction({ version, key: "skill/prepare" })).toEqual(result);
			const otherToken = await authProvider.issueToken({ tenantId, userId: "bob" });
			const other = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken: otherToken });
			expect(await other.retrieveInstruction({ version, key: "skill/prepare" })).toMatchObject({ body: "Default Rules Default end" });
			for (const [body, error] of [
				["<!-- include:fragment/missing -->", "fragment not found"],
				["<!-- include:fragment/rules -->", "cycle"],
				["<!-- include:skill/prepare -->", "must target a fragment"]
			]) {
				await adminPool.query("UPDATE instruction_overrides SET body = $1 WHERE tenant_id = $2 AND user_id = 'alice' AND item_key = 'fragment/end'", [body, tenantId]);
				const response = await fetch(`${handle.url}/rpc`, {
					method: "POST",
					headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: "assembly", method: "retrieveInstruction", params: { version, key: "skill/prepare" } })
				});
				const failure = await response.json();
				expect(failure).toMatchObject({ error: { message: expect.stringContaining(error) } });
				expect(failure).not.toHaveProperty("result");
			}
		} finally {
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});

	it("returns one source-and-fragment snapshot during concurrent changes and retains loaded documents", async () => {
		const tenantId = createTestTenantId();
		const version = `snapshot-${randomUUID()}`;
		await installInstructionBundle(adminPool, { version, items: [
			{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment", body: "Default" }
		] });
		const writer = await adminPool.connect();
		const bearerToken = await authProvider.issueToken({ tenantId, userId: "alice" });
		const store = new HttpStore({ baseUrl: handle.url, tenantId, bearerToken });
		const sourceBody = (revision: number) => `Source ${revision} <!-- include:fragment/end -->`;
		const fragmentBody = (revision: number) => `Fragment ${revision}`;
		const hash = (body: string) => createHash("sha256").update(body).digest("hex");
		try {
			for (const [key, kind, body] of [
				["skill/prepare", "skill", sourceBody(1)], ["fragment/end", "fragment", fragmentBody(1)]
			]) {
				await writer.query(`INSERT INTO instruction_overrides (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
					VALUES ($1, 'alice', $2, $3, $4, 1, $5, $6)`, [tenantId, key, kind, body, hash(body), version]);
			}
			const loaded = await store.retrieveInstruction({ version, key: "skill/prepare" });
			async function updateInstructions(): Promise<void> {
				for (let revision = 2; revision <= 25; revision++) {
					await writer.query("BEGIN");
					try {
						for (const [key, body] of [["skill/prepare", sourceBody(revision)], ["fragment/end", fragmentBody(revision)]]) {
							await writer.query(`UPDATE instruction_overrides SET body = $1, revision = $2, content_hash = $3
								WHERE tenant_id = $4 AND user_id = 'alice' AND item_key = $5`, [body, revision, hash(body), tenantId, key]);
						}
						await writer.query("COMMIT");
					} catch (error) {
						await writer.query("ROLLBACK");
						throw error;
					}
				}
			}
			async function retrieveInstructions(): Promise<void> {
				for (let attempt = 0; attempt < 25; attempt++) {
					const result = await store.retrieveInstruction({ version, key: "skill/prepare" });
					const revision = result.source.revision;
					expect(result).toMatchObject({
						body: `Source ${revision} Fragment ${revision}`,
						source: { type: "override", contentHash: hash(sourceBody(revision)) },
						fragments: [{ key: "fragment/end", source: { type: "override", revision, contentHash: hash(fragmentBody(revision)) } }]
					});
				}
			}
			const operations = await Promise.allSettled([updateInstructions(), retrieveInstructions()]);
			for (const operation of operations) if (operation.status === "rejected") throw operation.reason;
			expect(loaded).toMatchObject({ body: "Source 1 Fragment 1", source: { revision: 1 }, fragments: [{ source: { revision: 1 } }] });
			expect(await store.retrieveInstruction({ version, key: "skill/prepare" })).toMatchObject({ body: "Source 25 Fragment 25", source: { revision: 25 } });
		} finally {
			writer.release();
			await store.close();
			await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
			await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [version]);
			await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [version]);
		}
	});
});
