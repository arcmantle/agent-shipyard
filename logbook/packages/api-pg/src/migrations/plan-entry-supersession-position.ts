import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const planEntrySupersessionPositionMigration: Migration = {
	id: "plan-entry-supersession-position",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres Plan-entry supersession position migration requires the Postgres dialect.");
		}

		await conn.run(sql`ALTER TABLE plan_entry_supersessions ADD COLUMN position INTEGER`);
		await conn.run(sql`UPDATE plan_entry_supersessions AS current
			SET position = ranked.position
			FROM (
				SELECT tenant_id, plan_entry_id, superseded_entry_id,
					row_number() OVER (PARTITION BY tenant_id, plan_entry_id ORDER BY superseded_entry_id) - 1 AS position
				FROM plan_entry_supersessions
			) AS ranked
			WHERE ranked.tenant_id = current.tenant_id
				AND ranked.plan_entry_id = current.plan_entry_id
				AND ranked.superseded_entry_id = current.superseded_entry_id`);
		await conn.run(sql`ALTER TABLE plan_entry_supersessions ALTER COLUMN position SET NOT NULL`);
	}
};