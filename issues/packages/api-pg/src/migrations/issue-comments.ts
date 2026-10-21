import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const issueCommentsMigration: Migration = {
	id: "issue-comments",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres issue comments migration requires the Postgres dialect.");
		}

		await conn.run(sql`ALTER TABLE revision_entries DROP CONSTRAINT revision_entries_record_kind`);
		await conn.run(sql`ALTER TABLE revision_entries ADD CONSTRAINT revision_entries_record_kind CHECK (record_kind IN ('entity', 'context', 'context-term', 'issue-comment'))`);

		await conn.run(sql`CREATE TABLE issue_comments (
			tenant_id TEXT NOT NULL,
			id UUID NOT NULL,
			reference TEXT NOT NULL,
			issue_id UUID NOT NULL,
			created_by UUID NOT NULL,
			updated_by UUID NOT NULL,
			body TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id),
			UNIQUE (tenant_id, reference),
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX issue_comments_tenant_issue_idx ON issue_comments(tenant_id, issue_id, created_at, reference)`);
		await conn.run(sql.raw("ALTER TABLE issue_comments ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE issue_comments FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON issue_comments
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
		await conn.run(sql`CREATE TABLE issue_comment_references (
			tenant_id TEXT NOT NULL,
			comment_id UUID NOT NULL,
			issue_id UUID NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, comment_id, issue_id),
			FOREIGN KEY (tenant_id, comment_id) REFERENCES issue_comments(tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX issue_comment_references_tenant_issue_idx ON issue_comment_references(tenant_id, issue_id, position)`);
		await conn.run(sql.raw("ALTER TABLE issue_comment_references ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE issue_comment_references FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON issue_comment_references
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};