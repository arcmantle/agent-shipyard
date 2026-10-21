import { randomUUID } from "node:crypto";
import {
	createReverseFieldPatch,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY
} from "@agent-issues/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { PgStore } from "../pg-store.js";
import { pioneerEntityTypesMigration } from "./pioneer-entity-types.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("Postgres Pioneer entity type migration", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("rewrites current and historical planning entity types", async () => {
		const schemaName = `pioneer_types_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const tenantId = "migration-test";

		try {
			await migratePgDatabase(schemaPool);
			await schemaPool.query("DELETE FROM schema_migrations WHERE id = $1", [pioneerEntityTypesMigration.id]);
			const store = new PgStore(schemaPool, tenantId);
			const initiative = await store.createEntity({ kind: "initiative", title: "Planning" });
			const map = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Map", type: "pioneer-map" });
			const ticket = await store.createEntity({ kind: "issue", parentId: map.id, title: "Ticket", type: "pioneer-ticket" });
			let oldMapState: Record<string, unknown> | null = null;
			for (const [entity, oldType] of [[map, "wayfinder-map"], [ticket, "wayfinder-ticket"]] as const) {
				const state = {
					title: entity.title,
					body: "",
					bodySource: "authored",
					category: entity.category,
					priority: entity.priority,
					type: oldType,
					status: entity.status,
					parentId: entity.id === map.id ? initiative.id : map.id,
					tombstone: false
				};
				if (entity.id === map.id) oldMapState = state;
				const baseline = createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY);
				await schemaPool.query("UPDATE entities SET type = $1 WHERE tenant_id = $2 AND id = $3", [oldType, tenantId, entity.id]);
				const baselineUpdate = await schemaPool.query(
					"UPDATE revision_entries SET reverse_patch = $1, source_hash = $2, target_hash = $3 WHERE tenant_id = $4 AND record_key = $5 AND revision = 1",
					[Buffer.from(baseline.reversePatch), Buffer.from(baseline.sourceHash, "hex"), Buffer.from(baseline.targetHash, "hex"), tenantId, encodeEntityRecordKey(entity.id)]
				);
				expect(baselineUpdate.rowCount).toBe(1);
				const storedBaseline = await schemaPool.query<{ source_hash: string }>(
					"SELECT encode(source_hash, 'hex') AS source_hash FROM revision_entries WHERE tenant_id = $1 AND record_key = $2 AND revision = 1",
					[tenantId, encodeEntityRecordKey(entity.id)]
				);
				expect(storedBaseline.rows[0]?.source_hash).toBe(baseline.sourceHash);
			}
			const currentMapState = { ...oldMapState!, type: null };
			const transition = createReverseFieldPatch(currentMapState, oldMapState!, ENTITY_REVERSE_PATCH_REGISTRY);
			await schemaPool.query("UPDATE entities SET type = NULL, revision = 2 WHERE tenant_id = $1 AND id = $2", [tenantId, map.id]);
			await schemaPool.query(
				`INSERT INTO revision_entries
					(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
				 SELECT $1, tenant_id, project_id, 'entity', $2, 2, $3, $4, $5, $6, $7, NULL, $8
				 FROM entities WHERE tenant_id = $9 AND id = $10`,
				[randomUUID(), encodeEntityRecordKey(map.id), randomUUID(), transition.patchFormat, Buffer.from(transition.reversePatch), Buffer.from(transition.sourceHash, "hex"), Buffer.from(transition.targetHash, "hex"), new Date().toISOString(), tenantId, map.id]
			);

			await runMigrations(schemaPool, [pioneerEntityTypesMigration]);

			expect((await store.getEntityDetails(map.id)).entity.type).toBeNull();
			expect((await store.getEntityDetails(ticket.id)).entity.type).toBe("pioneer-ticket");
			await expect(store.materializeEntityRevision({ entityId: map.id, revision: 1 })).resolves.toMatchObject({ type: "pioneer-map" });
			await expect(store.materializeEntityRevision({ entityId: ticket.id, revision: 1 })).resolves.toMatchObject({ type: "pioneer-ticket" });
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});
});