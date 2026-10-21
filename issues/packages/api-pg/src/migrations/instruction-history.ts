import { sql } from "drizzle-orm";
import type { Migration } from "../db/migration-runner.js";

export const instructionHistoryMigration: Migration = {
	id: "instruction-history",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_history (
			tenant_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			item_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'fragment')),
			body TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			default_version TEXT NOT NULL,
			PRIMARY KEY (tenant_id, user_id, item_key, revision)
		)`);
		await db.run(sql`INSERT INTO instruction_history (tenant_id, user_id, item_key, revision, kind, body, content_hash, default_version)
			SELECT tenant_id, user_id, item_key, revision, kind, body, content_hash, default_version FROM instruction_overrides`);
		await db.run(sql`ALTER TABLE instruction_history ENABLE ROW LEVEL SECURITY`);
		await db.run(sql`ALTER TABLE instruction_history FORCE ROW LEVEL SECURITY`);
		await db.run(sql`CREATE POLICY instruction_owner_isolation ON instruction_history
			USING (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))`);
		await db.run(sql`GRANT SELECT, INSERT ON instruction_history TO agent_issues_app`);
	}
};