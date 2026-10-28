import type { Pool, PoolClient } from "pg";

export type PgRoles = { owner: string; migration: string; runtime: string };

/** Grants the runtime role only the reviewed table access; the caller's transaction must act as the schema owner. */
async function applyRuntimeTablePrivileges(client: PoolClient, roles: PgRoles): Promise<void> {
	await client.query(`REVOKE ALL ON SCHEMA public FROM ${roles.runtime}, ${roles.migration}`);
	await client.query(`GRANT USAGE ON SCHEMA public TO ${roles.runtime}`);
	await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} REVOKE ALL ON TABLES FROM ${roles.runtime}, PUBLIC`);
	await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA public REVOKE ALL ON TABLES FROM ${roles.runtime}`);
	await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC`);
	await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roles.runtime}, PUBLIC`);
	const columnGrants = await client.query(`SELECT relation.relname, attribute.attname FROM pg_attribute attribute
		JOIN pg_class relation ON relation.oid = attribute.attrelid WHERE relation.relnamespace = 'public'::regnamespace
		AND attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attacl IS NOT NULL`);
	for (const column of columnGrants.rows) {
		const table = client.escapeIdentifier(column.relname);
		const name = client.escapeIdentifier(column.attname);
		await client.query(`REVOKE ALL (${name}) ON public.${table} FROM ${roles.runtime}, PUBLIC`);
	}
	const tables = await client.query(`SELECT relname, relrowsecurity AND relforcerowsecurity AS tenant_scoped
		FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
		AND ((relrowsecurity AND relforcerowsecurity) OR relname IN ('instruction_bundles', 'instruction_defaults'))`);
	for (const table of tables.rows) {
		const quotedTable = `"${(table.relname as string).replaceAll('"', '""')}"`;
		const privileges = table.tenant_scoped ? "SELECT, INSERT, UPDATE, DELETE" : "SELECT";
		await client.query(`GRANT ${privileges} ON public.${quotedTable} TO ${roles.runtime}`);
	}
}
export type PgRolePasswords = { migration: string; runtime: string };
export type PgEntraPrincipals = { tenantId: string; migrationObjectId: string; runtimeObjectId: string; administrationRole: string };

export async function verifyPgRuntimeRole(pool: Pool): Promise<void> {
	const result = await pool.query(`SELECT current_user = session_user
		AND NOT (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls OR role.rolinherit)
		AND role.rolcanlogin
		AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid)
		AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = role.oid)
		AND NOT has_database_privilege(current_database(), 'CREATE, TEMP')
		AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
			AND (nspowner = role.oid OR has_schema_privilege(oid, 'CREATE')))
		AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
			AND (relowner = role.oid OR (relkind IN ('r', 'p', 'v', 'm', 'f') AND (
				has_table_privilege(relation.oid, 'TRUNCATE, REFERENCES, TRIGGER')
				OR has_any_column_privilege(relation.oid, 'REFERENCES')
				OR CASE
					WHEN relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity AND relforcerowsecurity THEN false
					WHEN relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname IN ('instruction_bundles', 'instruction_defaults') THEN
						has_table_privilege(relation.oid, 'INSERT, UPDATE, DELETE') OR has_any_column_privilege(relation.oid, 'INSERT, UPDATE')
					ELSE has_table_privilege(relation.oid, 'SELECT, INSERT, UPDATE, DELETE') OR has_any_column_privilege(relation.oid, 'SELECT, INSERT, UPDATE') END)))) AS restricted
		FROM pg_roles role WHERE rolname = current_user`);
	if (result.rows[0]?.restricted !== true) throw new Error("Database runtime permissions are not restricted.");
}

export async function configurePgRoles(pool: Pool, roles: PgRoles, passwords?: PgRolePasswords): Promise<void> {
	return configureRoles(pool, roles, passwords);
}

export const roleSetupStages = ["check administration role", "list Entra principals", "create Entra principals", "restrict Entra principals",
	"create database roles", "grant schema owner to setup", "transfer public schema",
	"grant migration owner membership", "grant database connect", "apply schema privileges"] as const;
export type RoleSetupStage = (typeof roleSetupStages)[number];
export type RoleAttributes = { session_createrole: boolean; administration_createrole: boolean; session_inherits_administration: boolean;
	database_owner_is_administration?: boolean; public_schema_owner_is_administration?: boolean; session_can_grant_database_create?: boolean;
	administration_can_grant_database_create?: boolean; session_can_set_administration?: boolean; session_can_set_database_owner?: boolean };

