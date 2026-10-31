import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { ManagedIdentityCredential } from "@azure/identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configurePgRoles, createPgPool, LocalAuthProvider, migratePgDatabase } from "./index.js";
import { createTestTenantId } from "./db/test-tenant-cleanup.js";
import { startProductionApi } from "./production.js";

const environment = {
	DATABASE_URL: "postgres://runtime@127.0.0.1:1/logbook?sslmode=verify-full",
	DATABASE_MANAGED_IDENTITY_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
	ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
	ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
	HOST: "127.0.0.1",
	PORT: "0"
};

describe("production API host", () => {
	const adminUrl = process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
	const admin = createPgPool({ connectionString: adminUrl });
	const suffix = randomUUID().replace(/-/g, "");
	const databaseName = `production_${suffix}`;
	const roles = { owner: `owner_${suffix}`, migration: `migration_${suffix}`, runtime: `runtime_${suffix}` };
	let setup: Pool;
	let migration: Pool;
	let runtimeUrl: string;

	beforeAll(async () => {
		await admin.query(`CREATE DATABASE ${databaseName}`);
		const url = new URL(adminUrl);
		url.pathname = `/${databaseName}`;
		setup = createPgPool({ connectionString: url.href });
		const passwords = { runtime: randomUUID(), migration: randomUUID() };
		await configurePgRoles(setup, roles, passwords);
		url.username = roles.migration;
		url.password = passwords.migration;
		migration = new Pool({ connectionString: url.href, options: `-c role=${roles.owner}` });
		await migratePgDatabase(migration);
		await configurePgRoles(setup, roles);
		url.username = roles.runtime;
		url.password = passwords.runtime;
		runtimeUrl = url.href;
	});

	afterAll(async () => {
		try {
			await migration?.end();
			await setup?.end();
			await admin.query("SET statement_timeout = '5s'");
			await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
			for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS ${role}`);
		} finally {
			await admin.end();
		}
	});

	it("uses renewed managed identity credentials for new database connections", async () => {
		const database = new URL(runtimeUrl);
		const password = decodeURIComponent(database.password);
		database.password = "";
		const credential = vi.spyOn(ManagedIdentityCredential.prototype, "getToken").mockResolvedValue({ token: password, expiresOnTimestamp: Date.now() + 60000 });
		const pool = createPgPool({ connectionString: database.href, managedIdentityClientId: environment.DATABASE_MANAGED_IDENTITY_CLIENT_ID });
		const clients = [];
		try {
			clients.push(await pool.connect());
			clients.push(await pool.connect());
			expect(credential).toHaveBeenCalledTimes(2);
			expect(credential).toHaveBeenCalledWith("https://ossrdbms-aad.database.windows.net/.default", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
		} finally {
			for (const client of clients) client.release();
			await pool.end();
			credential.mockRestore();
		}
	});

	it.each(["failed", "expired"])("rejects %s managed identity authentication without password fallback", async (failure) => {
		const credential = vi.spyOn(ManagedIdentityCredential.prototype, "getToken");
		if (failure === "failed") credential.mockRejectedValue(new Error("private-token-provider-error"));
		else credential.mockResolvedValue({ token: "private-expired-token", expiresOnTimestamp: 0 });
		const pool = createPgPool({
			connectionString: runtimeUrl,
			managedIdentityClientId: environment.DATABASE_MANAGED_IDENTITY_CLIENT_ID
		});
		try {
			await expect(pool.query("SELECT 1")).rejects.toThrow(/^Managed database authentication failed\.$/);
		} finally {
			await pool.end();
			credential.mockRestore();
		}
	});

	it("keeps liveness independent of database readiness and closes its pool", async () => {
		const query = vi.fn().mockRejectedValue(new Error(environment.DATABASE_URL));
		const end = vi.fn().mockResolvedValue(undefined);
		const handle = await startProductionApi({
			environment,
			pool: { query, end, on: vi.fn(), removeListener: vi.fn() } as unknown as Pool
		});

		try {
			const live = await fetch(`${handle.url}/health/live`);
			expect(live.status).toBe(200);
			expect(query).not.toHaveBeenCalled();
			const ready = await fetch(`${handle.url}/health/ready`);
			expect(ready.status).toBe(503);
			expect(await ready.text()).toBe('{"status":"not-ready"}');
			query.mockResolvedValue({ rows: [{ restricted: true }] });
			expect((await fetch(`${handle.url}/health/ready`)).status).toBe(200);
			query.mockResolvedValue({ rows: [{ restricted: false }] });
			expect((await fetch(`${handle.url}/health/ready`)).status).toBe(503);
		} finally {
			await handle.close();
		}
		expect(end).toHaveBeenCalledOnce();
		await expect(fetch(`${handle.url}/health/live`)).rejects.toThrow();
	});

	it("bounds shutdown when database cleanup does not finish", async () => {
		const end = vi.fn(() => new Promise<void>(() => {}));
		const handle = await startProductionApi({
			environment: { ...environment, SHUTDOWN_TIMEOUT_MS: "20" },
			pool: { query: vi.fn(), end, on: vi.fn(), removeListener: vi.fn() } as unknown as Pool
		});
		await expect(handle.close()).rejects.toThrow("API shutdown timed out.");
		await expect(handle.close()).rejects.toThrow("API shutdown timed out.");
		expect(end).toHaveBeenCalledOnce();
		await expect(fetch(`${handle.url}/health/live`)).rejects.toThrow();
	}, 1000);

	it("starts pool cleanup before rejecting shutdown with a stalled request", async () => {
		let queryStarted!: () => void;
		let finishQuery!: () => void;
		const started = new Promise<void>((resolve) => { queryStarted = resolve; });
		const query = vi.fn(() => {
			queryStarted();
			return new Promise<void>((resolve) => { finishQuery = resolve; });
		});
		const end = vi.fn().mockResolvedValue(undefined);
		const handle = await startProductionApi({
			environment: { ...environment, SHUTDOWN_TIMEOUT_MS: "20" },
			pool: { query, end, on: vi.fn(), removeListener: vi.fn() } as unknown as Pool
		});
		const request = fetch(`${handle.url}/health/ready`).then(() => "completed", () => "closed");
		try {
			await started;
			const shutdown = handle.close().catch((error) => {
				expect(end).toHaveBeenCalledOnce();
				throw error;
			});
			await expect(shutdown).rejects.toThrow("API shutdown timed out.");
			expect(await request).toBe("closed");
			await expect(fetch(`${handle.url}/health/live`)).rejects.toThrow();
		} finally {
			finishQuery();
			await handle.close().catch(() => {});
			await request;
		}
	}, 1000);

	it("serves authenticated application writes through the production listener", async () => {
		const pool = createPgPool({ connectionString: runtimeUrl });
		const authProvider = new LocalAuthProvider({ secret: "production-host-test-only" });
		let handle: Awaited<ReturnType<typeof startProductionApi>> | undefined;
		try {
			handle = await startProductionApi({ environment, pool, authProvider });
			const headers = { "content-type": "application/json" };
			const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Production host write" } });
			expect((await fetch(`${handle.url}/rpc`, { method: "POST", headers, body })).status).toBe(401);
			const token = await authProvider.issueToken({ userId: "production-host-user", tenantId: createTestTenantId() });
			const response = await fetch(`${handle.url}/rpc`, {
				method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { title: "Production host write" } });
		} finally {
			if (handle) await handle.close();
			else await pool.end();
		}
	});

	it("runs database setup with a unique probe table before listening", async () => {
		const setupConfiguration = { database_url: "postgres://server.postgres.database.azure.com/logbook?sslmode=verify-full", owner_role: "logbook_owner" };
		const instructionBundle = { version: `9.8.7-${suffix}`, items: [{ key: "skill/startup-check", kind: "skill" as const, body: "# Startup check" }] };
		await expect(startProductionApi({ environment: { ...environment, DATABASE_SETUP_CONFIG: "not-json" } })).rejects.toThrow("DATABASE_SETUP_CONFIG");
		const calls: Array<{ config: Record<string, unknown>; bundle: unknown; listening: boolean }> = [];
		let listening = false;
		const setupDatabase = vi.fn(async (setupEnvironment: NodeJS.ProcessEnv, _role?: string, bundle?: unknown) => {
			calls.push({ config: JSON.parse(setupEnvironment.DATABASE_SETUP_CONFIG!), bundle, listening });
			return undefined;
		});
		for (let start = 0; start < 2; start++) {
			const handle = await startProductionApi({
				environment: { ...environment, DATABASE_SETUP_CONFIG: JSON.stringify(setupConfiguration) },
				pool: { query: vi.fn(), end: vi.fn(async () => {}), on: vi.fn(), removeListener: vi.fn() } as unknown as Pool,
				instructionBundle,
				setupDatabase,
				authProvider: new LocalAuthProvider({ secret: "production-host-test-only" })
			});
			listening = true;
			await handle.close();
			listening = false;
		}
		expect(calls.map(({ bundle, listening: wasListening }) => ({ bundle, wasListening })))
			.toEqual([{ bundle: instructionBundle, wasListening: false }, { bundle: instructionBundle, wasListening: false }]);
		for (const call of calls) {
			expect(call.config).toMatchObject(setupConfiguration);
			expect(call.config.verification_table).toMatch(/^logbook_role_check_[1-9][0-9]*_[1-9][0-9]*$/);
		}
		expect(calls[0]!.config.verification_table).not.toBe(calls[1]!.config.verification_table);
	});
});