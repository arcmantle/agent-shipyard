import { sql } from "drizzle-orm";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Migration } from "./migration-runner.js";
import { createSqliteUpgradeBackup, runMigrations } from "./migration-runner.js";
import { createSqliteExecutor } from "./sqlite-executor.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("runMigrations", () => {
	it("does not copy a backup when the WAL checkpoint is incomplete", () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-busy-backup-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = createSqliteExecutor(dbPath);
		const pragma = vi.spyOn(db.drizzle, "all").mockReturnValue([{ busy: 1, log: 2, checkpointed: 1 }] as never);
		const prepareBackup = createSqliteUpgradeBackup(db, dbPath);

		try {
			expect(prepareBackup).toThrow(/WAL checkpoint.*busy/i);
			expect(() => readdirSync(path.join(tempDir, "backups"))).toThrow();
		} finally {
			pragma.mockRestore();
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("shares one exact backup between direct upgrade work and later forward migrations", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-upgrade-backup-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = createSqliteExecutor(dbPath);
		db.drizzle.run(sql.raw("CREATE TABLE existing_rows (id TEXT PRIMARY KEY)"));
		db.drizzle.run(sql.raw("INSERT INTO existing_rows VALUES ('before-upgrade')"));
		db.drizzle.all(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)"));
		const sourceBytes = statSync(dbPath).size;
		const prepareBackup = createSqliteUpgradeBackup(db, dbPath);

		try {
			const firstBackup = prepareBackup();
			await runMigrations(db, [{
				id: "0001-forward-after-direct",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
				}
			}], { prepareBackup });

			expect(readdirSync(path.join(tempDir, "backups"))).toHaveLength(1);
			expect(statSync(firstBackup).size).toBe(sourceBytes);
			expect(db.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations`)).toEqual([{ id: "0001-forward-after-direct" }]);
		} finally {
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("applies an unapplied migration once and records it in the ledger", async () => {
		const db = createSqliteExecutor(":memory:");
		let runCount = 0;
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					runCount += 1;
				}
			}
		];

		await runMigrations(db, migrations);
		await runMigrations(db, migrations);

		expect(runCount).toBe(1);
		expect(db.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations`)).toEqual([{ id: "0001-create-widgets" }]);
	});

	it("applies only the new migrations, in order, when the module list grows", async () => {
		const db = createSqliteExecutor(":memory:");
		const applied: string[] = [];
		const firstBatch: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					applied.push("0001-create-widgets");
				}
			}
		];

		await runMigrations(db, firstBatch);

		const secondBatch: Migration[] = [
			...firstBatch,
			{
				id: "0002-create-gadgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE gadgets (id TEXT PRIMARY KEY)`);
					applied.push("0002-create-gadgets");
				}
			}
		];

		await runMigrations(db, secondBatch);

		expect(applied).toEqual(["0001-create-widgets", "0002-create-gadgets"]);
		expect(db.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations ORDER BY id`)).toEqual([
			{ id: "0001-create-widgets" },
			{ id: "0002-create-gadgets" }
		]);
	});

	it("rolls back a failing migration and leaves it unrecorded so it retries next run", async () => {
		const db = createSqliteExecutor(":memory:");
		const migrations: Migration[] = [
			{
				id: "0001-partial-failure",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
					await conn.run(sql`INSERT INTO widgets (id) VALUES ('w1')`);
					throw new Error("boom");
				}
			}
		];

		await expect(runMigrations(db, migrations)).rejects.toThrow("boom");

		expect(db.drizzle.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'`)).toBeUndefined();
		expect(db.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations`)).toEqual([]);
	});

	it("creates one readable backup before applying many pending migrations", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-migration-runner-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = createSqliteExecutor(dbPath);
		db.drizzle.run(sql.raw("CREATE TABLE existing_rows (id TEXT PRIMARY KEY)"));
		db.drizzle.run(sql.raw("INSERT INTO existing_rows VALUES ('before-upgrade')"));
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
				}
			},
			{
				id: "0002-create-gadgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE gadgets (id TEXT PRIMARY KEY)`);
				}
			}
		];

		try {
			await runMigrations(db, migrations, { dbPath });

			const backupDirectory = path.join(tempDir, "backups");
			const backups = readdirSync(backupDirectory);
			expect(backups).toHaveLength(1);
			const backupPath = path.join(backupDirectory, backups[0]!);
			expect(statSync(backupPath).size).toBeGreaterThan(0);
			const backup = new Database(backupPath, { readonly: true });
			try {
				expect(backup.prepare("SELECT id FROM existing_rows").all()).toEqual([{ id: "before-upgrade" }]);
				expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('widgets', 'gadgets')").all()).toEqual([]);
			} finally {
				backup.close();
			}
		} finally {
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("keeps one exact readable pre-upgrade backup when a later migration fails", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-migration-failure-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = createSqliteExecutor(dbPath);
		db.drizzle.run(sql.raw("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"));
		db.drizzle.run(sql.raw("CREATE TABLE existing_rows (id TEXT PRIMARY KEY)"));
		db.drizzle.run(sql.raw("INSERT INTO existing_rows VALUES ('before-upgrade')"));
		db.drizzle.all(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)"));
		const preUpgradeBytes = statSync(dbPath).size;
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
				}
			},
			{
				id: "0002-fail-after-write",
				up: async (conn) => {
					await conn.run(sql`CREATE TABLE gadgets (id TEXT PRIMARY KEY)`);
					throw new Error("later migration failed");
			}
			}
		];

		try {
			await expect(runMigrations(db, migrations, { dbPath })).rejects.toThrow("later migration failed");

			const backupDirectory = path.join(tempDir, "backups");
			const backups = readdirSync(backupDirectory);
			expect(backups).toHaveLength(1);
			const backupPath = path.join(backupDirectory, backups[0]!);
			expect(statSync(backupPath).size).toBe(preUpgradeBytes);
			const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
			try {
				expect(backup.prepare("SELECT id FROM existing_rows").all()).toEqual([{ id: "before-upgrade" }]);
				expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('widgets', 'gadgets')").all()).toEqual([]);
				expect(backup.prepare("SELECT id FROM schema_migrations").all()).toEqual([]);
			} finally {
				backup.close();
			}
			expect(db.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations ORDER BY id`)).toEqual([{ id: "0001-create-widgets" }]);
			expect(db.drizzle.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'`)).toEqual({ name: "widgets" });
			expect(db.drizzle.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gadgets'`)).toBeUndefined();
		} finally {
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("does not overwrite the prior backup when a failed migration retries at the same time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-migration-retry-"));
		const dbPath = path.join(tempDir, "test.db");
		const db = createSqliteExecutor(dbPath);
		const migrations: Migration[] = [
			{
				id: "0001-fails",
				up: async () => {
					throw new Error("boom");
				}
			}
		];

		try {
			await expect(runMigrations(db, migrations, { dbPath })).rejects.toThrow("boom");
			await expect(runMigrations(db, migrations, { dbPath })).rejects.toThrow("boom");

			const backups = readdirSync(path.join(tempDir, "backups"));
			expect(backups).toHaveLength(2);
		} finally {
			db.close();
			rmSync(tempDir, { force: true, recursive: true });
		}
	});
});
