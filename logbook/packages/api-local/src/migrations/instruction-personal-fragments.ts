import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const instructionPersonalFragmentsMigration: Migration = {
	id: "instruction-personal-fragments",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_personal_fragments (
			item_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			body TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
			PRIMARY KEY (item_key, revision)
		)`);
	}
};