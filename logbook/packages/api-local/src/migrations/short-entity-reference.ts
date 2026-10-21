import { shortEntityReference, type Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";

type EntityRow = {
	tenant_id: string;
	id: string;
	kind: string;
};

export const shortEntityReferenceMigration: Migration = {
	id: "short-entity-reference",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite short entity reference migration requires the SQLite dialect.");
		}

		await conn.run(sql`ALTER TABLE entities ADD COLUMN short_reference TEXT`);
		const referencesByTenant = new Map<string, Set<string>>();
		const entities = await conn.all<EntityRow>(sql`SELECT tenant_id, id, kind FROM entities ORDER BY tenant_id, id`);

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
			await conn.run(sql`UPDATE entities SET short_reference = ${reference} WHERE tenant_id = ${entity.tenant_id} AND id = ${entity.id}`);
		}

		await conn.run(sql`CREATE UNIQUE INDEX entities_tenant_short_reference_idx ON entities (tenant_id, short_reference)`);
	}
};