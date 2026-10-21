import { sql } from "drizzle-orm";
import type { Migration } from "../db/migration-runner.js";

export const instructionOverridesMigration: Migration = {
	id: "instruction-overrides",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_overrides (
			tenant_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			item_key TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('agent', 'skill', 'fragment')),
			body TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			content_hash TEXT NOT NULL,
			default_version TEXT NOT NULL,
			PRIMARY KEY (tenant_id, user_id, item_key)
		)`);
		await db.run(sql`ALTER TABLE instruction_overrides ENABLE ROW LEVEL SECURITY`);
		await db.run(sql`ALTER TABLE instruction_overrides FORCE ROW LEVEL SECURITY`);
		await db.run(sql`CREATE POLICY instruction_owner_isolation ON instruction_overrides
			USING (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))`);
		await db.run(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON instruction_overrides TO agent_issues_app`);
	}
};