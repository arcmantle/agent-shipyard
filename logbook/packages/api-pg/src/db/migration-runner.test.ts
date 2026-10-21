import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool } from "./connection.js";
import type { Migration } from "./migration-runner.js";
import { runMigrations, runMigrationsWithClient } from "./migration-runner.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// These tests create throwaway tables and ledger rows to exercise the runner.
// They get their own schema, as every other Postgres test file does, because
// otherwise they do that work in `public` - and while those fixture tables
// exist, any other test file's `migratePgDatabase` sees them in its schema
// signature and rejects the database as an unsupported source profile. The
// per-test `finally` cleanup below cannot prevent that: the objects are real
// for as long as the test runs, and test files run concurrently.
const schemaName = `migration_runner_${randomUUID().replace(/-/g, "_")}`;

describe("runMigrations (Postgres)", () => {
	let pool: Pool;
	let adminPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
	});

	afterAll(async () => {
		await pool.end();
		await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		await adminPool.end();
	});

	it("applies an unapplied migration once and records it in the ledger", async () => {
		const tableName = `widgets_${randomUUID().replace(/-/g, "_")}`;
		const migrationId = `test-${randomUUID()}`;
		let runCount = 0;
		const migrations: Migration[] = [
			{
				id: migrationId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`));
					runCount += 1;
				}
			}
		];

		try {
			await runMigrations(pool, migrations);
			await runMigrations(pool, migrations);

			expect(runCount).toBe(1);
			const { rows } = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [migrationId]);
			expect(rows).toEqual([{ id: migrationId }]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = $1`, [migrationId]);
		}
	});

	it("rolls back a failing migration and leaves it unrecorded so it retries next run", async () => {
		const tableName = `gadgets_${randomUUID().replace(/-/g, "_")}`;
		const migrationId = `test-${randomUUID()}`;
		const migrations: Migration[] = [
			{
				id: migrationId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`));
					throw new Error("boom");
				}
			}
		];

		try {
			await expect(runMigrations(pool, migrations)).rejects.toThrow("boom");

			const { rows: tableRows } = await pool.query(
				`SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
				[tableName]
			);
			expect(tableRows).toEqual([]);

			const { rows: ledgerRows } = await pool.query(`SELECT id FROM schema_migrations WHERE id = $1`, [migrationId]);
			expect(ledgerRows).toEqual([]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = $1`, [migrationId]);
		}
	});

	it("leaves a failing caller-managed migration for the outer transaction to roll back", async () => {
		const successfulTableName = `caller_managed_success_${randomUUID().replace(/-/g, "_")}`;
		const failingTableName = `caller_managed_failure_${randomUUID().replace(/-/g, "_")}`;
		const successfulMigrationId = `test-${randomUUID()}`;
		const failingMigrationId = `test-${randomUUID()}`;
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await expect(runMigrationsWithClient(client, [
				{
					id: successfulMigrationId,
					up: async (conn) => {
						await conn.run(sql.raw(`CREATE TABLE ${successfulTableName} (id TEXT PRIMARY KEY)`));
					}
				},
				{
					id: failingMigrationId,
					up: async (conn) => {
						await conn.run(sql.raw(`CREATE TABLE ${failingTableName} (id TEXT PRIMARY KEY)`));
						throw new Error("caller-managed boom");
					}
				}
			], { transactionIsManagedByCaller: true })).rejects.toThrow("caller-managed boom");

			expect((await client.query("SELECT to_regclass($1) AS table_name", [successfulTableName])).rows).toEqual([
				{ table_name: successfulTableName }
			]);
			expect((await client.query("SELECT to_regclass($1) AS table_name", [failingTableName])).rows).toEqual([
				{ table_name: failingTableName }
			]);
			expect((await client.query("SELECT id FROM schema_migrations WHERE id = ANY($1) ORDER BY id", [[successfulMigrationId, failingMigrationId]])).rows).toEqual([
				{ id: successfulMigrationId }
			]);

			await client.query("ROLLBACK");
			expect((await client.query("SELECT to_regclass($1) AS table_name", [successfulTableName])).rows).toEqual([{ table_name: null }]);
			expect((await client.query("SELECT to_regclass($1) AS table_name", [failingTableName])).rows).toEqual([{ table_name: null }]);
			expect((await client.query("SELECT id FROM schema_migrations WHERE id = ANY($1)", [[successfulMigrationId, failingMigrationId]])).rows).toEqual([]);
			expect((await client.query("SELECT 1 AS reusable")).rows).toEqual([{ reusable: 1 }]);
		} finally {
			client.release();
			await pool.query(`DROP TABLE IF EXISTS ${successfulTableName}`);
			await pool.query(`DROP TABLE IF EXISTS ${failingTableName}`);
			await pool.query("DELETE FROM schema_migrations WHERE id = ANY($1)", [[successfulMigrationId, failingMigrationId]]);
		}
	});

	it("applies only the new migrations, in order, when the module list grows", async () => {
		const firstTable = `widgets_${randomUUID().replace(/-/g, "_")}`;
		const secondTable = `gizmos_${randomUUID().replace(/-/g, "_")}`;
		const firstId = `test-${randomUUID()}`;
		const secondId = `test-${randomUUID()}`;
		const applied: string[] = [];
		const firstBatch: Migration[] = [
			{
				id: firstId,
				up: async (conn) => {
					await conn.run(sql.raw(`CREATE TABLE ${firstTable} (id TEXT PRIMARY KEY)`));
					applied.push(firstId);
				}
			}
		];

		try {
			await runMigrations(pool, firstBatch);

			const secondBatch: Migration[] = [
				...firstBatch,
				{
					id: secondId,
					up: async (conn) => {
						await conn.run(sql.raw(`CREATE TABLE ${secondTable} (id TEXT PRIMARY KEY)`));
						applied.push(secondId);
					}
				}
			];

			await runMigrations(pool, secondBatch);

			expect(applied).toEqual([firstId, secondId]);
		} finally {
			await pool.query(`DROP TABLE IF EXISTS ${firstTable}`);
			await pool.query(`DROP TABLE IF EXISTS ${secondTable}`);
			await pool.query(`DELETE FROM schema_migrations WHERE id = ANY($1)`, [[firstId, secondId]]);
		}
	});
});
