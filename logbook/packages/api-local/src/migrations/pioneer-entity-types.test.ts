import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createReverseFieldPatch,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY
} from "@agent-issues/core";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDatabase } from "../db/database.js";
import { encodeRevisionPatchHash } from "../db/revision-patch-hash.js";
import { runMigrations } from "../db/migration-runner.js";
import { createEntity, getEntityDetails, materializeEntityRevision } from "../features/entity-store/store.js";
import { pioneerEntityTypesMigration } from "./pioneer-entity-types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Pioneer entity type migration", () => {
	it("rewrites current and historical planning entity types", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-pioneer-types-"));
		temporaryDirectories.push(directory);
		const { executor } = await ensureDatabase(path.join(directory, "test.db"), { tenant: "migration-test" });
		executor.drizzle.run(sql`DELETE FROM schema_migrations WHERE id = ${pioneerEntityTypesMigration.id}`);

		const initiative = createEntity(executor, { kind: "initiative", title: "Planning" });
		const map = createEntity(executor, { kind: "issue", parentId: initiative.id, title: "Map", type: "pioneer-map" });
		const ticket = createEntity(executor, { kind: "issue", parentId: map.id, title: "Ticket", type: "pioneer-ticket" });
		let oldMapState: Record<string, unknown> | null = null;
		for (const [entity, oldType] of [[map, "wayfinder-map"], [ticket, "wayfinder-ticket"]] as const) {
			const state = {
				title: entity.title,
				body: entity.body,
				bodySource: entity.bodySource,
				category: entity.category,
				priority: entity.priority,
				type: oldType,
				status: entity.status,
				parentId: entity.id === map.id ? initiative.id : map.id,
				tombstone: false
			};
			if (entity.id === map.id) oldMapState = state;
			const baseline = createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY);
			executor.drizzle.run(sql`UPDATE entities SET type = ${oldType} WHERE id = ${entity.id}`);
			executor.drizzle.run(sql`
				UPDATE revision_entries
				SET reverse_patch = ${Buffer.from(baseline.reversePatch)},
					source_hash = ${encodeRevisionPatchHash(baseline.sourceHash)},
					target_hash = ${encodeRevisionPatchHash(baseline.targetHash)}
				WHERE record_key = ${encodeEntityRecordKey(entity.id)} AND revision = 1
			`);
		}
		const currentMapState = { ...oldMapState!, type: null };
		const mapTransition = createReverseFieldPatch(currentMapState, oldMapState!, ENTITY_REVERSE_PATCH_REGISTRY);
		const now = new Date().toISOString();
		executor.drizzle.run(sql`UPDATE entities SET type = NULL, revision = 2 WHERE id = ${map.id}`);
		executor.drizzle.run(sql`
			INSERT INTO revision_entries
				(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
			VALUES (
				${randomUUID()}, ${executor.tenantId}, ${executor.currentProjectId}, ${"entity"}, ${encodeEntityRecordKey(map.id)}, 2,
				${"migration-test"}, ${mapTransition.patchFormat}, ${Buffer.from(mapTransition.reversePatch)},
				${encodeRevisionPatchHash(mapTransition.sourceHash)}, ${encodeRevisionPatchHash(mapTransition.targetHash)}, NULL, ${now}
			)
		`);

		await runMigrations(executor, [pioneerEntityTypesMigration]);

		expect(getEntityDetails(executor, map.id).entity.type).toBeNull();
		expect(getEntityDetails(executor, ticket.id).entity.type).toBe("pioneer-ticket");
		expect(materializeEntityRevision(executor, { entityId: map.id, revision: 1 }).type).toBe("pioneer-map");
		expect(materializeEntityRevision(executor, { entityId: ticket.id, revision: 1 }).type).toBe("pioneer-ticket");

		executor.close();
	});
});