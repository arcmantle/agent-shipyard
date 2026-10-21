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
 * ISS51 mechanically extends the ISS49 tracer bullet's dispatcher to cover
 * the context/glossary `StorageDriver` methods. These tests
 * prove each method is reachable through the gate and dispatches to the
 * auth-seam-resolved tenant's `PgStore` - the underlying business logic
 * itself is already proven by `pg-store.test.ts` and the shared
 * `storage-driver-contract.test.ts` suite.
 */
describe("JSON-RPC gate: context/glossary methods", () => {
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

	describe("context and glossary", () => {
		it("upsertContext and getContextDetails", async () => {
			const { tenantId, token } = await tenantAndToken();
			const store = new PgStore(appPool, tenantId);
			const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

			const upserted = await call(token, "upsertContext", { scopeRef: initiative.id, title: "Custom title", summary: "Custom summary" });
			expect(upserted.context.title).toBe("Custom title");

			const details = await call(token, "getContextDetails", { scopeRef: initiative.id });
			expect(details.context.title).toBe("Custom title");
		});

		it("defineContextTerm and forgetContextTerm", async () => {
			const { tenantId, token } = await tenantAndToken();
			const store = new PgStore(appPool, tenantId);
			const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

			const defined = await call(token, "defineContextTerm", {
				scopeRef: initiative.id,
				term: "storage-driver seam",
				definition: "The engine-agnostic boundary the domain layer talks to."
			});
			expect(defined.created).toBe(true);

			const forgotten = await call(token, "forgetContextTerm", {
				scopeRef: initiative.id,
				term: "storage-driver seam",
				expectedRevision: defined.term.revision,
				expectedContentHash: defined.term.contentHash
			});
			expect(forgotten.removed).toBe(true);
		});

		it("listContexts", async () => {
			const { tenantId, token } = await tenantAndToken();
			const store = new PgStore(appPool, tenantId);
			await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });

			const listed = await call(token, "listContexts");
			const shared = listed.contexts.find((entry: { context: { scopeKind: string } }) => entry.context.scopeKind === "default");
			expect(shared?.termCount).toBe(1);
		});

		it("getContextDirectory", async () => {
			const { tenantId, token } = await tenantAndToken();
			const store = new PgStore(appPool, tenantId);
			await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });

			const directory = await call(token, "getContextDirectory");
			expect(directory.shared.terms.map((term: { term: string }) => term.term)).toEqual(["Order"]);
		});

		it("queryContextDirectory", async () => {
			const { tenantId, token } = await tenantAndToken();
			const store = new PgStore(appPool, tenantId);
			await store.defineContextTerm({ scopeRef: "default", term: "Administration", definition: "Shared admin surface." });

			const result = await call(token, "queryContextDirectory", { query: "admin", view: "global" });
			expect(result.terms.map((term: { term: string }) => term.term)).toEqual(["Administration"]);
		});
	});
});
