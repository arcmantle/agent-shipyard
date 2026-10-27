import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { runDatabaseSetup } from "../database-setup.js";
import * as connection from "./connection.js";
import { configurePgEntraRoles } from "./roles.js";

it("registers exact Entra principals transactionally and rejects changed or unmapped identities", async () => {
	const adminUrl = process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
	const suffix = randomUUID().replaceAll("-", "");
	const database = `entra_test_${suffix}`;
	// Azure setup identity names contain hyphens, so SQL must quote them.
	const operatorRole = `setup-${suffix}`;
	const operatorSql = `"${operatorRole}"`;
	const databaseOwner = `database_owner_${suffix}`;
	const roles = { owner: `owner_${suffix}`, migration: `migration_${suffix}`, runtime: `runtime_${suffix}` };
	const principals = { tenantId: randomUUID(), runtimeObjectId: randomUUID(), migrationObjectId: randomUUID(), administrationRole: databaseOwner };
	const admin = new Pool({ connectionString: adminUrl });
	let setup: Pool | undefined;
	let operator: Pool | undefined;
	try {
		const password = randomUUID();
		await admin.query(`CREATE ROLE ${operatorSql} LOGIN NOINHERIT CREATEROLE PASSWORD '${password}'`);
		await admin.query(`CREATE ROLE ${databaseOwner} NOLOGIN NOINHERIT CREATEROLE`);
		await admin.query(`GRANT ${databaseOwner} TO ${operatorSql} WITH INHERIT TRUE, SET TRUE`);
		await admin.query(`CREATE DATABASE ${database} OWNER ${databaseOwner}`);
		const url = new URL(adminUrl);
		url.pathname = `/${database}`;
		setup = new Pool({ connectionString: url.href });
		await setup.query(`CREATE SCHEMA entra_fixture;
			CREATE TABLE entra_fixture.principals (rolename name, "principalType" text, "objectId" text, "tenantId" text, "isMfa" integer, "isAdmin" integer);
			GRANT USAGE ON SCHEMA entra_fixture TO ${operatorSql}, ${databaseOwner};
			GRANT SELECT, INSERT ON entra_fixture.principals TO ${operatorSql}, ${databaseOwner};
			CREATE FUNCTION pg_catalog.pgaadauth_list_principals(boolean) RETURNS SETOF entra_fixture.principals
				LANGUAGE sql AS 'SELECT * FROM entra_fixture.principals';
			CREATE FUNCTION pg_catalog.pgaadauth_create_principal_with_oid(role_name text, object_id text, object_type text, is_admin boolean, is_mfa boolean)
				RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$ BEGIN
					EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT', role_name);
					EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE', role_name, '${databaseOwner}');
					INSERT INTO entra_fixture.principals VALUES (role_name, object_type, object_id, '${principals.tenantId}', is_mfa::integer, is_admin::integer);
					RETURN role_name;
				END $body$`);
		url.username = operatorRole;
		url.password = password;
		operator = new Pool({ connectionString: url.href });
		await configurePgEntraRoles(operator, roles, principals);
		await configurePgEntraRoles(operator, roles, principals);
		const expected = (await setup.query("SELECT * FROM entra_fixture.principals ORDER BY rolename")).rows;
		expect(expected).toHaveLength(2);
		expect((await setup.query("SELECT rolpassword FROM pg_authid WHERE rolname = ANY($1::text[])", [[roles.runtime, roles.migration]])).rows)
			.toEqual([{ rolpassword: null }, { rolpassword: null }]);
		const workloadSession = await setup.connect();
		try {
			await workloadSession.query(`SET SESSION AUTHORIZATION ${roles.runtime}`);
			await workloadSession.query(`ALTER ROLE ${roles.runtime} PASSWORD '${password}'`);
			await expect(workloadSession.query(`ALTER ROLE ${roles.runtime} VALID UNTIL 'infinity'`)).rejects.toMatchObject({ code: "42501" });
		} finally {
			await workloadSession.query("RESET SESSION AUTHORIZATION");
			workloadSession.release();
		}
		const passwordUrl = new URL(adminUrl);
		Object.assign(passwordUrl, { pathname: `/${database}`, username: roles.runtime, password });
		const passwordLogin = new Pool({ connectionString: passwordUrl.href });
		try {
			await expect(passwordLogin.query("SELECT 1")).rejects.toMatchObject({ code: "28P01" });
		} finally {
			await passwordLogin.end();
		}
		await setup.query(`ALTER ROLE ${roles.migration} BYPASSRLS`);
		await setup.query("DELETE FROM entra_fixture.principals WHERE rolename = $1", [roles.runtime]);
		await setup.query(`DROP OWNED BY ${roles.runtime}; DROP ROLE ${roles.runtime}`);
		await expect(configurePgEntraRoles(operator, roles, principals)).rejects.toThrow("attributes are not restricted");
		expect((await setup.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roles.runtime])).rows).toEqual([]);
		expect((await setup.query("SELECT 1 FROM entra_fixture.principals WHERE rolename = $1", [roles.runtime])).rows).toEqual([]);
		await setup.query(`ALTER ROLE ${roles.migration} NOBYPASSRLS`);
		const identities = Object.fromEntries(["setup", "runtime", "migration"].map((kind) => [kind, {
			role: kind === "setup" ? operatorRole : roles[kind as "runtime" | "migration"], client_id: randomUUID(),
			principal_id: kind === "setup" ? randomUUID() : principals[kind === "runtime" ? "runtimeObjectId" : "migrationObjectId"]
		}]));
		const factory = vi.spyOn(connection, "createPgPool").mockImplementation((options) => {
			const identity = Object.values(identities).find((item) => item.client_id === options.managedIdentityClientId)!;
			const local = new URL(adminUrl);
			local.pathname = `/${database}`;
			if (identity.role === operatorRole) {
				local.username = operatorRole;
				local.password = password;
				return new Pool({ connectionString: local.href });
			}
			return new Pool({ connectionString: local.href, onConnect: async (client) => { await client.query(`SET SESSION AUTHORIZATION ${identity.role}`); } });
		});
		try {
			const configuration = JSON.stringify({
				database_url: "postgres://private.postgres.database.azure.com/logbook?sslmode=verify-full",
				tenant_id: principals.tenantId, identities, owner_role: roles.owner, verification_table: "logbook_role_check_123_1"
			});
			const configure = () => runDatabaseSetup({ DATABASE_SETUP_PHASE: "configure", DATABASE_SETUP_CONFIG: configuration }, databaseOwner);
			const missing = Object.fromEntries(Object.entries(identities).map(([kind, identity]) => [kind, kind === "setup" ? identity : { ...identity, role: `missing_${kind}_${suffix}` }]));
			await expect(runDatabaseSetup({ DATABASE_SETUP_PHASE: "reconcile", DATABASE_SETUP_CONFIG: JSON.stringify({
				...JSON.parse(configuration), identities: missing, owner_role: `missing_owner_${suffix}`
			}) }, databaseOwner)).resolves.toBeUndefined();
			await setup.query(`CREATE TABLE public.logbook_role_check_123_1 (value text); ALTER TABLE public.logbook_role_check_123_1 OWNER TO ${roles.owner}; INSERT INTO public.logbook_role_check_123_1 VALUES ('preserved')`);
			for (const unsafe of [true, false]) {
				await setup.query(`ALTER ROLE ${roles.migration} ${unsafe ? "BYPASSRLS" : "NOBYPASSRLS"}`);
				await expect(configure()).rejects.toMatchObject(unsafe
					? { message: expect.stringContaining("attributes are not restricted"), stage: "check administration role",
						roleAttributes: { session_createrole: true, administration_createrole: true, session_inherits_administration: true } }
					: { code: "42P07", stage: "create migration probe as schema owner" });
				expect((await setup.query("SELECT value FROM public.logbook_role_check_123_1")).rows).toEqual([{ value: "preserved" }]);
			}
			await setup.query("DROP TABLE public.logbook_role_check_123_1");
			await setup.query(`CREATE FUNCTION public.setup_owned_check() RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION public.setup_owned_check() OWNER TO ${operatorSql}`);
			await expect(configure()).rejects.toMatchObject({ message: expect.stringContaining("owns database objects"), stage: "inspect setup session" });
			await setup.query("DROP FUNCTION public.setup_owned_check()");
			await configure();
			const marker = `logbook-setup:${"a".repeat(64)}`;
			const forced = (table: string) => `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`;
			await setup.query(`CREATE TABLE public.logbook_role_check_99_1 (tenant_id text, value text); ALTER TABLE public.logbook_role_check_99_1 OWNER TO ${roles.owner};
				${forced("logbook_role_check_99_1")} COMMENT ON TABLE public.logbook_role_check_99_1 IS '${marker}';
				CREATE TABLE public.logbook_role_check_97_1 (tenant_id text, value text, payload text); ALTER TABLE public.logbook_role_check_97_1 OWNER TO ${roles.owner};
				${forced("logbook_role_check_97_1")} COMMENT ON TABLE public.logbook_role_check_97_1 IS '${marker}';
				CREATE TABLE public.logbook_role_check_98_1 (value text); ALTER TABLE public.logbook_role_check_98_1 OWNER TO ${roles.owner}`);
			await configure();
			expect((await setup.query("SELECT relname FROM pg_class WHERE relname LIKE 'logbook_role_check_%' ORDER BY relname")).rows)
				.toEqual([{ relname: "logbook_role_check_97_1" }, { relname: "logbook_role_check_98_1" }]);
			await setup.query("DROP TABLE public.logbook_role_check_97_1, public.logbook_role_check_98_1");
			const migrationSession = await setup.connect();
			try {
				await migrationSession.query(`SET SESSION AUTHORIZATION ${roles.migration}`);
				await expect(migrationSession.query(`SET ROLE ${roles.owner}`)).resolves.toBeDefined();
			} finally {
				await migrationSession.query("RESET ROLE; RESET SESSION AUTHORIZATION");
				migrationSession.release();
			}
		} finally {
			factory.mockRestore();
		}
	} finally {
		await operator?.end();
		await setup?.end();
		await admin.query(`DROP DATABASE IF EXISTS ${database}`);
		for (const role of [roles.runtime, roles.migration, roles.owner, operatorSql, databaseOwner]) await admin.query(`DROP ROLE IF EXISTS ${role}`);
		await admin.end();
	}
});