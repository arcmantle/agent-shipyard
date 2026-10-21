import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const instructionResetsMigration: Migration = {
	id: "instruction-resets",
	async up(db) {
		await db.run(sql`ALTER TABLE instruction_history ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))`);
	}
};