import { sql, type SQL } from "drizzle-orm";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { runMigrationSequence, type Migration, type MigrationConn, type MigrationEngine } from "@agent-issues/core";
import type { SqliteInternalConnection } from "./sqlite-executor.js";

const LEDGER_TABLE = "schema_migrations";

export type { Migration };

export type RunMigrationsOptions = {
	/**
	 * Path to the on-disk database file. When supplied, a timestamped copy is
	 * taken once before applying the pending upgrade sequence (ADR13's
	 * pre-upgrade backup guarantee, folded into ADR43). Omit for in-memory
	 * or throwaway databases where a backup has nothing to protect.
	 */
	dbPath?: string;
	/** Shared preparation callback when other upgrade work runs before this sequence. */
	prepareBackup?: () => void;
};

/**
 * The SQLite-specific half of the ADR43 runner (ISS173/ISS174): a thin
 * `MigrationEngine` adapter around `better-sqlite3`, driven by the one
 * shared `runMigrationSequence` algorithm in `./migration-engine.js`. Drives
 * its transaction boundary with raw `BEGIN`/`COMMIT`/`ROLLBACK` rather than
 * `db.transaction()`, since that helper only supports a synchronous callback
 * and would commit before an `async` callback's awaited steps actually ran -
 * every statement issued inside is still a plain synchronous `better-sqlite3`
 * call either way, so this preserves identical atomicity. The ledger itself
 * still talks to the raw handle directly (not through `MigrationConn`),
 * since the ledger is the engine's own bookkeeping, not migration content.
 */
class SqliteMigrationEngine implements MigrationEngine {
	constructor(
		db: SqliteInternalConnection,
		prepareBackup?: () => void
	) {
		this.db = db;
		this.prepareBackup = prepareBackup;
	}

	protected readonly db: SqliteInternalConnection;
	protected readonly prepareBackup?: () => void;

	async ensureLedgerTable(): Promise<void> {
		this.db.drizzle.run(sql.raw(`
			CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
				id TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL
			)
		`));
	}

	async isApplied(id: string): Promise<boolean> {
		return this.db.drizzle.get(sql`SELECT 1 FROM ${sql.identifier(LEDGER_TABLE)} WHERE id = ${id}`) !== undefined;
	}

	async recordApplied(id: string): Promise<void> {
		this.db.drizzle.run(sql`INSERT INTO ${sql.identifier(LEDGER_TABLE)} (id, applied_at) VALUES (${id}, ${new Date().toISOString()})`);
	}

	async backup(): Promise<void> {
		this.prepareBackup?.();
	}

	async withTransaction<T>(_migrationId: string, fn: () => Promise<T>): Promise<T> {
		this.db.drizzle.run(sql.raw("BEGIN"));
		try {
			const result = await fn();
			this.db.drizzle.run(sql.raw("COMMIT"));
			return result;
		} catch (error) {
			this.db.drizzle.run(sql.raw("ROLLBACK"));
			throw error;
		}
	}
}

export function backupSqliteDatabase(db: SqliteInternalConnection, dbPath: string): string {
	const [checkpoint] = db.drizzle.all(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)")) as Array<{
		busy: number;
		log: number;
		checkpointed: number;
	}>;
	if (checkpoint?.busy !== 0) {
		throw new Error(`SQLite WAL checkpoint remained busy before backup: ${JSON.stringify(checkpoint)}`);
	}
	const backupsDirectory = path.join(path.dirname(dbPath), "backups");
	mkdirSync(backupsDirectory, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPrefix = path.join(backupsDirectory, `${path.basename(dbPath, path.extname(dbPath))}-${timestamp}`);
	let backupPath = `${backupPrefix}.db`;
	let suffix = 1;
	while (existsSync(backupPath)) {
		backupPath = `${backupPrefix}-${suffix}.db`;
		suffix += 1;
	}
	copyFileSync(dbPath, backupPath);
	return backupPath;
}

export function createSqliteUpgradeBackup(db: SqliteInternalConnection, dbPath: string): () => string {
	let backupPath: string | undefined;
	return () => {
		backupPath ??= backupSqliteDatabase(db, dbPath);
		return backupPath;
	};
}

/**
 * Builds the `MigrationConn` every migration module's `up()` receives
 * (ISS174): a thin wrapper around `drizzle-orm/better-sqlite3`'s `run`/`all`,
 * so migration content issues only dialect-agnostic `sql`-tagged-template
 * statements, never a raw `better-sqlite3` call.
 */
export function createSqliteMigrationConn(db: SqliteInternalConnection): MigrationConn {
	return {
		dialect: "sqlite",
		async run(query: SQL) {
			db.drizzle.run(query);
		},
		async all<T>(query: SQL) {
			return db.drizzle.all<T>(query);
		}
	};
}

/**
 * Applies every pending migration in order and records each id in the
 * `schema_migrations` ledger. When `dbPath` is supplied, the shared sequence
 * takes one pre-upgrade backup before any pending migration while preserving
 * the per-migration transaction and ledger boundaries. Delegates control flow
 * to `runMigrationSequence` (ISS173); this function supplies only the SQLite
 * adapter and its familiar call shape.
 */
export async function runMigrations(
	db: SqliteInternalConnection,
	migrations: Migration[],
	options?: RunMigrationsOptions
): Promise<void> {
	const prepareBackup = options?.prepareBackup
		?? (options?.dbPath ? createSqliteUpgradeBackup(db, options.dbPath) : undefined);
	const engine = new SqliteMigrationEngine(db, prepareBackup);
	const conn = createSqliteMigrationConn(db);
	await runMigrationSequence(migrations, engine, conn);
}
