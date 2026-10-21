import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const issueCommentsMigration: Migration = {
	id: "issue-comments",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite issue comments migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE revision_entries RENAME TO revision_entries_before_issue_comments`);
		await conn.run(sql`CREATE TABLE revision_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term', 'issue-comment')),
			record_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			author TEXT NOT NULL,
			patch_format INTEGER NOT NULL CHECK (patch_format > 0),
			reverse_patch BLOB NOT NULL CHECK (typeof(reverse_patch) = 'blob'),
			source_hash BLOB NOT NULL CHECK (typeof(source_hash) = 'blob' AND length(source_hash) = 32),
			target_hash BLOB NOT NULL CHECK (typeof(target_hash) = 'blob' AND length(target_hash) = 32),
			restored_from_revision INTEGER,
			created_at TEXT NOT NULL
		)`);
		await conn.run(sql`INSERT INTO revision_entries SELECT * FROM revision_entries_before_issue_comments`);
		await conn.run(sql`DROP TABLE revision_entries_before_issue_comments`);
		await conn.run(sql`CREATE INDEX revision_entries_project_idx ON revision_entries (tenant_id, project_id)`);
		await conn.run(sql`CREATE UNIQUE INDEX revision_entries_chain_idx ON revision_entries (tenant_id, project_id, record_kind, record_key, revision)`);

		await conn.run(sql`CREATE TABLE issue_comments (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			reference TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			created_by TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			body TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id),
			UNIQUE (tenant_id, reference),
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX issue_comments_tenant_issue_idx ON issue_comments(tenant_id, issue_id, created_at, reference)`);
		await conn.run(sql`CREATE TABLE issue_comment_references (
			tenant_id TEXT NOT NULL,
			comment_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, comment_id, issue_id),
			FOREIGN KEY (tenant_id, comment_id) REFERENCES issue_comments(tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX issue_comment_references_tenant_issue_idx ON issue_comment_references(tenant_id, issue_id, position)`);
	}
};