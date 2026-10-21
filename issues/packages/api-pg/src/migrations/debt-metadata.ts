import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const debtMetadataMigration: Migration = {
	id: "debt-metadata",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres debt metadata migration requires the Postgres dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN category TEXT`);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN priority TEXT`);
	}
};