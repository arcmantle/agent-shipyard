import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const projectSettingsMigration: Migration = {
	id: "project-settings",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite project settings migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE TABLE project_settings (
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			prospector_settings TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (tenant_id, project_id),
			FOREIGN KEY (tenant_id, project_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
	}
};