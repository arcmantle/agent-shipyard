import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEntity, ensureDatabase, openSqliteStore } from "@agent-issues/api-local";
import { withStore } from "../cli/shared.js";
import packageJson from "../../package.json" with { type: "json" };
import { startLiveSite } from "./server.js";

const TENANT = "selected-project-routing";

let previousNoDaemon: string | undefined;
let temporaryDirectory: string | null = null;

afterEach(() => {
	if (previousNoDaemon === undefined) {
		delete process.env.AGENT_ISSUES_NO_DAEMON;
	} else {
		process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
	}
	if (temporaryDirectory) {
		rmSync(temporaryDirectory, { force: true, recursive: true });
		temporaryDirectory = null;
	}
});

describe("selected project site routing", () => {
	it("confirms local site resets with inspected revisions while preserving immutable defaults", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-reset-site-"));
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: temporaryDirectory, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}/api/instructions`;
		const key = "skill/prepare";
		const bundle = { version: packageJson.version, items: [
			{ key, kind: "skill" as const, body: "Prepare <!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Official rules" }
		] };
		const post = (operation: string, body: unknown) => fetch(`${baseUrl}/${operation}?tenant=${TENANT}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
		});
		const read = (operation: string, itemKey = key) => fetch(`${baseUrl}/${operation}?tenant=${TENANT}&key=${encodeURIComponent(itemKey)}&version=wrong-release`);
		try {
			const seeded = await openSqliteStore(dbPath, { tenant: TENANT, projectIdentity: "reset-site-fixture" });
			try { await seeded.store.importInstructionBundle(bundle); } finally { await seeded.store.close(); }
			await post("source", { key: "fragment/rules", body: "Personal rules", expectedRevision: 1 });
			await post("source", { key, body: "Personal preparation", expectedRevision: 1 });
			const inspection = await read("reset/inspect").then((response) => response.json());
			expect(inspection).toMatchObject({ key, version: packageJson.version, modifiedFragments: ["fragment/rules"], proposedSource: { body: bundle.items[0].body } });
			const stale = await post("reset", { key, expectedRevision: 1 });
			expect(stale.status).toBe(400);
			expect(await read("source").then((response) => response.json())).toEqual(inspection.currentSource);
			const reset = await post("reset", { key, expectedRevision: inspection.currentSource.source.revision, version: "wrong-release" });
			expect(reset.status).toBe(200);
			expect(await reset.json()).toMatchObject({ body: bundle.items[0].body, version: packageJson.version, source: { type: "default", revision: 3 } });
			expect(await read("source", "fragment/rules").then((response) => response.json())).toMatchObject({ body: "Personal rules", source: { type: "override", revision: 2 } });
			await post("fragments/create", { key: "fragment/personal", body: "Private" });
			const all = await read("reset-all/inspect").then((response) => response.json());
			expect(all).toMatchObject({ overrides: [{ currentSource: { key: "fragment/rules" } }], personalFragments: [{ key: "fragment/personal" }] });
			expect((await post("reset-all", { expectedRevisions: all.expectedRevisions })).status).toBe(400);
			const complete = await post("reset-all", { expectedRevisions: all.expectedRevisions, confirmationToken: all.confirmationToken });
			expect(complete.status).toBe(200);
			expect(await read("reset-all/inspect").then((response) => response.json())).toMatchObject({ overrides: [], personalFragments: [], expectedRevisions: [] });
			const official = await openSqliteStore(dbPath, { tenant: TENANT, projectIdentity: "reset-site-fixture" });
			try {
				await official.store.importInstructionBundle(bundle);
				for (const item of bundle.items) expect((await official.store.compareInstructionSource({ key: item.key, version: bundle.version })).defaultSource?.body).toBe(item.body);
			} finally { await official.store.close(); }
		} finally {
			const closed = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closed;
		}
	});

	it("creates and removes personal fragments through local site routes with revision and reference protection", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-fragment-site-"));
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: temporaryDirectory, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;
		const post = (operation: string, value: unknown) => fetch(`${baseUrl}/api/instructions/${operation}?tenant=${TENANT}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value)
		});
		const key = "fragment/site-personal";
		try {
			const seeded = await openSqliteStore(dbPath, { tenant: TENANT, projectIdentity: "fragment-site-fixture" });
			try {
				await seeded.store.importInstructionBundle({ version: packageJson.version, items: [
					{ key: "skill/prepare", kind: "skill", body: "Prepare" },
					{ key: "fragment/rules", kind: "fragment", body: "Rules" }
				] });
			} finally {
				await seeded.store.close();
			}
			const response = await post("fragments/create", { key, body: "Personal", version: "not-the-cli-release" });
			expect(response.status).toBe(200);
			const created = await response.json();
			expect(created).toMatchObject({ key, kind: "fragment", body: "Personal", version: packageJson.version, source: { type: "personal", revision: 1 } });
			const duplicate = await post("fragments/create", { key, body: "Replacement" });
			expect(duplicate.status).toBe(400);
			expect(await duplicate.json()).toMatchObject({ reason: "already-exists", currentSource: created });
			await post("source", { key: "skill/prepare", body: `Prepare <!-- include:${key} -->`, expectedRevision: 1 });
			const referenced = await post("fragments/remove", { key, expectedRevision: 1 });
			expect(referenced.status).toBe(400);
			expect(await referenced.json()).toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
			await post("source", { key: "skill/prepare", body: "Prepare", expectedRevision: 2 });
			const changed = await post("source", { key, body: "Changed", expectedRevision: 1 });
			expect(changed.status).toBe(200);
			const saved = await changed.json();
			const stale = await post("fragments/remove", { key, expectedRevision: 1 });
			expect(stale.status).toBe(400);
			expect(await stale.json()).toMatchObject({ reason: "revision-conflict", currentSource: saved });
			const unchanged = await fetch(`${baseUrl}/api/instructions/source?tenant=${TENANT}&key=${key}`).then((result) => result.json());
			expect(unchanged).toEqual(saved);
			const removed = await post("fragments/remove", { key, expectedRevision: saved.source.revision });
			expect(removed.status).toBe(200);
			const catalog = await fetch(`${baseUrl}/api/instructions/catalog?tenant=${TENANT}`).then((result) => result.json());
			expect(catalog.items.map((item: { key: string }) => item.key)).not.toContain(key);
			expect(catalog.items.map((item: { key: string }) => item.key)).toContain("fragment/rules");
			for (const operation of ["create", "remove"]) {
				expect((await fetch(`${baseUrl}/api/instructions/fragments/${operation}`)).status).toBe(405);
				expect((await post(`fragments/${operation}`, { key: "skill/new", body: "", expectedRevision: 1 })).status).toBe(400);
			}
			expect((await post("fragments/remove", { key: "fragment/rules", expectedRevision: 1 })).status).toBe(400);
		} finally {
			const closed = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closed;
		}
	});

	it("reads the local instruction catalog and source without a selected project", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-site-"));
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: temporaryDirectory, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			const seeded = await openSqliteStore(dbPath, { tenant: TENANT, projectIdentity: "instruction-site-fixture" });
			try {
				await seeded.store.importInstructionBundle({ version: packageJson.version, items: [
					{ key: "agent/agent-issues", kind: "agent", body: "---\nname: agent-issues\ntools: ['*']\n---\n# Agent\n" },
					{ key: "skill/prepare", kind: "skill", body: "# Prepare\n" },
					{ key: "fragment/rules", kind: "fragment", body: "Rules\n" }
				] });
			} finally {
				await seeded.store.close();
			}
			const expected = await withStore(dbPath, { currentWorkingDirectory: temporaryDirectory, tenant: TENANT },
				(store) => store.listInstructionSources({ version: packageJson.version }));
			const response = await fetch(`${baseUrl}/api/instructions/catalog?tenant=${TENANT}&version=not-the-cli-release`);
			expect(response.status).toBe(200);
			const catalog = await response.json();
			expect(catalog).toMatchObject({ ...expected, owner: { type: "local" } });
			const item = expected.items[0]!;
			const source = await fetch(`${baseUrl}/api/instructions/source?tenant=${TENANT}&key=${encodeURIComponent(item.key)}`).then((result) => result.json());
			expect(source).toEqual({ ...item, version: packageJson.version });
			const missing = await fetch(`${baseUrl}/api/instructions/source?tenant=${TENANT}&key=skill/missing`);
			expect(missing.status).toBe(500);
			expect(await missing.text()).toContain("Instruction not found");
			const save = (body: string, expectedRevision: number) => fetch(`${baseUrl}/api/instructions/source?tenant=${TENANT}`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: item.key, body, expectedRevision, version: "not-the-cli-release" })
			});
			const changedBody = item.body.replace("# Agent", "# Edited agent\n\n<!-- include:fragment/rules -->");
			const savedResponse = await save(changedBody, item.source.revision);
			expect(savedResponse.status).toBe(200);
			const saved = await savedResponse.json();
			expect(saved).toMatchObject({ key: item.key, body: changedBody, version: packageJson.version, source: { revision: item.source.revision + 1 } });
			const comparison = await fetch(`${baseUrl}/api/instructions/compare?tenant=${TENANT}&key=${encodeURIComponent(item.key)}&version=not-the-cli-release`);
			expect(comparison.status).toBe(200);
			expect(await comparison.json()).toEqual(await withStore(dbPath, { currentWorkingDirectory: temporaryDirectory, tenant: TENANT },
				(store) => store.compareInstructionSource({ key: item.key, version: packageJson.version })));
			const missingComparison = await fetch(`${baseUrl}/api/instructions/compare?tenant=${TENANT}&key=skill/missing`);
			expect(missingComparison.status).toBe(500);
			expect(await missingComparison.text()).toContain("Instruction not found");
			expect((await fetch(`${baseUrl}/api/instructions/compare?tenant=${TENANT}`)).status).toBe(400);
			expect((await fetch(`${baseUrl}/api/instructions/compare?tenant=${TENANT}&key=${encodeURIComponent(item.key)}`, { method: "POST" })).status).toBe(405);
			const dependencies = await fetch(`${baseUrl}/api/instructions/dependencies?tenant=${TENANT}&key=${encodeURIComponent(item.key)}&version=not-the-cli-release`);
			expect(dependencies.status).toBe(200);
			expect(await dependencies.json()).toEqual(await withStore(dbPath, { currentWorkingDirectory: temporaryDirectory, tenant: TENANT },
				(store) => store.inspectInstructionDependencies({ key: item.key, version: packageJson.version })));
			const missingDependencies = await fetch(`${baseUrl}/api/instructions/dependencies?tenant=${TENANT}&key=skill/missing`);
			expect(missingDependencies.status).toBe(500);
			expect(await missingDependencies.text()).toContain("Instruction not found");
			expect((await fetch(`${baseUrl}/api/instructions/dependencies?tenant=${TENANT}`)).status).toBe(400);
			expect((await fetch(`${baseUrl}/api/instructions/dependencies?tenant=${TENANT}&key=${encodeURIComponent(item.key)}`, { method: "POST" })).status).toBe(405);
			for (const invalid of [
				{ body: changedBody, revision: item.source.revision, message: "revision conflict" },
				{ body: changedBody + "\n<!-- include:fragment/missing -->", revision: saved.source.revision, message: "fragment not found" },
				{ body: changedBody.replace("name: agent-issues", "name: changed"), revision: saved.source.revision, message: "frontmatter" }
			]) {
				const rejected = await save(invalid.body, invalid.revision);
				expect(rejected.ok).toBe(false);
				expect(await rejected.text()).toContain(invalid.message);
				const unchanged = await fetch(`${baseUrl}/api/instructions/source?tenant=${TENANT}&key=${encodeURIComponent(item.key)}`).then((result) => result.json());
				expect(unchanged).toEqual(saved);
			}
			const readInstruction = (operation: string, extra = "") => fetch(`${baseUrl}/api/instructions/${operation}?tenant=${TENANT}&key=${encodeURIComponent(item.key)}${extra}`);
			const history = await readInstruction("history", "&version=not-the-cli-release");
			expect(history.status).toBe(200);
			expect(await history.json()).toEqual({ key: item.key, version: packageJson.version, revisions: [saved] });
			const historical = await readInstruction("revision", `&revision=${saved.source.revision}`);
			expect(historical.status).toBe(200);
			expect(await historical.json()).toEqual(saved);
			const latest = await save(changedBody + "\nLatest", saved.source.revision).then((result) => result.json());
			const restore = (revision: number, expectedRevision: number) => fetch(`${baseUrl}/api/instructions/restore?tenant=${TENANT}`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: item.key, revision, expectedRevision, version: "not-the-cli-release" })
			});
			const stale = await restore(saved.source.revision, saved.source.revision);
			expect(stale.status).toBe(400);
			expect(await stale.text()).toContain("revision conflict");
			expect(await readInstruction("source").then((result) => result.json())).toEqual(latest);
			const restoredResponse = await restore(saved.source.revision, latest.source.revision);
			expect(restoredResponse.status).toBe(200);
			const restored = await restoredResponse.json();
			expect(restored).toMatchObject({ body: saved.body, version: packageJson.version, source: { revision: latest.source.revision + 1 } });
			const fragment = "fragment/temporary";
			const post = (operation: string, value: unknown) => fetch(`${baseUrl}/api/instructions/${operation}?tenant=${TENANT}`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value)
			});
			expect((await post("fragments/create", { key: fragment, body: "Temporary" })).status).toBe(200);
			const referenced = await save(changedBody + `\n<!-- include:${fragment} -->`, restored.source.revision).then((result) => result.json());
			const unreferenced = await save(changedBody, referenced.source.revision).then((result) => result.json());
			expect((await post("fragments/remove", { key: fragment, expectedRevision: 1 })).status).toBe(200);
			const historyBeforeFailure = await readInstruction("history").then((result) => result.json());
			const invalidRestore = await restore(referenced.source.revision, unreferenced.source.revision);
			expect(invalidRestore.status).toBe(400);
			expect(await invalidRestore.text()).toContain("fragment not found");
			expect(await readInstruction("source").then((result) => result.json())).toEqual(unreferenced);
			expect(await readInstruction("history").then((result) => result.json())).toEqual(historyBeforeFailure);
			for (const revision of ["", "&revision=0", "&revision=-1", "&revision=1.5"]) {
				expect((await readInstruction("revision", revision)).status).toBe(400);
			}
			expect((await readInstruction("restore")).status).toBe(405);
			expect((await restore(0, unreferenced.source.revision)).status).toBe(400);
		} finally {
			const closed = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closed;
		}
	});

	it("reads and changes the browser-selected project instead of the workspace project", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-selected-project-"));
		const workspace = path.join(temporaryDirectory, "workspace-project");
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		mkdirSync(workspace);

		const { db, executor } = await ensureDatabase(dbPath, { tenant: TENANT });
		const workspaceProject = createEntity(executor, { kind: "project", title: "workspace-project" });
		const selectedProject = createEntity(executor, { kind: "project", title: "selected-project" });
		db.currentProjectId = workspaceProject.id;
		const workspaceAdr = createEntity(executor, { kind: "adr", title: "Workspace ADR" });
		const workspaceEpic = createEntity(executor, { kind: "epic", parentId: workspaceProject.id, title: "Workspace delivery" });
		const workspaceInitiative = createEntity(executor, { kind: "initiative", parentId: workspaceEpic.id, title: "Workspace initiative" });
		db.currentProjectId = selectedProject.id;
		const selectedAdr = createEntity(executor, { kind: "adr", title: "Selected ADR" });
		const selectedEpic = createEntity(executor, { kind: "epic", parentId: selectedProject.id, title: "Selected delivery" });
		const selectedInitiative = createEntity(executor, { kind: "initiative", parentId: selectedEpic.id, title: "Selected initiative" });
		db.close();

		previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: workspace, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const adrSection = await fetch(`${baseUrl}/api/project-adrs?tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json()) as {
				projectAdrs: Array<{ id: string }>;
			};
			expect(adrSection.projectAdrs.map((adr) => adr.id)).toEqual([selectedAdr.id]);
			expect(adrSection.projectAdrs.map((adr) => adr.id)).not.toContain(workspaceAdr.id);

			const detail = await fetch(`${baseUrl}/api/initiative-detail?initiative=${selectedInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json()) as {
				initiative: { id: string; title: string };
			};
			expect(detail.initiative).toMatchObject({ id: selectedInitiative.id, title: "Selected initiative" });
			await expect(fetch(`${baseUrl}/api/entity-detail?entity=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/entity-relations?entity=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/initiative-detail?initiative=${workspaceInitiative.id}&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });
			await expect(fetch(`${baseUrl}/api/initiative-tab?initiative=${workspaceInitiative.id}&tab=overview&tenant=${TENANT}&project=${selectedProject.id}`).then((response) => response.json())).resolves.toEqual({ kind: "unavailable" });

			const mutationResponse = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "selected-project-write",
					method: "updateEntity",
					params: {
						entityId: selectedInitiative.id,
						expectedContentHash: selectedInitiative.contentHash,
						expectedRevision: selectedInitiative.revision,
						title: "Updated selected initiative"
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			const mutation = await mutationResponse.json() as { result: { id: string; title: string } };
			expect(mutation.result).toMatchObject({ id: selectedInitiative.id, title: "Updated selected initiative" });

			const crossProjectMutation = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-write",
					method: "updateEntity",
					params: {
						entityId: workspaceInitiative.id,
						expectedContentHash: workspaceInitiative.contentHash,
						expectedRevision: workspaceInitiative.revision,
						title: "Changed through selected project"
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectMutation.status).toBe(500);

			const crossProjectCreate = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-create",
					method: "createEntity",
					params: { kind: "issue", parentId: workspaceInitiative.id, title: "Wrong project issue" }
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectCreate.status).toBe(500);

			const crossProjectRelations = await fetch(`${baseUrl}/api/project-mutation?tenant=${TENANT}&project=${selectedProject.id}`, {
				body: JSON.stringify({
					correlationId: "cross-project-relations",
					method: "applyRelations",
					params: {
						relations: [{ fromId: selectedInitiative.id, toId: workspaceInitiative.id, type: "supersedes" }]
					}
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			expect(crossProjectRelations.status).toBe(500);

			const workspaceDetail = await fetch(`${baseUrl}/api/initiative-detail?initiative=${workspaceInitiative.id}&tenant=${TENANT}&project=${workspaceProject.id}`).then((response) => response.json()) as {
				initiative: { title: string };
			};
			expect(workspaceDetail.initiative.title).toBe("Workspace initiative");
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});
});