export async function configurePgEntraRoles(pool: Pool, roles: PgRoles, principals: PgEntraPrincipals, registrationPool: Pool = pool,
	track: (stage: RoleSetupStage) => void = () => {}): Promise<void> {
	const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
	if (![principals.tenantId, principals.migrationObjectId, principals.runtimeObjectId].every((value) => identifier.test(value))
		|| !/^[a-z][a-z0-9_]{0,62}$/.test(principals.administrationRole) || principals.administrationRole.startsWith("pg_")
		|| Object.values(roles).includes(principals.administrationRole)
		|| principals.migrationObjectId.toLowerCase() === principals.runtimeObjectId.toLowerCase()) {
		throw new Error("Database principals must have distinct object IDs and a valid tenant ID.");
	}
	const names = Object.values(roles);
	if (names.length !== 3 || new Set(names).size !== 3 || names.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith("pg_"))) {
		throw new Error("Database roles must have distinct, valid names.");
	}
	// Azure installs pgaadauth only in the postgres database; role mappings are server-wide.
	track("check administration role");
	const attributes: RoleAttributes = (await registrationPool.query(`SELECT
		COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user), false) AS session_createrole,
		COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = $1), false) AS administration_createrole,
		COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = $1), 'USAGE'), false) AS session_inherits_administration`,
		[principals.administrationRole])).rows[0];
	Object.assign(attributes, (await pool.query(`SELECT
		COALESCE((SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = $1) FROM pg_database WHERE datname = current_database()), false) AS database_owner_is_administration,
		COALESCE((SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = $1) FROM pg_namespace WHERE nspname = 'public'), false) AS public_schema_owner_is_administration,
		has_database_privilege(current_user, current_database(), 'CREATE WITH GRANT OPTION') AS session_can_grant_database_create,
		COALESCE(has_database_privilege($1, current_database(), 'CREATE WITH GRANT OPTION'), false) AS administration_can_grant_database_create,
		COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = $1), 'SET'), false) AS session_can_set_administration,
		COALESCE(pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'SET'), false) AS session_can_set_database_owner`,
		[principals.administrationRole])).rows[0]);
	try {
		await registerEntraPrincipals(registrationPool, roles, principals, track);
		return await configureRoles(pool, roles, undefined, principals, track);
	} catch (error) {
		if (error instanceof Error) Object.assign(error, { roleAttributes: attributes });
		throw error;
	}
}

