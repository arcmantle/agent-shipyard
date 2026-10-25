import { randomUUID } from "node:crypto";

import { HttpStore, LocalAuthProvider } from "@agent-issues/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiServer } from "../index.js";
import { migratePgDatabase, withTenantTransaction } from "./connection.js";
import { configurePgRoles, verifyPgRuntimeRole } from "./roles.js";

const adminUrl = process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const suffix = randomUUID().replace(/-/g, "");
const database = `role_test_${suffix}`;
const roles = { owner: `owner_${suffix}`, migration: `migration_${suffix}`, runtime: `runtime_${suffix}` };
const setupRole = `setup_${suffix}`;

describe("production PostgreSQL roles", () => {
	const admin = new Pool({ connectionString: adminUrl });
	let setup: Pool;
	let operator: Pool;
	let runtime: Pool;

	beforeAll(async () => {
		const password = randomUUID();
		await admin.query(`CREATE ROLE ${setupRole} LOGIN NOINHERIT CREATEROLE PASSWORD '${password}'`);
		await admin.query(`CREATE DATABASE ${database} OWNER ${setupRole}`);
		const url = new URL(adminUrl);
		url.pathname = `/${database}`;
		setup = new Pool({ connectionString: url.href });
		for (const [kind, name] of Object.entries(roles)) {
			await setup.query(`CREATE ROLE ${name} ${kind === "owner" ? "NOLOGIN" : "LOGIN"} NOINHERIT`);
			await setup.query(`GRANT ${name} TO ${setupRole} WITH ADMIN TRUE, INHERIT FALSE, SET TRUE`);
		}
		await setup.query(`GRANT CREATE ON DATABASE ${database} TO ${roles.owner}`);
		url.username = setupRole;
		url.password = password;
		operator = new Pool({ connectionString: url.href });
	});

	afterAll(async () => {
		await runtime?.end();
		await operator?.end();
		await setup?.end();
		await admin.query(`DROP DATABASE IF EXISTS ${database}`);
		for (const role of [roles.runtime, roles.migration, roles.owner, setupRole]) {
			await admin.query(`DROP ROLE IF EXISTS ${role}`);
		}
		await admin.end();
	});

	it("supports isolated API reads and writes with restricted, repeatable runtime grants", async () => {
		const passwords = { runtime: randomUUID(), migration: randomUUID() };
		await configurePgRoles(operator, roles, passwords);
		const url = new URL(adminUrl);
		url.pathname = `/${database}`;
		url.username = roles.migration;
		url.password = passwords.migration;
		const migration = new Pool({ connectionString: url.href, options: `-c role=${roles.owner}` });
		url.username = roles.runtime;
		url.password = passwords.runtime;
		runtime = new Pool({ connectionString: url.href });
		const client = await runtime.connect();
		try {
			await migratePgDatabase(migration);
			await migratePgDatabase(migration);
			await migration.query("CREATE TABLE private_setup_probe (id text)");
			await setup.query(`GRANT CREATE ON SCHEMA public TO ${roles.runtime}`);
			await setup.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${roles.runtime}`);
			await setup.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} GRANT ALL ON TABLES TO ${roles.runtime}, PUBLIC`);
			await configurePgRoles(operator, roles);
			await migration.query("CREATE TABLE future_setup_probe (id text)");
			await expect(verifyPgRuntimeRole(runtime)).resolves.toBeUndefined();
			await expect(verifyPgRuntimeRole(setup)).rejects.toThrow("runtime permissions");
			await expect(verifyPgRuntimeRole(migration)).rejects.toThrow("runtime permissions");
			await setup.query(`GRANT TRUNCATE ON entities TO ${roles.runtime}`);
			await expect(verifyPgRuntimeRole(runtime)).rejects.toThrow("runtime permissions");
			await configurePgRoles(operator, roles);
			await expect(verifyPgRuntimeRole(runtime)).resolves.toBeUndefined();
			for (const grant of [
				`GRANT SELECT (id) ON private_setup_probe TO ${roles.runtime}`,
				`GRANT REFERENCES (id) ON entities TO ${roles.runtime}`,
				`GRANT SELECT (id) ON private_setup_probe TO PUBLIC`
			]) {
				await setup.query(grant);
				await expect(verifyPgRuntimeRole(runtime)).rejects.toThrow("runtime permissions");
				await configurePgRoles(operator, roles);
				await expect(verifyPgRuntimeRole(runtime)).resolves.toBeUndefined();
			}
			await setup.query(`CREATE VIEW tenant_exposure_probe AS SELECT * FROM entities; GRANT SELECT ON tenant_exposure_probe TO ${roles.runtime}`);
			try {
				await expect(verifyPgRuntimeRole(runtime)).rejects.toThrow("runtime permissions");
			} finally {
				await setup.query("DROP VIEW tenant_exposure_probe");
			}
			const auth = new LocalAuthProvider({ secret: randomUUID() });
			const handle = createApiServer({ pool: runtime, authProvider: auth, authMetadata: { provider: "entra", tenantId: "test", clientId: "test" }, port: 0 });
			await new Promise<void>((resolve) => handle.server.once("listening", resolve));
			const address = handle.server.address();
			if (!address || typeof address === "string") throw new Error("Test server is unavailable.");
			const tenants = ["role-tenant-a", "role-tenant-b"];
			const stores = await Promise.all(tenants.map(async (tenantId) => new HttpStore({
				baseUrl: `http://127.0.0.1:${address.port}`, tenantId,
				bearerToken: await auth.issueToken({ userId: `user-${tenantId}`, tenantId })
			})));
			try {
				for (const [index, store] of stores.entries()) {
					const entity = await store.createEntity({ kind: "initiative", title: `Tenant ${index}` });
					expect((await store.getEntityDetails(entity.reference)).entity.title).toBe(`Tenant ${index}`);
					await expect(stores[1 - index].getEntityDetails(entity.reference)).rejects.toThrow();
					await expect(stores[1 - index].updateEntity({ entityId: entity.reference, title: "Forbidden", expectedRevision: entity.revision, expectedContentHash: entity.contentHash })).rejects.toThrow();
					await withTenantTransaction(runtime, tenants[1 - index], async (executor) => {
						expect((await executor.query("SELECT id FROM entities WHERE id = $1", [entity.id])).rows).toEqual([]);
						expect((await executor.query("UPDATE entities SET title = 'Forbidden' WHERE id = $1 RETURNING id", [entity.id])).rows).toEqual([]);
					});
				}
			} finally {
				for (const store of stores) await store.close();
				await new Promise<void>((resolve, reject) => handle.server.close((error) => error ? reject(error) : resolve()));
			}
			for (const statement of [
				"CREATE TABLE forbidden (id text)",
				"CREATE TEMP TABLE forbidden (id text)",
				"ALTER TABLE entities ADD COLUMN forbidden text",
				"ALTER TABLE entities DISABLE ROW LEVEL SECURITY",
				"TRUNCATE entities",
				"DELETE FROM schema_migrations",
				"SELECT * FROM private_setup_probe",
				"SELECT * FROM future_setup_probe",
				"INSERT INTO future_setup_probe VALUES ('forbidden')",
				"TRUNCATE future_setup_probe",
				"SELECT * FROM schema_migrations",
				"DELETE FROM instruction_defaults",
				`SET ROLE ${roles.owner}`,
				`SET ROLE ${roles.migration}`,
				`ALTER ROLE ${roles.runtime} BYPASSRLS`,
				`CREATE ROLE forbidden_${suffix}`
			]) {
				await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
			}
			const rotated = { runtime: randomUUID(), migration: randomUUID() };
			await configurePgRoles(operator, roles, rotated);
			for (const kind of ["runtime", "migration"] as const) {
				url.username = roles[kind];
				url.password = passwords[kind];
				const oldLogin = new Pool({ connectionString: url.href });
				try {
					await expect(oldLogin.query("SELECT 1")).rejects.toMatchObject({ code: "28P01" });
				} finally {
					await oldLogin.end();
				}
				url.password = rotated[kind];
				const newLogin = new Pool({ connectionString: url.href });
				try {
					expect((await newLogin.query("SELECT 1 AS ready")).rows).toEqual([{ ready: 1 }]);
				} finally {
					await newLogin.end();
				}
			}
		} finally {
			client.release();
			await migration.end();
		}
	});

	it.each([
		{ change: `ALTER ROLE ${roles.runtime} BYPASSRLS`, restore: `ALTER ROLE ${roles.runtime} NOBYPASSRLS`, reason: "attributes" },
		{ change: `GRANT ${roles.owner} TO ${roles.runtime}`, restore: `REVOKE ${roles.owner} FROM ${roles.runtime}`, reason: "memberships" },
		{ change: `CREATE ROLE outsider_${suffix}; GRANT ${roles.owner} TO outsider_${suffix}`, restore: `REVOKE ${roles.owner} FROM outsider_${suffix}; DROP ROLE outsider_${suffix}`, reason: "memberships" },
		{ change: `CREATE ROLE outsider_${suffix}; GRANT ${roles.runtime} TO outsider_${suffix}`, restore: `REVOKE ${roles.runtime} FROM outsider_${suffix}; DROP ROLE outsider_${suffix}`, reason: "memberships" },
		{ change: `CREATE SCHEMA exposure; CREATE TABLE exposure.private_probe (id text); GRANT USAGE ON SCHEMA exposure TO ${roles.runtime}; GRANT SELECT ON exposure.private_probe TO ${roles.runtime}`, restore: "DROP SCHEMA exposure CASCADE", reason: "application schema" },
		{ change: "CREATE TABLE wrong_owner_probe (id text)", restore: "DROP TABLE wrong_owner_probe", reason: "schema owner" },
		{ change: `SET ROLE ${roles.owner}; CREATE TABLE unprotected_tenant_probe (tenant_id text); RESET ROLE`, restore: "DROP TABLE unprotected_tenant_probe", reason: "row-level security" }
	])("rejects unsafe $reason without changing the deployment grants", async ({ change, restore, reason }) => {
		await setup.query(change);
		const grants = "SELECT relname, relacl::text FROM pg_class WHERE relnamespace = 'public'::regnamespace ORDER BY relname";
		const before = (await setup.query(grants)).rows;
		try {
			if (reason === "application schema") await expect(verifyPgRuntimeRole(runtime)).rejects.toThrow("runtime permissions");
			await expect(configurePgRoles(operator, roles)).rejects.toThrow(reason);
			expect((await setup.query(grants)).rows).toEqual(before);
		} finally {
			await setup.query(restore);
		}
	});
});