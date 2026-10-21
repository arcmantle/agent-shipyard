import type { Pool } from "pg";

export async function createLegacyV7Schema(pool: Pool): Promise<void> {
	await pool.query(`
		CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE counters (
			tenant_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			next_value INTEGER NOT NULL,
			PRIMARY KEY (tenant_id, kind)
		);
		CREATE TABLE entities (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			kind TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			body TEXT NOT NULL DEFAULT '',
			body_source TEXT NOT NULL DEFAULT 'authored',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		);
		CREATE TABLE relations (
			tenant_id TEXT NOT NULL,
			from_id TEXT NOT NULL,
			to_id TEXT NOT NULL,
			type TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, from_id, to_id, type),
			FOREIGN KEY (tenant_id, from_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE,
			FOREIGN KEY (tenant_id, to_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE
		);
		CREATE INDEX relations_tenant_to_id_idx ON relations (tenant_id, to_id);
		CREATE TABLE contexts (
			tenant_id TEXT NOT NULL,
			key TEXT NOT NULL,
			scope_entity_id TEXT,
			title TEXT NOT NULL,
			summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, key),
			FOREIGN KEY (tenant_id, scope_entity_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE
		);
		CREATE UNIQUE INDEX contexts_tenant_scope_entity_id_idx
			ON contexts (tenant_id, scope_entity_id) WHERE scope_entity_id IS NOT NULL;
		CREATE TABLE context_terms (
			tenant_id TEXT NOT NULL,
			context_key TEXT NOT NULL,
			term TEXT NOT NULL,
			definition TEXT NOT NULL,
			avoid_terms TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, context_key, term),
			FOREIGN KEY (tenant_id, context_key) REFERENCES contexts (tenant_id, key) ON DELETE CASCADE
		);
		CREATE INDEX context_terms_tenant_context_key_idx ON context_terms (tenant_id, context_key);
		CREATE TABLE history_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			author TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL,
			body_source TEXT NOT NULL,
			status TEXT NOT NULL,
			parent_id TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX history_entries_tenant_entity_version_idx
			ON history_entries (tenant_id, entity_id, version);
	`);
}