import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { createApiServer, LocalAuthProvider, type ApiServerHandle } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

describe("createApiServer", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let handle: ApiServerHandle | null = null;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterEach(() => {
		handle?.server.close();
		handle = null;
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	it("listens over real HTTP and serves the JSON-RPC gate end to end", async () => {
		const authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
		handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider,
			pool: appPool,
			port: 4491
		});
		await new Promise<void>((resolve) => handle!.server.once("listening", resolve));

		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await fetch(`${handle.url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Real HTTP round-trip" } })
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result?: { title?: string } };
		expect(body.result?.title).toBe("Real HTTP round-trip");
	});
});
