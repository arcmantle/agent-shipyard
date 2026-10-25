import { formatUnsupportedSourceProfile } from "@agent-issues/core";
import { migrations } from "../migrations/index.js";
import { transformLegacyPostgresV7 } from "../migrations/legacy-v7-direct.js";
import { schema } from "../schema.js";
import { runMigrationsWithClient } from "./migration-runner.js";
import { inspectPgSourceProfile } from "./source-profile.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { ManagedIdentityCredential } from "@azure/identity";

export { installInstructionBundle } from "../features/instructions/install-bundle.js";

export type PgConnectionOptions = {
	connectionString: string;
	managedIdentityClientId?: string;
	connectionTimeoutMillis?: number;
	queryTimeoutMillis?: number;
};

export type QueryExecutor = Pick<PoolClient, "query">;
export type TenantExecutor = NodePgDatabase<typeof schema> & QueryExecutor & {
	/**
	 * The tenant this transaction is scoped to (ADR9's `SET LOCAL
	 * app.tenant_id`), carried on the executor so the free functions below
	 * read it the same way local's free functions read `SqliteConnection.tenantId`
	 * instead of taking it as a parameter.
	 */
	tenantId: string;
	/**
	 * The client-resolved project identity this transaction is scoped to
	 * (ISS183), carried on the executor so the free functions below can read
	 * it the same way local's read it off `SqliteConnection`.
	 */
	projectIdentity?: string;
	/**
	 * The project every project-scoped read filters by - local's
	 * `SqliteConnection.currentProjectId`, matching its plain-string shape.
	 * `PgStore.transaction()` resolves and assigns it before running the
	 * request body, so callers below never observe an unresolved value; empty
	 * means no project in scope, exactly as `tenantWideTransaction` leaves it
	 * for the callers that legitimately span every project: project discovery
	 * (which lists the projects you would pick from), tenant administration,
	 * and whole-tenant synchronize.
	 */
	currentProjectId: string;
};

export function createPgPool(options: PgConnectionOptions): Pool {
	const credential = options.managedIdentityClientId ? new ManagedIdentityCredential({ clientId: options.managedIdentityClientId }) : undefined;
	const password = credential ? async () => {
		try {
			const token = await credential.getToken("https://ossrdbms-aad.database.windows.net/.default", { abortSignal: AbortSignal.timeout(2000) });
			if (!token?.token || token.expiresOnTimestamp <= Date.now()) throw new Error("Invalid database token.");
			return token.token;
		} catch {
			throw new Error("Managed database authentication failed.");
		}
	} : undefined;
	return new Pool({
		...(password ? parseIntoClientConfig(options.connectionString) : { connectionString: options.connectionString }),
		...(password ? { password } : {}),
		connectionTimeoutMillis: options.connectionTimeoutMillis,
		query_timeout: options.queryTimeoutMillis
	});
}

/** Runs pending ADR43-runner migrations (schema + RLS policies) against the pool's target database. */
export async function migratePgDatabase(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema()))");
				const sourceProfile = await inspectPgSourceProfile(client, [...migrations.map(({ id }) => id), "legacy-v7-direct"]);
		if (!sourceProfile.supported) {
			throw new Error(formatUnsupportedSourceProfile(sourceProfile));
		}
		if (sourceProfile.profile === "empty") {
			await runMigrationsWithClient(client, migrations, { transactionIsManagedByCaller: true });
		} else if (sourceProfile.profile === "legacy-postgres-v7") {
			await transformLegacyPostgresV7(client);
			await runMigrationsWithClient(client, migrations, { transactionIsManagedByCaller: true });
		} else if (sourceProfile.profile === "current-final") {
			await runMigrationsWithClient(client, migrations, { transactionIsManagedByCaller: true });
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

/**
 * The single place `SET LOCAL app.tenant_id` is applied (ADR9, ADR13): opens
 * a transaction, scopes it to `tenantId` for RLS, runs `fn`, then commits.
 * Every `PgStore` operation goes through this so tenant isolation can never
 * be forgotten on any individual query path.
 */
export async function withTenantTransaction<T>(
	pool: Pool,
	tenantId: string,
	fn: (executor: TenantExecutor) => Promise<T>,
	projectIdentity?: string
): Promise<T> {
	const client = await pool.connect();

	try {
		await client.query("BEGIN");
		await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
		const executor: TenantExecutor = Object.assign(drizzle(client, { schema }), {
			query: client.query.bind(client),
			tenantId,
			projectIdentity,
			currentProjectId: ""
		});
		const result = await fn(executor);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
