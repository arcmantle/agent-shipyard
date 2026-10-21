import { sql } from "drizzle-orm";
import type { Migration } from "../db/migration-runner.js";

export const instructionResetsMigration: Migration = {
	id: "instruction-resets",
	async up(db) {
		await db.run(sql`ALTER TABLE instruction_history ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE`);
	}
};