import type { Migration, MigrationConn, MigrationEngine } from "@agent-issues/core";
import { runMigrationSequence } from "@agent-issues/core";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

export type { Migration };

const LEDGER_TABLE = "schema_migrations";

/**
 * The Postgres-specific half of the ADR43 runner (ISS173/ISS174): a thin
 * `MigrationEngine` adapter around a single checked-out `pg` client, driven
 * by the one shared `runMigrationSequence` algorithm in `@agent-issues/core`.
 * Has no file-level equivalent to SQLite's backup, so `backup()` is a no-op;
 * `withTransaction` issues `BEGIN` plus a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock`) in place of a backup, serializing concurrent
 * runners against the same migration id so only one applies it. The ledger
 * itself still talks to the raw client directly (not through
 * `MigrationConn`), since the ledger is the engine's own bookkeeping, not
 * migration content.
 */
class PgMigrationEngine implements MigrationEngine {
	constructor(
		private readonly client: PoolClient,
		private readonly transactionIsManagedByCaller: boolean
	) {}

	async ensureLedgerTable(): Promise<void> {
		await this.client.query(`
			CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
				id TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
	}

	async isApplied(id: string): Promise<boolean> {
		const { rowCount } = await this.client.query(`SELECT 1 FROM ${LEDGER_TABLE} WHERE id = $1`, [id]);
		return (rowCount ?? 0) > 0;
	}

	async recordApplied(id: string): Promise<void> {
		await this.client.query(`INSERT INTO ${LEDGER_TABLE} (id, applied_at) VALUES ($1, clock_timestamp())`, [id]);
	}

	async backup(): Promise<void> {
		// No-op: Postgres has no file-level equivalent to SQLite's snapshot
		// copy. The advisory lock taken in `withTransaction` is this driver's
		// concurrent-runner guard instead (ADR43).
	}

	async withTransaction<T>(migrationId: string, fn: () => Promise<T>): Promise<T> {
		if (this.transactionIsManagedByCaller) {
			return fn();
		}
		await this.client.query("BEGIN");
		try {
			// Advisory-locked in place of a file-copy backup (Postgres has no
			// equivalent to SQLite's file-level snapshot); serializes concurrent
			// runners against the same migration so only one applies it.
			await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationId]);
			const result = await fn();
			await this.client.query("COMMIT");
			return result;
		} catch (error) {
			await this.client.query("ROLLBACK");
			throw error;
		}
	}
}

/**
 * Builds the `MigrationConn` every migration module's `up()` receives
 * (ISS174): a thin wrapper around `drizzle-orm/node-postgres`'s `execute`,
 * so migration content issues only dialect-agnostic `sql`-tagged-template
 * statements, never a raw `pg` call. Exported (beyond `runMigrations`'s own
 * use) so tests calling a migration's `.up()` directly - bypassing the
 * runner's ledger - can build the same conn shape real runs use.
 */
export function createPgMigrationConn(client: PoolClient): MigrationConn {
	const drizzleDb = drizzle(client);
	return {
		dialect: "postgres",
		async run(query: SQL) {
			await drizzleDb.execute(query);
		},
		async all<T>(query: SQL) {
			const result = await drizzleDb.execute(query);
			return result.rows as T[];
		}
	};
}

/**
 * Applies every migration in `migrations` that has not yet run against
 * `pool`'s database, in order, recording each applied id in a
 * `schema_migrations` ledger so later runs skip it. Replaces drizzle-kit's
 * `__drizzle_migrations` ledger and the bespoke `project_migrations` table
 * (ADR43). Delegates its control flow to the shared `runMigrationSequence`
 * (ISS173); this function is only the Postgres driver adapter plus its
 * familiar call shape.
 */
export async function runMigrations(pool: Pool, migrations: Migration[]): Promise<void> {
	const client = await pool.connect();
	try {
		await runMigrationsWithClient(client, migrations);
	} finally {
		client.release();
	}
}

export async function runMigrationsWithClient(
	client: PoolClient,
	migrations: Migration[],
	options?: { transactionIsManagedByCaller?: boolean }
): Promise<void> {
	const engine = new PgMigrationEngine(client, options?.transactionIsManagedByCaller === true);
	const conn = createPgMigrationConn(client);
	await runMigrationSequence(migrations, engine, conn);
}
