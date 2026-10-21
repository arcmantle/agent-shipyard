import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const instructionHistoryMigration: Migration = {
	id: "instruction-history",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_history (
			item_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'fragment')),
			body TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			default_version TEXT NOT NULL,
			PRIMARY KEY (item_key, revision)
		)`);
		await db.run(sql`INSERT INTO instruction_history (item_key, revision, kind, body, content_hash, default_version)
			SELECT item_key, revision, kind, body, content_hash, default_version FROM instruction_overrides`);
	}
};