import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const issueBreakdownDraftsMigration: Migration = {
	id: "issue-breakdown-drafts",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres issue-breakdown drafts migration requires the Postgres dialect.");
		}

		await conn.run(sql`CREATE TABLE issue_breakdown_drafts (
			tenant_id TEXT NOT NULL,
			id UUID NOT NULL,
			target_id UUID NOT NULL,
			status TEXT NOT NULL,
			snapshot_json TEXT NOT NULL,
			snapshot_digest TEXT NOT NULL,
			approved_at TEXT,
			created_issue_references TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id),
			FOREIGN KEY (tenant_id, target_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE UNIQUE INDEX issue_breakdown_drafts_active_target_idx ON issue_breakdown_drafts (tenant_id, target_id) WHERE status = 'active'`);
		await conn.run(sql`CREATE INDEX issue_breakdown_drafts_target_idx ON issue_breakdown_drafts (tenant_id, target_id, created_at DESC)`);
		await conn.run(sql.raw("ALTER TABLE issue_breakdown_drafts ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE issue_breakdown_drafts FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON issue_breakdown_drafts
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};