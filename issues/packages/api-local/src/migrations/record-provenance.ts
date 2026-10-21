import { deriveUserIdentity, resolveLocalUsername, type Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const recordProvenanceMigration: Migration = {
	id: "record-provenance",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite record provenance migration requires the SQLite dialect.");
		}

		const username = resolveLocalUsername();
		const user = deriveUserIdentity(`local:${username}`);
		const now = new Date().toISOString();
		await conn.run(sql`ALTER TABLE entities ADD COLUMN created_by TEXT`);
		await conn.run(sql`ALTER TABLE entities ADD COLUMN updated_by TEXT`);
		const tenants = await conn.all<{ tenantId: string }>(sql`SELECT DISTINCT tenant_id AS tenantId FROM entities`);
		for (const { tenantId } of tenants) {
			await conn.run(sql`INSERT OR IGNORE INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at)
				VALUES (${tenantId}, ${user.id}, ${user.authenticationSubject}, ${username}, ${now}, ${now})`);
			await conn.run(sql`UPDATE entities SET created_by = ${user.id}, updated_by = ${user.id} WHERE tenant_id = ${tenantId}`);
		}
	}
};