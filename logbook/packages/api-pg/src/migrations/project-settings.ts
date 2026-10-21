import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const projectSettingsMigration: Migration = {
	id: "project-settings",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres project settings migration requires the Postgres dialect.");
		}

		await conn.run(sql`CREATE TABLE project_settings (
			tenant_id TEXT NOT NULL,
			project_id UUID NOT NULL,
			prospector_settings TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (tenant_id, project_id),
			FOREIGN KEY (tenant_id, project_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql.raw("ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE project_settings FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON project_settings
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};