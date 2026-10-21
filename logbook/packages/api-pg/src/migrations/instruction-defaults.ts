import type { Migration } from "../db/migration-runner.js";
import { sql } from "drizzle-orm";

export const instructionDefaultsMigration: Migration = {
	id: "instruction-defaults",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_bundles (
			version TEXT PRIMARY KEY,
			content_hash TEXT NOT NULL
		)`);
		await db.run(sql`CREATE TABLE instruction_defaults (
			version TEXT NOT NULL REFERENCES instruction_bundles(version),
			item_key TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'fragment')),
			body TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			content_hash TEXT NOT NULL,
			PRIMARY KEY (version, item_key)
		)`);
		await db.run(sql`REVOKE INSERT, UPDATE, DELETE ON instruction_bundles, instruction_defaults FROM agent_issues_app`);
		await db.run(sql`GRANT SELECT ON instruction_bundles, instruction_defaults TO agent_issues_app`);
	}
};