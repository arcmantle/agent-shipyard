import {
	applyReverseFieldPatch,
	computeCanonicalStateHash,
	createReverseFieldPatch,
	ENTITY_REVERSE_PATCH_REGISTRY,
	STRUCTURAL_RELATION_TYPES
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { Migration } from "../db/migration-runner.js";

type EntityRow = {
	tenant_id: string;
	id: string;
	title: string;
	body: string;
	body_source: string;
	category: string | null;
	priority: string | null;
	type: string | null;
	status: string;
	tombstone: boolean;
};

type RelationRow = {
	from_id: string;
	type: string;
	created_at: string;
};

type RevisionEntry = {
	id: string;
	tenant_id: string;
	revision: number;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
};

function pioneerType(type: string | null): string | null {
	if (type === "wayfinder-map") return "pioneer-map";
	if (type === "wayfinder-ticket") return "pioneer-ticket";
	return type;
}

function hashToHex(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

async function parentIdFor(conn: Parameters<Migration["up"]>[0], tenantId: string, entityId: string): Promise<string | null> {
	const relations = await conn.all<RelationRow>(sql`
		SELECT from_id, type, created_at
		FROM relations
		WHERE tenant_id = ${tenantId} AND to_id = ${entityId}
	`);
	return relations
		.filter(({ type }) => STRUCTURAL_RELATION_TYPES.includes(type as typeof STRUCTURAL_RELATION_TYPES[number]))
		.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.from_id.localeCompare(right.from_id))[0]?.from_id ?? null;
}

async function rewriteEntityHistory(conn: Parameters<Migration["up"]>[0], entity: EntityRow): Promise<void> {
	const entries = await conn.all<RevisionEntry>(sql`
		SELECT id, tenant_id, revision, patch_format, reverse_patch, source_hash, target_hash
		FROM revision_entries
		WHERE tenant_id = ${entity.tenant_id}
			AND record_kind = ${"entity"}
			AND record_key = ${`${Buffer.byteLength(entity.id, "utf8")}:${entity.id}`}
		ORDER BY revision DESC
	`);
	let successor = {
		title: entity.title,
		body: entity.body,
		bodySource: entity.body_source,
		category: entity.category,
		priority: entity.priority,
		type: entity.type,
		status: entity.status,
		parentId: await parentIdFor(conn, entity.tenant_id, entity.id),
		tombstone: entity.tombstone
	};

	for (const entry of entries) {
		let predecessor: typeof successor;
		try {
			predecessor = applyReverseFieldPatch(
				successor,
				{
					patchFormat: entry.patch_format,
					reversePatch: entry.reverse_patch,
					sourceHash: hashToHex(entry.source_hash),
					targetHash: hashToHex(entry.target_hash)
				},
				ENTITY_REVERSE_PATCH_REGISTRY
			);
		} catch (error) {
			const actualHash = computeCanonicalStateHash(successor, ENTITY_REVERSE_PATCH_REGISTRY);
			throw new Error(`Cannot rewrite Pioneer entity type history for ${entity.id} revision ${entry.revision}: reconstructed ${actualHash}, stored ${hashToHex(entry.source_hash)}, state ${JSON.stringify(successor)}.`, { cause: error });
		}
		const transition = createReverseFieldPatch(
			{ ...successor, type: pioneerType(successor.type) },
			{ ...predecessor, type: pioneerType(predecessor.type) },
			ENTITY_REVERSE_PATCH_REGISTRY
		);
		await conn.run(sql`
			UPDATE revision_entries
			SET patch_format = ${transition.patchFormat},
				reverse_patch = ${Buffer.from(transition.reversePatch)},
				source_hash = ${Buffer.from(transition.sourceHash, "hex")},
				target_hash = ${Buffer.from(transition.targetHash, "hex")}
			WHERE tenant_id = ${entry.tenant_id} AND id = ${entry.id}
		`);
		successor = predecessor;
	}
}

export const pioneerEntityTypesMigration: Migration = {
	id: "pioneer-entity-types",
	async up(conn) {
		if (conn.dialect !== "postgres") {
			throw new Error("Postgres Pioneer entity type migration requires the Postgres dialect.");
		}

		const entities = await conn.all<EntityRow>(sql`
			SELECT entity.tenant_id, entity.id, entity.title, entity.body, entity.body_source,
				entity.category, entity.priority, entity.type, entity.status, entity.tombstone
			FROM entities AS entity
			WHERE entity.kind = ${"issue"}
				AND (
					entity.type IN (${"wayfinder-map"}, ${"wayfinder-ticket"})
					OR EXISTS (
						SELECT 1 FROM revision_entries AS revision
						WHERE revision.tenant_id = entity.tenant_id
							AND revision.record_kind = ${"entity"}
							AND revision.record_key = octet_length(entity.id::text) || ':' || entity.id::text
							AND position(convert_to(${"wayfinder-"}, 'UTF8') IN revision.reverse_patch) > 0
					)
				)
		`);
		for (const entity of entities) {
			await rewriteEntityHistory(conn, entity);
			await conn.run(sql`
				UPDATE entities
				SET type = ${pioneerType(entity.type)}
				WHERE tenant_id = ${entity.tenant_id} AND id = ${entity.id}
			`);
		}
	}
};