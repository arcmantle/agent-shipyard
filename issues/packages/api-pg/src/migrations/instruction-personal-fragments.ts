import { sql } from "drizzle-orm";
import type { Migration } from "../db/migration-runner.js";

export const instructionPersonalFragmentsMigration: Migration = {
	id: "instruction-personal-fragments",
	async up(db) {
		await db.run(sql`CREATE TABLE instruction_personal_fragments (
			tenant_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			item_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			body TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			removed BOOLEAN NOT NULL DEFAULT FALSE,
			PRIMARY KEY (tenant_id, user_id, item_key, revision)
		)`);
		await db.run(sql`ALTER TABLE instruction_personal_fragments ENABLE ROW LEVEL SECURITY`);
		await db.run(sql`ALTER TABLE instruction_personal_fragments FORCE ROW LEVEL SECURITY`);
		await db.run(sql`CREATE POLICY instruction_fragment_owner_isolation ON instruction_personal_fragments
			USING (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true) AND user_id = current_setting('app.instruction_user_id', true))`);
		await db.run(sql`GRANT SELECT, INSERT ON instruction_personal_fragments TO agent_issues_app`);
	}
};