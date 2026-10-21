import {
        applyReverseFieldPatch,
        createReverseFieldPatch,
        ENTITY_REVERSE_PATCH_REGISTRY,
        STRUCTURAL_RELATION_TYPES,
        type Migration
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

type EntityRow = {
        tenant_id: string;
        id: string;
        title: string;
        body: string;
        body_source: string;
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

function currentStatus(status: string): string {
        return status === "proposed" || status === "accepted" || status === "superseded"
                ? "current"
                : status;
}

function hashToHex(hash: Uint8Array): string {
        return Buffer.from(hash).toString("hex");
}

async function parentIdsFor(
        conn: Parameters<Migration["up"]>[0],
        tenantId: string,
        entityId: string
): Promise<string[]> {
        const relations = await conn.all<RelationRow>(sql`
                SELECT from_id, type, created_at
                FROM relations
                WHERE tenant_id = ${tenantId} AND to_id = ${entityId}
        `);
        return relations
                .filter(({ type }) => STRUCTURAL_RELATION_TYPES.includes(type as typeof STRUCTURAL_RELATION_TYPES[number]))
                .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.from_id.localeCompare(right.from_id))
                .map(({ from_id }) => from_id);
}

function resolveParentId(entity: EntityRow, parentIds: string[], sourceHash: string | undefined): string | null {
        if (!sourceHash) {
                return parentIds[0] ?? null;
        }

        const state = {
                title: entity.title,
                body: entity.body,
                bodySource: entity.body_source,
                status: entity.status,
                tombstone: entity.tombstone
        };
        const matches = [...new Set<string | null>([null, ...parentIds])].filter((parentId) =>
                createReverseFieldPatch({ ...state, parentId }, { ...state, parentId }, ENTITY_REVERSE_PATCH_REGISTRY).sourceHash === sourceHash
        );
        if (matches.length === 1) {
                return matches[0]!;
        }
        throw new Error(`Cannot uniquely resolve revision head parent for entity ${entity.id}`);
}

async function rewriteEntityHistory(
        conn: Parameters<Migration["up"]>[0],
        entity: EntityRow
): Promise<void> {
        const entries = await conn.all<RevisionEntry>(sql`
                SELECT id, tenant_id, revision, patch_format, reverse_patch, source_hash, target_hash
                FROM revision_entries
                WHERE tenant_id = ${entity.tenant_id}
                        AND record_kind = ${"entity"}
                        AND record_key = ${`${Buffer.byteLength(entity.id, "utf8")}:${entity.id}`}
                ORDER BY revision DESC
        `);
        const firstEntry = entries[0];
        let successor = {
                title: entity.title,
                body: entity.body,
                bodySource: entity.body_source,
                status: entity.status,
                parentId: resolveParentId(entity, await parentIdsFor(conn, entity.tenant_id, entity.id), firstEntry ? hashToHex(firstEntry.source_hash) : undefined),
                tombstone: entity.tombstone
        };

        for (const entry of entries) {
                const predecessor = applyReverseFieldPatch(
                        successor,
                        {
                                patchFormat: entry.patch_format,
                                reversePatch: entry.reverse_patch,
                                sourceHash: hashToHex(entry.source_hash),
                                targetHash: hashToHex(entry.target_hash)
                        },
                        ENTITY_REVERSE_PATCH_REGISTRY
                );
                const transition = createReverseFieldPatch(
                        { ...successor, status: currentStatus(successor.status) },
                        { ...predecessor, status: currentStatus(predecessor.status) },
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

export const adrStatusMigration: Migration = {
        id: "adr-status-to-current",
        async up(conn) {
                const entities = await conn.all<EntityRow>(sql`
                        SELECT tenant_id, id, title, body, body_source, status, tombstone
                        FROM entities
                        WHERE kind = ${"adr"}
                `);
                for (const entity of entities) {
                        await rewriteEntityHistory(conn, entity);
                        await conn.run(sql`
                                UPDATE entities
                                SET status = ${currentStatus(entity.status)}
                                WHERE tenant_id = ${entity.tenant_id} AND id = ${entity.id}
                        `);
                }
        }
};