async function registerEntraPrincipals(pool: Pool, roles: PgRoles, principals: PgEntraPrincipals, track: (stage: RoleSetupStage) => void): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL lock_timeout = '5s'");
		await client.query("SET LOCAL statement_timeout = '30s'");
		await client.query("SELECT pg_advisory_xact_lock(hashtext('logbook-role-setup'))");
		const session = (await client.query("SELECT current_user AS role")).rows[0];
		const administrator = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolcanlogin AND pg_has_role(current_user, oid, 'SET')", [principals.administrationRole]);
		if (!administrator.rowCount || Object.values(roles).includes(session.role)) throw new Error("Setup requires the separate server administration role.");
		// Only a Microsoft Entra administrator can create Entra principals, so this runs as the session role.
		for (const [kind, name] of Object.entries(roles)) {
			const role = (await client.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname = $1", [name])).rows[0];
			if (role && (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolinherit || role.rolcanlogin !== (kind !== "owner"))) {
				throw new Error("Database role attributes are not restricted.");
			}
		}
		track("list Entra principals");
		for (const kind of ["runtime", "migration"] as const) {
			const objectId = principals[kind === "runtime" ? "runtimeObjectId" : "migrationObjectId"];
			const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roles[kind]]);
			if (!existing.rowCount) {
				track("create Entra principals");
				await client.query("SELECT pg_catalog.pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)", [roles[kind], objectId]);
			}
			track("restrict Entra principals");
			await client.query(`ALTER ROLE ${roles[kind]} NOINHERIT PASSWORD NULL VALID UNTIL '-infinity'`);
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function configureRoles(pool: Pool, roles: PgRoles, passwords?: PgRolePasswords, principals?: PgEntraPrincipals,
	track: (stage: RoleSetupStage) => void = () => {}): Promise<void> {
	const names = Object.values(roles);
	if (names.length !== 3 || new Set(names).size !== 3 || names.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name.startsWith("pg_"))) {
		throw new Error("Database roles must have distinct, valid names.");
	}
	if (passwords && ([passwords.runtime, passwords.migration].some((value) => typeof value !== "string" || value.length < 32 || value.length > 1024 || value.includes("\0")) || passwords.runtime === passwords.migration)) {
		throw new Error("Database role passwords must be separate strong values.");
	}
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL lock_timeout = '5s'");
		await client.query("SET LOCAL statement_timeout = '30s'");
		await client.query("SELECT pg_advisory_xact_lock(hashtext('logbook-role-setup'))");
		const session = (await client.query("SELECT current_database() AS name, current_user AS role")).rows[0];
		if (principals) {
			const administrator = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolcanlogin AND pg_has_role(current_user, oid, 'SET')", [principals.administrationRole]);
			if (!administrator.rowCount || names.includes(session.role)) throw new Error("Setup requires the separate server administration role.");
			const registered = await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname = ANY($1::text[])", [[roles.runtime, roles.migration]]);
			if (registered.rows[0]?.count !== 2) throw new Error("Database principal mapping differs from the approved identity.");
		}
		for (const [kind, name] of Object.entries(roles)) {
			track("create database roles");
			const existing = await client.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname = $1", [name]);
			if (existing.rowCount === 0) {
				await client.query(`CREATE ROLE ${name} ${kind === "owner" ? "NOLOGIN" : "LOGIN"} NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
			} else {
				const role = existing.rows[0];
				if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolinherit || role.rolcanlogin !== (kind !== "owner")) {
					throw new Error("Database role attributes are not restricted.");
				}
			}
		}
		if (principals) {
			track("grant schema owner to setup");
			await client.query(`GRANT ${roles.owner} TO ${client.escapeIdentifier(session.role)} WITH INHERIT FALSE, SET TRUE`);
		}
		const memberships = await client.query(`SELECT member_role.rolname AS member, parent.rolname AS parent
			FROM pg_auth_members membership JOIN pg_roles member_role ON member_role.oid = membership.member
			JOIN pg_roles parent ON parent.oid = membership.roleid
			WHERE member_role.rolname = ANY($1::text[]) OR parent.rolname = ANY($1::text[])`, [names]);
		if (memberships.rows.some((membership) => {
			if (membership.member === roles.migration && membership.parent === roles.owner) return false;
			if (principals && membership.member === principals.administrationRole && names.includes(membership.parent)) return false;
			return names.includes(membership.member) || membership.member !== session.role;
		})) {
			throw new Error("Database roles have unexpected memberships.");
		}
		const database = session.name as string;
		const quotedDatabase = `"${database.replaceAll('"', '""')}"`;
		const ownership = await client.query(`SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
			AND relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND relowner <> $1::regrole
			UNION ALL SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = ANY($2::regrole[])`, [roles.owner, [roles.runtime, roles.migration]]);
		if (ownership.rowCount) throw new Error("Database objects must use the separate schema owner.");
		const unsafeTables = await client.query(`SELECT 1 FROM pg_class relation JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
			WHERE relation.relnamespace = 'public'::regnamespace AND relation.relkind IN ('r', 'p')
			AND attribute.attname = 'tenant_id' AND NOT attribute.attisdropped
			AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)`);
		if (unsafeTables.rowCount) throw new Error("Tenant tables require forced row-level security.");
		const outsideAccess = await client.query(`SELECT 1 FROM pg_class relation
			JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname !~ '^pg_' AND namespace.nspname NOT IN ('public', 'information_schema')
			AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
			AND (has_table_privilege($1, relation.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
				OR has_any_column_privilege($1, relation.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`, [roles.runtime]);
		if (outsideAccess.rowCount) throw new Error("Runtime access outside the application schema is not permitted.");
		track("transfer public schema");
		const databaseOwner = (await client.query("SELECT owner.rolname AS owner FROM pg_database database JOIN pg_roles owner ON owner.oid = database.datdba WHERE database.datname = current_database()")).rows[0].owner as string;
		// Database ACL changes take effect only when made by the database owner.
		if (principals) await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(databaseOwner)}`);
		await client.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM PUBLIC`);
		if (principals) await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(session.role)}`);
		await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
		await client.query(`ALTER SCHEMA public OWNER TO ${roles.owner}`);
		track("grant migration owner membership");
		await client.query(`GRANT ${roles.owner} TO ${roles.migration} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
		track("grant database connect");
		if (principals) await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(databaseOwner)}`);
		for (const name of [roles.migration, roles.runtime]) {
			await client.query(`REVOKE ALL ON DATABASE ${quotedDatabase} FROM ${name}`);
			await client.query(`GRANT CONNECT ON DATABASE ${quotedDatabase} TO ${name}`);
		}
		track("apply schema privileges");
		await client.query(`SET LOCAL ROLE ${roles.owner}`);
		await applyRuntimeTablePrivileges(client, roles);
		await client.query(`SET LOCAL ROLE ${client.escapeIdentifier(session.role)}`);
		if (passwords) {
			await client.query("SET LOCAL password_encryption = 'scram-sha-256'");
			for (const kind of ["runtime", "migration"] as const) {
				await client.query(`ALTER ROLE ${roles[kind]} PASSWORD ${client.escapeLiteral(passwords[kind])}`);
			}
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}