import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const userDirectoryMigration: Migration = {
	id: "user-directory",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres user directory migration requires the PostgreSQL dialect.");
		}
		await conn.run(sql`CREATE TABLE users (
			tenant_id TEXT NOT NULL,
			id UUID NOT NULL,
			authentication_subject TEXT NOT NULL,
			display_name TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)`);
		await conn.run(sql`CREATE UNIQUE INDEX users_tenant_authentication_subject_idx ON users (tenant_id, authentication_subject)`);
		await conn.run(sql.raw("ALTER TABLE users ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE users FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON users
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};