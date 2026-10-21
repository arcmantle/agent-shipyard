import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import request from "supertest";
import type { Server } from "node:http";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../db/test-tenant-cleanup.js";
import { createJsonRpcApp, LocalAuthProvider } from "@agent-issues/core";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

/**
 * ISS50 mechanically extends the ISS49 tracer bullet's dispatcher to cover
 * the remaining entity-lifecycle `StorageDriver` methods. These tests prove
 * each method is reachable through the gate and dispatches to the
 * auth-seam-resolved tenant's `PgStore` - the underlying business logic
 * itself is already proven by `pg-store.test.ts` and the shared
 * `storage-driver-contract.test.ts` suite.
 */
describe("JSON-RPC gate: entity-lifecycle methods", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let authProvider: LocalAuthProvider;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	function app() {
		return createJsonRpcApp({ authProvider, createStore: (identity) => new PgStore(appPool, identity.tenantId) });
	}

	// One long-lived server for the whole file rather than `request(app())` per
	// call. Supertest binds a fresh ephemeral port for every request it is handed
	// an app, and with vitest running files in parallel that churn lets a request
	// land on a port another worker has just rebound - which surfaces as a
	// response that does not match the request at all (a malformed-body 400, or a
	// 405 from whichever server actually answered). The app is stateless; each
	// request still builds its own store from the bearer token's tenant.
	let server: Server;

	beforeAll(() => {
		server = app().listen(0);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	async function tenantAndToken() {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		return { tenantId, token };
	}

	async function call(token: string, method: string, params?: unknown) {
		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
		expect(response.body.error).toBeUndefined();
		expect(response.status).toBe(200);
		return response.body.result;
	}

	it("getEntityDetails", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

		const details = await call(token, "getEntityDetails", { entityId: initiative.id });
		expect(details.entity.id).toBe(initiative.id);
	});

	it("listEntities", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		await store.createEntity({ kind: "initiative", title: "First" });
		await store.createEntity({ kind: "initiative", title: "Second" });

		const initiatives = await call(token, "listEntities", { kind: "initiative" });
		expect(initiatives.map((entity: { title: string }) => entity.title)).toEqual(expect.arrayContaining(["First", "Second"]));
	});

	it("listEntityHistory", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

		const history = await call(token, "listEntityHistory", { entityId: initiative.id });
		expect(history).toHaveLength(1);
	});

	it("listOrphans", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const orphanIssue = await store.createEntity({ kind: "issue", title: "Orphan issue" });

		const orphans = await call(token, "listOrphans", { kind: "issue" });
		expect(orphans.map((entity: { id: string }) => entity.id)).toEqual([orphanIssue.id]);
	});

	it("listProjectAdrs", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const projectAdr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		const projectAdrs = await call(token, "listProjectAdrs");
		expect(projectAdrs.map((entity: { id: string }) => entity.id)).toContain(projectAdr.id);
	});

	it("updateEntityStatus", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		const statusUpdate = await call(token, "updateEntityStatus", { entityId: issue.id, status: "in-progress" });
		expect(statusUpdate.entity.status).toBe("in-progress");
	});

	it("setEntityBody", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		const updated = await call(token, "setEntityBody", { entityId: issue.id, body: "Detailed plan.", expectedRevision: issue.revision, expectedContentHash: issue.contentHash });
		expect(updated.body).toBe("Detailed plan.");
	});

	it("updateEntity", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const issue = await store.createEntity({ kind: "issue", title: "Initial title" });

		const updated = await call(token, "updateEntity", { entityId: issue.id, title: "Final title", body: "Final body", expectedRevision: issue.revision, expectedContentHash: issue.contentHash });
		expect(updated).toEqual(expect.objectContaining({ body: "Final body", title: "Final title", revision: 2 }));
		expect(await store.listEntityHistory(issue.id)).toHaveLength(2);
	});

	it("archiveEntity", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		const archived = await call(token, "archiveEntity", { entityId: issue.id });
		expect(archived.entity.status).toBe("done");
	});

	it("moveEntity", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiativeA = await store.createEntity({ kind: "initiative", title: "A" });
		const initiativeB = await store.createEntity({ kind: "initiative", title: "B" });
		const issue = await store.createEntity({ kind: "issue", title: "Movable", parentId: initiativeA.id });

		const moved = await call(token, "moveEntity", { entityId: issue.id, newParentId: initiativeB.id });
		expect(moved.newParentId).toBe(initiativeB.id);
	});

	it("linkEntities and unlinkEntities", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocking issue", parentId: initiative.id });

		const linked = await call(token, "linkEntities", { fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(linked.created).toBe(true);

		const unlinked = await call(token, "unlinkEntities", { fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(unlinked.removed).toBe(true);
	});

	it("deleteEntity", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const issue = await store.createEntity({ kind: "issue", title: "Disposable" });

		const deleted = await call(token, "deleteEntity", { entityId: issue.id });
		expect(deleted.removed).toBe(true);
	});

	it("getDatabaseSnapshot", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

		const snapshot = await call(token, "getDatabaseSnapshot");
		expect(snapshot.entities.map((entity: { id: string }) => entity.id)).toContain(initiative.id);
	});

	it("getInitiativeBundle", async () => {
		const { tenantId, token } = await tenantAndToken();
		const store = new PgStore(appPool, tenantId);
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

		const bundle = await call(token, "getInitiativeBundle", { initiativeId: initiative.id });
		expect(bundle.initiative.id).toBe(initiative.id);
	});
});
