import { shortEntityReference } from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type EntityRow = {
	tenant_id: string;
	id: string;
	kind: string;
};

export const shortEntityReferenceMigration: Migration = {
	id: "short-entity-reference",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres short entity reference migration requires the PostgreSQL dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN short_reference TEXT`);
		const referencesByTenant = new Map<string, Set<string>>();
		const entities = await conn.all<EntityRow>(sql`SELECT tenant_id, id, kind FROM entities ORDER BY tenant_id, id`);
		const shortReferences: Array<{ id: string; short_reference: string; tenant_id: string }> = [];

		for (const entity of entities) {
			const usedReferences = referencesByTenant.get(entity.tenant_id) ?? new Set<string>();
			referencesByTenant.set(entity.tenant_id, usedReferences);
			const baseReference = shortEntityReference(entity);
			let reference = baseReference;
			let suffix = 2;
			while (usedReferences.has(reference)) {
				reference = `${baseReference}-${suffix}`;
				suffix += 1;
			}
			usedReferences.add(reference);
			shortReferences.push({ id: entity.id, short_reference: reference, tenant_id: entity.tenant_id });
		}
		await conn.run(sql`
			UPDATE entities AS entity
			SET short_reference = source.short_reference
			FROM jsonb_to_recordset(${JSON.stringify(shortReferences)}::jsonb) AS source(tenant_id TEXT, id TEXT, short_reference TEXT)
			WHERE entity.tenant_id = source.tenant_id AND entity.id = source.id::uuid
		`);

		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_short_reference_idx ON entities (tenant_id, short_reference)`);
	}
};