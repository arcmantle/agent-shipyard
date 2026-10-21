import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase, withTenantTransaction } from "./connection.js";

const CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("Postgres connection + migration bootstrap", () => {
	let pool: Pool;
	let adminPool: Pool;
	let schemaName: string;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: CONNECTION_STRING });
		schemaName = `connection_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		pool = new Pool({ connectionString: CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		await migratePgDatabase(pool);
	});

	afterAll(async () => {
		await pool.end();
		await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		await adminPool.end();
	});

	it("runs migrations and scopes a transaction to a tenant via SET LOCAL app.tenant_id", async () => {
		const tenantId = await withTenantTransaction(pool, "tenant-connection-test", async (client) => {
			const result = await client.query("SELECT current_setting('app.tenant_id', true) AS tenant_id");
			return result.rows[0]?.tenant_id as string;
		});

		expect(tenantId).toBe("tenant-connection-test");
	});

	it("rolls back and releases the connection when tenant work fails", async () => {
		const queries: string[] = [];
		let released = false;
		const testPool = {
			connect: async () => ({
				query: async (query: string) => {
					queries.push(query);
					return { rows: [] };
				},
				release: () => {
					released = true;
				}
			})
		} as unknown as Pool;

		await expect(
			withTenantTransaction(testPool, "tenant-failure-test", async () => {
				throw new Error("expected tenant failure");
			})
		).rejects.toThrow("expected tenant failure");

		expect(queries).toEqual(["BEGIN", "SELECT set_config('app.tenant_id', $1, true)", "ROLLBACK"]);
		expect(released).toBe(true);
	});

	it("rolls back and releases the client when migration execution fails", async () => {
		const queries: string[] = [];
		let released = false;
		const testPool = {
			connect: async () => ({
				query: async (query: string) => {
					queries.push(query);
					if (query.includes("SELECT current_schema()")) return { rows: [{ current_schema: "migration_failure" }] };
					if (query.includes("information_schema.tables") && query.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
					if (query.includes("information_schema.tables")) return { rows: [] };
					if (query.includes("information_schema.columns")) return { rows: [] };
					if (query.includes("FROM pg_constraint")) return { rows: [] };
					if (query.includes("FROM pg_indexes")) return { rows: [] };
					if (query.includes("FROM pg_policies")) return { rows: [] };
					if (query.includes("FROM pg_class")) return { rows: [] };
					if (query.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) throw new Error("expected migration failure");
					return { rows: [] };
				},
				release: () => {
					released = true;
				}
			})
		} as unknown as Pool;

		await expect(migratePgDatabase(testPool)).rejects.toThrow("expected migration failure");

		expect(queries[0]).toBe("BEGIN");
		expect(queries.at(-1)).toBe("ROLLBACK");
		expect(released).toBe(true);
	});
});
