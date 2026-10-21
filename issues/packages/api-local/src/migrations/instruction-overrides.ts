import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const instructionOverridesMigration: Migration = {
	id: "instruction-overrides",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_overrides (
			item_key TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'fragment')),
			body TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			content_hash TEXT NOT NULL,
			default_version TEXT NOT NULL
		)`);
	}
};