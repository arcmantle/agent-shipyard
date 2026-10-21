import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

export const planEntriesMigration: Migration = {
	id: "plan-entries",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres Plan entries migration requires the Postgres dialect.");
		}

		await conn.run(sql`ALTER TABLE revision_entries DROP CONSTRAINT revision_entries_record_kind`);
		await conn.run(sql`ALTER TABLE revision_entries ADD CONSTRAINT revision_entries_record_kind CHECK (record_kind IN ('entity', 'context', 'context-term', 'issue-comment', 'plan-entry'))`);
		await conn.run(sql`CREATE TABLE plan_entries (
			tenant_id TEXT NOT NULL,
			id UUID NOT NULL,
			reference TEXT NOT NULL,
			short_reference TEXT NOT NULL,
			plan_id UUID NOT NULL,
			created_by UUID NOT NULL,
			updated_by UUID NOT NULL,
			role TEXT NOT NULL,
			body TEXT NOT NULL,
			scope_direction TEXT,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id),
			UNIQUE (tenant_id, reference),
			UNIQUE (tenant_id, short_reference),
			FOREIGN KEY (tenant_id, plan_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX plan_entries_tenant_plan_idx ON plan_entries(tenant_id, plan_id, created_at, reference)`);
		await conn.run(sql.raw("ALTER TABLE plan_entries ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE plan_entries FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON plan_entries
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
		await conn.run(sql`CREATE TABLE plan_entry_references (
			tenant_id TEXT NOT NULL,
			plan_entry_id UUID NOT NULL,
			entity_id UUID NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, plan_entry_id, entity_id),
			FOREIGN KEY (tenant_id, plan_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql.raw("ALTER TABLE plan_entry_references ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE plan_entry_references FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON plan_entry_references
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
		await conn.run(sql`CREATE TABLE plan_entry_supersessions (
			tenant_id TEXT NOT NULL,
			plan_entry_id UUID NOT NULL,
			superseded_entry_id UUID NOT NULL,
			PRIMARY KEY (tenant_id, plan_entry_id, superseded_entry_id),
			FOREIGN KEY (tenant_id, plan_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, superseded_entry_id) REFERENCES plan_entries(tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql.raw("ALTER TABLE plan_entry_supersessions ENABLE ROW LEVEL SECURITY"));
		await conn.run(sql.raw("ALTER TABLE plan_entry_supersessions FORCE ROW LEVEL SECURITY"));
		await conn.run(sql.raw(`CREATE POLICY tenant_isolation ON plan_entry_supersessions
			USING (tenant_id = current_setting('app.tenant_id', true))
			WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`));
	}
};