import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const completionObservationVersionStateMigration: Migration = {
	id: "completion-observation-version-state",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite completion observation version state migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE completion_observations ADD COLUMN calculated_version_state TEXT NOT NULL DEFAULT 'unknown' CHECK (calculated_version_state IN ('available', 'unknown'))`);
		await conn.run(sql`UPDATE completion_observations SET calculated_version_state = 'available' WHERE calculated_version IS NOT NULL`);
	}
};
