import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const userDirectoryMigration: Migration = {
	id: "user-directory",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite user directory migration requires the SQLite dialect.");
		}
		await conn.run(sql`CREATE TABLE users (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			authentication_subject TEXT NOT NULL,
			display_name TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)`);
		await conn.run(sql`CREATE UNIQUE INDEX users_tenant_authentication_subject_idx ON users (tenant_id, authentication_subject)`);
	}
};