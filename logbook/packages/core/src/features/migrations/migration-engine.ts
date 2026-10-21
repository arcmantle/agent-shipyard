import type { SQL } from "drizzle-orm";

/**
 * The one shared migration *content* abstraction (ISS174): every migration
 * module in both `packages/core` and `packages/api-pg` issues its DDL/DML
 * through this one `MigrationConn`, never through a raw `better-sqlite3` or
 * `pg` call. `run`/`all` are backed by `drizzle-orm`'s dialect-agnostic
 * `sql` tagged template - the same template text (including parameterized
 * values and `ON CONFLICT ... DO NOTHING` upsert syntax) executes unchanged
 * against both dialects; only the adapter that constructs this object
 * (`SqliteMigrationEngine`/`PgMigrationEngine`) differs per package.
 */
export type MigrationConn = {
	readonly dialect: "sqlite" | "postgres";
	/** Issues a statement with no rows expected back (DDL, INSERT/UPDATE/DELETE). */
	run(query: SQL): Promise<void>;
	/** Issues a statement and returns its result rows (SELECT). */
	all<T = unknown>(query: SQL): Promise<T[]>;
};

/**
 * The one shared migration control-flow algorithm (ADR43), driven against
 * either driver (SQLite: `packages/core/src/migration-runner.ts`, Postgres:
 * `packages/api-pg/src/db/migration-runner.ts`) through a small adapter -
 * `MigrationEngine` - instead of being duplicated per package.
 *
 * Only the driver adapter differs between packages (ledger check, backup
 * mechanism, transaction/lock boundary); the loop, the
 * skip-if-already-applied check, and the double-checked-locking shape that
 * lets Postgres's advisory lock genuinely guard concurrent runners are all
 * expressed exactly once, here.
 */
export type Migration = {
	id: string;
	up: (conn: MigrationConn) => Promise<void>;
};

export type MigrationEngine = {
	ensureLedgerTable(): Promise<void>;
	isApplied(id: string): Promise<boolean>;
	recordApplied(id: string): Promise<void>;
	/** Prepares one backup for the pending upgrade sequence. No-ops when the driver has nothing to back up. */
	backup(): Promise<void>;
	/**
	 * Wraps `fn` in whatever transactional/locking boundary the driver needs
	 * before applying a migration (SQLite: explicit `BEGIN`/`COMMIT`; Postgres:
	 * `BEGIN` + `pg_advisory_xact_lock`, so concurrent runners against the
	 * same database serialize on this specific migration id).
	 */
	withTransaction<T>(migrationId: string, fn: () => Promise<T>): Promise<T>;
};

/**
 * Applies every migration in `migrations` that has not yet run, in order,
 * against `conn`, recording each applied id via the engine's ledger so later
 * runs skip it (ADR43). Prepares one backup before the first pending migration,
 * then preserves a separate transaction and ledger write for each migration.
 * Re-checks `isApplied` once more inside the
 * transaction/lock boundary immediately before applying, so a driver whose
 * `withTransaction` provides a real cross-process guard (Postgres's advisory
 * lock) never double-applies a migration another concurrent runner just
 * finished.
 */
export async function runMigrationSequence(
	migrations: Migration[],
	engine: MigrationEngine,
	conn: MigrationConn
): Promise<void> {
	await engine.ensureLedgerTable();
	const pendingMigrations: Migration[] = [];

	for (const migration of migrations) {
		if (!(await engine.isApplied(migration.id))) {
			pendingMigrations.push(migration);
		}
	}

	if (pendingMigrations.length === 0) {
		return;
	}

	await engine.backup();

	for (const migration of pendingMigrations) {
		await engine.withTransaction(migration.id, async () => {
			if (await engine.isApplied(migration.id)) {
				return;
			}

			await migration.up(conn);
			await engine.recordApplied(migration.id);
		});
	}
}
