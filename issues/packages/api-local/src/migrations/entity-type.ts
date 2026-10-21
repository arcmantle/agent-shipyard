import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const entityTypeMigration: Migration = {
	id: "entity-type",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite entity type migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN type TEXT`);
	}
};