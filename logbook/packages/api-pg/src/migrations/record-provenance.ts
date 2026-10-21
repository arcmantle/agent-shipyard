import { deriveUserIdentity, SYSTEM_AUTHENTICATION_SUBJECT } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const recordProvenanceMigration: Migration = {
	id: "record-provenance",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres record provenance migration requires the PostgreSQL dialect.");
		}

		const user = deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT);
		const now = new Date().toISOString();
		await conn.run(sql`ALTER TABLE entities ADD COLUMN created_by UUID`);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN updated_by UUID`);
		await conn.run(sql`INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at)
			SELECT DISTINCT tenant_id, ${user.id}::uuid, ${user.authenticationSubject}, NULL, ${now}, ${now}
			FROM entities
			ON CONFLICT (tenant_id, id) DO NOTHING`);
		await conn.run(sql`UPDATE entities SET created_by = ${user.id}::uuid, updated_by = ${user.id}::uuid WHERE created_by IS NULL OR updated_by IS NULL`);
	}
};