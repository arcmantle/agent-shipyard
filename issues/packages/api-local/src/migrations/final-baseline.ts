import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const finalBaselineMigration: Migration = {
	id: "final-baseline",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite final baseline requires the SQLite dialect.");
		}
		await conn.run(sql`CREATE TABLE counters (
			tenant_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			next_value INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, kind)
		)`);
		await conn.run(sql`CREATE TABLE entities (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			reference TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			body_source TEXT NOT NULL DEFAULT 'authored',
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone INTEGER NOT NULL DEFAULT 0,
			project_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		)`);
		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_reference_idx ON entities (tenant_id, reference)`);
		await conn.run(sql`CREATE TABLE relations (
			tenant_id TEXT NOT NULL,
			from_id TEXT NOT NULL,
			to_id TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, from_id, to_id, type),
			FOREIGN KEY (tenant_id, from_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, to_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX relations_tenant_to_id_idx ON relations (tenant_id, to_id)`);
		await conn.run(sql`CREATE TABLE contexts (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			reference TEXT NOT NULL,
			key TEXT NOT NULL,
			scope_entity_id TEXT,
			title TEXT NOT NULL,
			summary TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, key),
			FOREIGN KEY (tenant_id, scope_entity_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_id_idx ON contexts (tenant_id, id)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_reference_idx ON contexts (tenant_id, reference)`);
		await conn.run(sql`CREATE UNIQUE INDEX contexts_tenant_scope_entity_id_idx ON contexts (tenant_id, scope_entity_id) WHERE scope_entity_id IS NOT NULL`);
		await conn.run(sql`CREATE TABLE context_terms (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			definition TEXT NOT NULL,
			avoid_terms TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 1,
			content_hash TEXT NOT NULL DEFAULT '',
			tombstone INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, context_key, term),
			FOREIGN KEY (tenant_id, context_key) REFERENCES contexts (tenant_id, key) ON DELETE CASCADE
		)`);
		await conn.run(sql`CREATE INDEX context_terms_tenant_context_key_idx ON context_terms (tenant_id, context_key)`);
		await conn.run(sql`CREATE UNIQUE INDEX context_terms_tenant_id_idx ON context_terms (tenant_id, id)`);
		await conn.run(sql`CREATE TABLE revision_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term')),
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
		await conn.run(sql`CREATE INDEX revision_entries_project_idx ON revision_entries (tenant_id, project_id)`);
		await conn.run(sql`CREATE UNIQUE INDEX revision_entries_chain_idx ON revision_entries (tenant_id, project_id, record_kind, record_key, revision)`);
	}
};