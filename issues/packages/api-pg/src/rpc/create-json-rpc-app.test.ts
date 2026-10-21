import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import request from "supertest";
import type { Server } from "node:http";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../db/test-tenant-cleanup.js";
import { createJsonRpcApp, LocalAuthProvider } from "@agent-issues/core";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// The gate always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced (Postgres superusers bypass RLS
// unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

describe("JSON-RPC gate", () => {
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

	// One long-lived server for the file; see `entity-methods.test.ts` for why
	// binding a fresh ephemeral port per request goes wrong under parallel runs.
	let server: Server;

	beforeAll(() => {
		server = app().listen(0);
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("rejects a request with no Authorization header before it ever reaches PgStore", async () => {
		const response = await request(server)
			.post("/rpc")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Should not be created" } });

		expect(response.status).toBe(401);
	});

	it("rejects a request with an invalid bearer token", async () => {
		const response = await request(server)
			.post("/rpc")
			.set("authorization", "Bearer not-a-real-token")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Should not be created" } });

		expect(response.status).toBe(401);
	});

	it("creates an entity through the seam, scoped to the auth-seam-resolved tenant", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the gate" } });

		expect(response.status).toBe(200);
		expect(response.body.jsonrpc).toBe("2.0");
		expect(response.body.id).toBe(1);
		expect(response.body.result).toMatchObject({ kind: "initiative", title: "Ship the gate" });

		const store = new PgStore(appPool, tenantId);
		const details = await store.getEntityDetails(response.body.result.id);
		expect(details.entity.title).toBe("Ship the gate");
	});

	it("creates the trusted authenticated user when a request writes", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "entra:ada", tenantId, displayName: "Ada Lovelace" });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship authenticated mutations" } });

		expect(response.status).toBe(200);
		expect(response.body.error).toBeUndefined();
		expect(await new PgStore(appPool, tenantId).listUsers()).toMatchObject([
			{ authenticationSubject: "entra:ada", displayName: "Ada Lovelace" }
		]);
	});

	it("never lets a caller-supplied tenantId override the auth-seam-resolved one", async () => {
		const realTenantId = createTestTenantId();
		const spoofedTenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId: realTenantId });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({
				jsonrpc: "2.0",
				id: 1,
				method: "createEntity",
				params: { kind: "initiative", title: "Attempted spoof", tenantId: spoofedTenantId }
			});

		expect(response.status).toBe(200);

		const realTenantStore = new PgStore(appPool, realTenantId);
		expect((await realTenantStore.listEntities("initiative")).map((entity) => entity.title)).toContain("Attempted spoof");

		const spoofedTenantStore = new PgStore(appPool, spoofedTenantId);
		expect((await spoofedTenantStore.listEntities("initiative")).map((entity) => entity.title)).not.toContain("Attempted spoof");
	});

	it("returns a JSON-RPC error response, not an HTTP failure, when the underlying method throws", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "not-a-real-kind", title: "Bad kind" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toBeUndefined();
		expect(response.body.error).toMatchObject({ code: expect.any(Number), message: expect.any(String) });
	});

	it("rejects an unknown JSON-RPC method", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "notARealMethod", params: {} });

		expect(response.status).toBe(200);
		expect(response.body.error).toMatchObject({ code: -32601 });
	});

	it("rejects a malformed JSON-RPC envelope", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await request(server)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ notJsonRpc: true });

		expect(response.status).toBe(400);
	});
});
