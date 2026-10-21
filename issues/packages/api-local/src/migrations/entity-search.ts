import type { Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

export const entitySearchMigration: Migration = {
	id: "entity-search",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite entity search migration requires the SQLite dialect.");
		}

		await conn.run(sql`CREATE TABLE search_documents (
			tenant_id TEXT NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			project_label TEXT NOT NULL,
			reference TEXT NOT NULL,
			short_reference TEXT NOT NULL,
			title TEXT NOT NULL,
			body TEXT NOT NULL,
			status_or_role TEXT,
			parent_id TEXT,
			parent_label TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, source_type, source_id)
		)`);
		await conn.run(sql`CREATE INDEX search_documents_entity_identity_idx ON search_documents (tenant_id, source_type, project_id, reference, short_reference)`);
		await conn.run(sql`CREATE INDEX search_documents_entity_title_idx ON search_documents (tenant_id, source_type, project_id, title)`);
		await conn.run(sql`INSERT INTO search_documents (
			tenant_id, source_type, source_id, project_id, project_label, reference,
			short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
		)
		SELECT entity.tenant_id, 'entity', entity.id, entity.project_id, project.title,
			entity.reference, entity.short_reference, entity.title, entity.body, entity.status,
			parent.id, parent.title, entity.updated_at
		FROM entities AS entity
		JOIN entities AS project
			ON project.tenant_id = entity.tenant_id
			AND project.id = entity.project_id
			AND project.kind = 'project'
		LEFT JOIN entities AS parent
			ON parent.tenant_id = entity.tenant_id
			AND parent.id = (
				SELECT relation.from_id
				FROM relations AS relation
				WHERE relation.tenant_id = entity.tenant_id
					AND relation.to_id = entity.id
					AND relation.type IN ('owns', 'tracks', 'decomposes', 'creates', 'records')
				ORDER BY relation.from_id
				LIMIT 1
			)
		WHERE entity.tombstone = 0`);
	}
};