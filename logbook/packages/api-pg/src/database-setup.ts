import { createHash } from "node:crypto";

import type { Pool } from "pg";

import type { InstructionBundle } from "@agent-issues/core";

import { createPgPool, installInstructionBundle, migratePgDatabase, withTenantTransaction } from "./db/connection.js";
import { configurePgEntraRoles, roleSetupStages, verifyPgRuntimeRole, type PgRoles, type RoleAttributes } from "./db/roles.js";

type Identity = { client_id: string; principal_id: string; role: string };
type SetupConfiguration = {
	database_url: string;
	tenant_id: string;
	owner_role: string;
	verification_table: string;
	identities: Record<"setup" | "runtime" | "migration", Identity>;
};

const databaseSetupStages = ["validate configuration", "verify runtime restrictions",
	"inspect setup session", "register principals and grant roles", "create migration probe as schema owner",
	"verify tenant isolation", "verify runtime privilege denial", "remove temporary setup privileges", "run schema migrations as schema owner",
	"install instruction defaults as schema owner", ...roleSetupStages] as const;

type DatabaseSetupFailure = Error & { stage?: string; cleanupFailed?: boolean; roleAttributes?: RoleAttributes };
type DatabaseMigrationResult = { schema_migrations_before: number; schema_migrations_after: number };

export async function runDatabaseSetup(environment: NodeJS.ProcessEnv, administrationRole = "azure_pg_admin", instructionBundle?: InstructionBundle): Promise<DatabaseMigrationResult | undefined> {
	const progress = { stage: "validate configuration" };
	try {
		return await runSetupStages(environment, administrationRole, instructionBundle, (next) => { progress.stage = next; }, progress);
	} catch (error) {
		const failure = (error instanceof Error ? error : new Error("Unclassified setup failure.")) as DatabaseSetupFailure;
		failure.stage ??= progress.stage;
		throw failure;
	}
}

