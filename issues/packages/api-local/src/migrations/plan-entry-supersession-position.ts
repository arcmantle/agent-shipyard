import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const planEntrySupersessionPositionMigration: Migration = {
	id: "plan-entry-supersession-position",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite Plan-entry supersession position migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE plan_entry_supersessions ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
		await conn.run(sql`UPDATE plan_entry_supersessions AS current
			SET position = (
				SELECT count(*) FROM plan_entry_supersessions AS preceding
				WHERE preceding.tenant_id = current.tenant_id
					AND preceding.plan_entry_id = current.plan_entry_id
					AND preceding.superseded_entry_id < current.superseded_entry_id
			)`);
	}
};