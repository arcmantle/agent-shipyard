import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const debtMetadataMigration: Migration = {
	id: "debt-metadata",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite debt metadata migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN category TEXT`);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN priority TEXT`);
	}
};