async function runSetupStages(environment: NodeJS.ProcessEnv, administrationRole: string, instructionBundle: InstructionBundle | undefined, track: (stage: (typeof databaseSetupStages)[number]) => void, progress: { stage: string }): Promise<DatabaseMigrationResult | undefined> {
	const configuration: SetupConfiguration = JSON.parse(environment.DATABASE_SETUP_CONFIG ?? "null");
	const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
	const roleName = /^[a-z][a-z0-9_]{0,62}$/;
	const identities = configuration && Object.values(configuration.identities ?? {});
	if (!configuration || !identifier.test(configuration.tenant_id) || identities?.length !== 3
		|| !["setup", "runtime", "migration"].every((kind) => configuration.identities[kind as keyof typeof configuration.identities])
		|| !identities.every((identity) => identifier.test(identity.client_id) && identifier.test(identity.principal_id)
			&& (identity === configuration.identities.setup ? /^[a-z][a-z0-9_-]{0,62}$/.test(identity.role) : roleName.test(identity.role)) && !identity.role.startsWith("pg_"))
		|| !roleName.test(configuration.owner_role) || configuration.owner_role.startsWith("pg_")
		|| new Set(identities.map((identity) => identity.client_id.toLowerCase())).size !== 3
		|| new Set(identities.map((identity) => identity.principal_id.toLowerCase())).size !== 3
		|| new Set([...identities.map((identity) => identity.role), configuration.owner_role]).size !== 4
		|| !/^logbook_role_check_[1-9][0-9]*_[1-9][0-9]*$/.test(configuration.verification_table)) {
		throw new Error("Invalid database setup configuration.");
	}
	const url = new URL(configuration.database_url);
	if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".postgres.database.azure.com")
		|| url.username || url.password || url.pathname !== "/logbook" || url.port
		|| url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full"
		|| [...url.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Invalid private database target.");
	const roles: PgRoles = { owner: configuration.owner_role, runtime: configuration.identities.runtime.role, migration: configuration.identities.migration.role };
	const probeMarker = `logbook-setup:${createHash("sha256").update(JSON.stringify(configuration)).digest("hex")}`;
	const pools = Object.fromEntries(Object.entries(configuration.identities).map(([kind, identity]) => {
		const connection = new URL(url);
		connection.username = identity.role;
		const pool = createPgPool({ connectionString: connection.href, managedIdentityClientId: identity.client_id, connectionTimeoutMillis: 5000, queryTimeoutMillis: 30000 });
		pool.on("error", () => { process.stderr.write("Database setup connection failed.\n"); });
		return [kind, pool];
	})) as Record<"setup" | "runtime" | "migration", Pool>;
	const registrationUrl = new URL(url);
	registrationUrl.pathname = "/postgres";
	registrationUrl.username = configuration.identities.setup.role;
	const registration = createPgPool({ connectionString: registrationUrl.href, managedIdentityClientId: configuration.identities.setup.client_id, connectionTimeoutMillis: 5000, queryTimeoutMillis: 30000 });
	registration.on("error", () => { process.stderr.write("Database setup connection failed.\n"); });
	try {
		track("inspect setup session");
		const session = (await pools.setup.query(`SELECT current_user AS role, current_database() AS database,
			EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass AND refobjid = current_user::regrole AND deptype = 'o'
				AND classid <> 'pg_database'::regclass
				AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))) AS owns_objects`)).rows[0];
		if (session?.role !== configuration.identities.setup.role || session.owns_objects) throw new Error("Setup identity changed or owns database objects.");
		let configured = false;
		let probeCreated = false;
		let primaryError: unknown;
		let result: DatabaseMigrationResult;
		try {
			const entraPrincipals = {
				administrationRole, tenantId: configuration.tenant_id, runtimeObjectId: configuration.identities.runtime.principal_id,
				migrationObjectId: configuration.identities.migration.principal_id
			};
			track("register principals and grant roles");
			await configurePgEntraRoles(pools.setup, roles, entraPrincipals, registration, track);
			configured = true;
			track("run schema migrations as schema owner");
			const before = await countAppliedMigrations();
			await migratePgDatabase(pools.migration, { role: roles.owner });
			result = { schema_migrations_before: before, schema_migrations_after: await countAppliedMigrations() };
			if (instructionBundle) {
				track("install instruction defaults as schema owner");
				await installInstructionBundle(pools.migration, instructionBundle, { role: roles.owner });
			}
			// New tables have no default runtime grants; role setup grants only the reviewed ones.
			track("register principals and grant roles");
			await configurePgEntraRoles(pools.setup, roles, entraPrincipals, registration, track);
			track("create migration probe as schema owner");
			const migration = await pools.migration.connect();
			try {
				await migration.query("BEGIN");
				await migration.query(`SET LOCAL ROLE ${roles.owner}`);
				await migration.query(`CREATE TABLE public.${configuration.verification_table} (tenant_id text NOT NULL, value text NOT NULL)`);
				await migration.query(`COMMENT ON TABLE public.${configuration.verification_table} IS ${migration.escapeLiteral(probeMarker)}`);
				await migration.query(`ALTER TABLE public.${configuration.verification_table} ENABLE ROW LEVEL SECURITY`);
				await migration.query(`ALTER TABLE public.${configuration.verification_table} FORCE ROW LEVEL SECURITY`);
				await migration.query(`CREATE POLICY tenant_check ON public.${configuration.verification_table} USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`);
				await migration.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${configuration.verification_table} TO ${roles.runtime}`);
				await migration.query("COMMIT");
				probeCreated = true;
			} catch (error) {
				await migration.query("ROLLBACK");
				throw error;
			} finally {
				migration.release(true);
			}
			track("verify runtime restrictions");
			await verifyPgRuntimeRole(pools.runtime);
			track("verify tenant isolation");
			for (const tenant of ["setup-check-a", "setup-check-b"]) {
				await withTenantTransaction(pools.runtime, tenant, async (client) => {
					await client.query(`INSERT INTO public.${configuration.verification_table} VALUES ($1, $2)`, [tenant, tenant]);
				});
			}
			for (const tenant of ["setup-check-a", "setup-check-b"]) {
				await withTenantTransaction(pools.runtime, tenant, async (client) => {
					const rows = (await client.query(`SELECT tenant_id FROM public.${configuration.verification_table}`)).rows;
					if (rows.length !== 1 || rows[0].tenant_id !== tenant) throw new Error("Tenant read isolation failed.");
					const changed = await client.query(`UPDATE public.${configuration.verification_table} SET value = 'forbidden' WHERE tenant_id <> $1`, [tenant]);
					if (changed.rowCount !== 0) throw new Error("Tenant write isolation failed.");
				});
			}
			track("verify runtime privilege denial");
			for (const statement of [`ALTER TABLE public.${configuration.verification_table} DISABLE ROW LEVEL SECURITY`, `SET ROLE ${roles.owner}`, `SET ROLE ${roles.migration}`, `CREATE ROLE logbook_forbidden_check`]) {
				try {
					await pools.runtime.query(statement);
				} catch (error) {
					if ((error as { code?: string }).code === "42501") continue;
					throw new Error("Runtime privilege denial could not be verified.");
				}
				throw new Error("Runtime privilege restriction failed.");
			}
		} catch (error) {
			if (error instanceof Error) (error as DatabaseSetupFailure).stage ??= progress.stage;
			primaryError = error;
			throw error;
		} finally {
			if (configured) {
				try {
					track("remove temporary setup privileges");
					await removeTemporarySetupPrivileges();
				} catch (cleanupError) {
					if (primaryError === undefined) throw cleanupError;
					if (primaryError instanceof Error) (primaryError as DatabaseSetupFailure).cleanupFailed = true;
				}
			}
		}
		return result;
		async function countAppliedMigrations(): Promise<number> {
			const client = await pools.migration.connect();
			try {
				await client.query("BEGIN READ ONLY");
				await client.query(`SET LOCAL ROLE ${roles.owner}`);
				const ledger = (await client.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present")).rows[0]?.present === true;
				const count = ledger ? Number((await client.query("SELECT count(*) AS applied FROM public.schema_migrations")).rows[0].applied) : 0;
				await client.query("COMMIT");
				return count;
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		}
		async function removeTemporarySetupPrivileges(): Promise<void> {
			{
				const cleanup = await pools.setup.connect();
				try {
					await cleanup.query("BEGIN");
					await cleanup.query("SET LOCAL lock_timeout = '5s'");
					await cleanup.query("SET LOCAL statement_timeout = '30s'");
					// Drop this run's probe and any probe left by an earlier failed run; only exact setup probes match.
					const probes = await cleanup.query(`SELECT relation.relname AS name FROM pg_class relation
						WHERE relation.relnamespace = 'public'::regnamespace AND relation.relkind = 'r' AND relation.relname ~ '^logbook_role_check_[0-9]+_[0-9]+$'
						AND relation.relowner = to_regrole($1) AND obj_description(relation.oid, 'pg_class') ~ '^logbook-setup:[0-9a-f]{64}$'
						AND (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid = relation.oid AND attnum > 0 AND NOT attisdropped)
							= ARRAY['tenant_id', 'value']`, [roles.owner]);
					if (probes.rows.length) {
						await cleanup.query(`SET LOCAL ROLE ${roles.owner}`);
						for (const probe of probes.rows) await cleanup.query(`DROP TABLE public.${cleanup.escapeIdentifier(probe.name)}`);
					}
					if (probeCreated && (await cleanup.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${configuration.verification_table}`])).rows[0]?.present) {
						throw new Error("Verification table does not belong to the approved setup.");
					}
					await cleanup.query(`SET LOCAL ROLE ${cleanup.escapeIdentifier(session.role)}`);
					const ownerExists = (await cleanup.query("SELECT to_regrole($1) IS NOT NULL AS present", [roles.owner])).rows[0]?.present === true;
					if (ownerExists) await cleanup.query(`REVOKE CREATE ON DATABASE ${cleanup.escapeIdentifier(session.database)} FROM ${roles.owner}`);
					// The setup identity is a permanent administrator, so its owner grants (and the migration membership they back) stay.
					const remaining = await cleanup.query("SELECT 1 WHERE has_database_privilege(to_regrole($1)::oid, current_database(), 'CREATE')", [roles.owner]);
					if (remaining.rowCount) throw new Error("Temporary database setup privileges remain.");
					await cleanup.query("COMMIT");
				} catch (error) {
					await cleanup.query("ROLLBACK");
					throw error;
				} finally {
					cleanup.release();
				}
			}
		}
	} finally {
		await Promise.all([...Object.values(pools), registration].map((pool) => pool.end()));
	}
}