import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const completionObservationsMigration: Migration = {
	id: "completion-observations",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres completion observations migration requires the Postgres dialect.");
		}

		await conn.run(sql`CREATE TABLE completion_observations (
			tenant_id TEXT NOT NULL,
			id UUID NOT NULL,
			issue_id UUID NOT NULL,
			completion_ordinal INTEGER NOT NULL CHECK (completion_ordinal > 0),
			repository_identity TEXT,
			commit_sha TEXT,
			branch TEXT,
			dirty BOOLEAN,
			captured_at TEXT NOT NULL,
			calculated_version TEXT,
			diagnostics TEXT NOT NULL,
			PRIMARY KEY (tenant_id, issue_id, completion_ordinal),
			UNIQUE (tenant_id, id),
			FOREIGN KEY (tenant_id, issue_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX completion_observations_tenant_issue_idx ON completion_observations(tenant_id, issue_id, completion_ordinal)`);
		await conn.run(sql.raw("ALTER TABLE completion_observations ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE completion_observations FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON completion_observations
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};
