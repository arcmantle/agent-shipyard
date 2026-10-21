import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const completionObservationsMigration: Migration = {
	id: "completion-observations",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite completion observations migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE TABLE completion_observations (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			completion_ordinal INTEGER NOT NULL CHECK (completion_ordinal > 0),
			repository_identity TEXT,
			commit_sha TEXT,
			branch TEXT,
			dirty INTEGER,
			captured_at TEXT NOT NULL,
			calculated_version TEXT,
			diagnostics TEXT NOT NULL,
			PRIMARY KEY (tenant_id, issue_id, completion_ordinal),
			UNIQUE (tenant_id, id),
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX completion_observations_tenant_issue_idx ON completion_observations(tenant_id, issue_id, completion_ordinal)`);
	}
};
