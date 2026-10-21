import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const entityTypeMigration: Migration = {
	id: "entity-type",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres entity type migration requires the Postgres dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN type TEXT`);
	}
};