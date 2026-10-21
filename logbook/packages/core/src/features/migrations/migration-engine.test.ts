import { describe, expect, it } from "vitest";

import type { Migration, MigrationConn, MigrationEngine } from "./migration-engine.js";
import { runMigrationSequence } from "./migration-engine.js";

/**
 * A fake, driver-less `MigrationEngine` used to pin down the shared
 * algorithm's behavior in isolation from both real drivers (SQLite, Postgres)
 * - the ledger, backups, and transaction boundary are all just in-memory
 * bookkeeping here.
 */
function createFakeEngine(): MigrationEngine & { appliedIds: string[]; backupCount: number } {
	const applied = new Set<string>();
	return {
		appliedIds: [] as string[],
		backupCount: 0,
		async ensureLedgerTable() {
			// no-op: the fake ledger is just the `applied` set.
		},
		async isApplied(id: string) {
			return applied.has(id);
		},
		async recordApplied(id: string) {
			applied.add(id);
			this.appliedIds.push(id);
		},
		async backup() {
			this.backupCount += 1;
		},
		async withTransaction<T>(_migrationId: string, fn: () => Promise<T>): Promise<T> {
			return fn();
		}
	};
}

describe("runMigrationSequence", () => {
	const fakeConn: MigrationConn = {
		dialect: "sqlite",
		run: async () => {},
		all: async () => []
	};

	it("applies an unapplied migration once and records it via the engine", async () => {
		const engine = createFakeEngine();
		let runCount = 0;
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async () => {
					runCount += 1;
				}
			}
		];

		await runMigrationSequence(migrations, engine, fakeConn);
		await runMigrationSequence(migrations, engine, fakeConn);

		expect(runCount).toBe(1);
		expect(engine.appliedIds).toEqual(["0001-create-widgets"]);
	});

	it("applies only the new migrations, in order, when the module list grows", async () => {
		const engine = createFakeEngine();
		const applied: string[] = [];
		const firstBatch: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async () => {
					applied.push("0001-create-widgets");
				}
			}
		];

		await runMigrationSequence(firstBatch, engine, fakeConn);

		const secondBatch: Migration[] = [
			...firstBatch,
			{
				id: "0002-create-gadgets",
				up: async () => {
					applied.push("0002-create-gadgets");
				}
			}
		];

		await runMigrationSequence(secondBatch, engine, fakeConn);

		expect(applied).toEqual(["0001-create-widgets", "0002-create-gadgets"]);
	});

	it("does not record the migration and rethrows when up() throws", async () => {
		const engine = createFakeEngine();
		const migrations: Migration[] = [
			{
				id: "0001-partial-failure",
				up: async () => {
					throw new Error("boom");
				}
			}
		];

		await expect(runMigrationSequence(migrations, engine, fakeConn)).rejects.toThrow("boom");

		expect(engine.appliedIds).toEqual([]);
	});

	it("backs up before applying an unapplied migration, but never for one already applied", async () => {
		const engine = createFakeEngine();
		const migrations: Migration[] = [
			{ id: "0001-create-widgets", up: async () => {} }
		];

		await runMigrationSequence(migrations, engine, fakeConn);
		expect(engine.backupCount).toBe(1);

		await runMigrationSequence(migrations, engine, fakeConn);
		expect(engine.backupCount).toBe(1);
	});

	it("re-checks isApplied inside the transaction boundary, skipping if a concurrent runner already applied it", async () => {
		const engine = createFakeEngine();
		let concurrentRunnerHasWon = false;
		// Simulates another process finishing the same migration while this
		// runner was waiting to acquire the (Postgres advisory) lock inside
		// withTransaction - the real guarantee `withTransaction` provides for
		// Postgres, and the reason the shared algorithm re-checks isApplied
		// immediately before calling up().
		const originalWithTransaction = engine.withTransaction.bind(engine);
		engine.withTransaction = async (migrationId, fn) => {
			return originalWithTransaction(migrationId, async () => {
				if (!concurrentRunnerHasWon) {
					concurrentRunnerHasWon = true;
					await engine.recordApplied(migrationId);
				}
				return fn();
			});
		};
		let upCallCount = 0;
		const migrations: Migration[] = [
			{
				id: "0001-create-widgets",
				up: async () => {
					upCallCount += 1;
				}
			}
		];

		await runMigrationSequence(migrations, engine, fakeConn);

		expect(upCallCount).toBe(0);
		expect(engine.appliedIds).toEqual(["0001-create-widgets"]);
	});
});
