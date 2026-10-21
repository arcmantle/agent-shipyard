import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
        createReverseFieldPatch,
        encodeEntityRecordKey,
        ENTITY_REVERSE_PATCH_REGISTRY
} from "@agent-issues/core";
import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { PgStore } from "../pg-store.js";
import { adrStatusMigration } from "./adr-status-migration.js";

const ADMIN_CONNECTION_STRING =
        process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("Postgres ADR status migration", () => {
        let adminPool: Pool;

        beforeAll(() => {
                adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
        });

        afterAll(async () => {
                await adminPool.end();
        });

        it("rewrites stored and historical ADR statuses while preserving derived superseded status", async () => {
                const schemaName = `adr_status_${randomUUID().replace(/-/g, "_")}`;
                await adminPool.query(`CREATE SCHEMA ${schemaName}`);
                const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
                const tenantId = "migration-test";
                const projectId = randomUUID();
                const historicalId = randomUUID();
                const supersededId = randomUUID();
                const replacementId = randomUUID();
                const proposedId = randomUUID();
                const entities = [
                        [historicalId, "Historical decision", "accepted"],
                        [supersededId, "Old decision", "superseded"],
                        [replacementId, "New decision", "proposed"],
                        [proposedId, "Unreviewed decision", "proposed"]
                ] as const;

                try {
                        await migratePgDatabase(schemaPool);
                        await schemaPool.query("DELETE FROM schema_migrations WHERE id = $1", [adrStatusMigration.id]);
                        const now = new Date().toISOString();
                        await schemaPool.query(
                                `INSERT INTO entities
                                        (tenant_id, id, reference, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at)
                                 VALUES ($1, $2, $3, 'project', 'Migration project', 'draft', '', 'authored', 1, '', false, $2, $4, $4)`,
                                [tenantId, projectId, projectId, now]
                        );

                        for (const [id, title, status] of entities) {
                                await schemaPool.query(
                                        `INSERT INTO entities
                                                (tenant_id, id, reference, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at)
                                         VALUES ($1, $2, $3, 'adr', $4, $5, '', 'authored', 1, '', false, $6, $7, $7)`,
                                        [tenantId, id, id, title, status, projectId, now]
                                );
                                const baselineStatus = id === historicalId ? "proposed" : status;
                                const state = { title, body: "", bodySource: "authored", status: baselineStatus, parentId: null, tombstone: false };
                                const baseline = createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY);
                                await schemaPool.query(
                                        `INSERT INTO revision_entries
                                                (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
                                         VALUES ($1, $2, $3, 'entity', $4, 1, 'migration-test', $5, $6, $7, $8, NULL, $9)`,
                                        [randomUUID(), tenantId, projectId, encodeEntityRecordKey(id), baseline.patchFormat, Buffer.from(baseline.reversePatch), Buffer.from(baseline.sourceHash, "hex"), Buffer.from(baseline.targetHash, "hex"), now]
                                );
                        }

                        await schemaPool.query(
                                "INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES ($1, $2, $3, 'supersedes', $4)",
                                [tenantId, replacementId, supersededId, now]
                        );
                        const successor = { title: "Historical decision", body: "", bodySource: "authored", status: "accepted", parentId: null, tombstone: false };
                        const predecessor = { ...successor, status: "proposed" };
                        const transition = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
                        await schemaPool.query("UPDATE entities SET revision = 2 WHERE tenant_id = $1 AND id = $2", [tenantId, historicalId]);
                        await schemaPool.query(
                                `INSERT INTO revision_entries
                                        (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
                                 VALUES ($1, $2, $3, 'entity', $4, 2, 'migration-test', $5, $6, $7, $8, NULL, $9)`,
                                [randomUUID(), tenantId, projectId, encodeEntityRecordKey(historicalId), transition.patchFormat, Buffer.from(transition.reversePatch), Buffer.from(transition.sourceHash, "hex"), Buffer.from(transition.targetHash, "hex"), now]
                        );

                        await runMigrations(schemaPool, [adrStatusMigration]);
                        const firstPatch = await schemaPool.query(
                                "SELECT reverse_patch, source_hash, target_hash FROM revision_entries WHERE tenant_id = $1 AND record_key = $2 AND revision = 2",
                                [tenantId, encodeEntityRecordKey(historicalId)]
                        );
                        const statuses = await schemaPool.query("SELECT status FROM entities WHERE tenant_id = $1 AND kind = 'adr'", [tenantId]);
                        expect(statuses.rows).toHaveLength(4);
                        expect(statuses.rows.every(({ status }) => status === "current")).toBe(true);

                        const store = new PgStore(schemaPool, tenantId, projectId);
                        expect((await store.getEntityDetails(supersededId)).entity.status).toBe("superseded");
                        await expect(store.materializeEntityRevision({ entityId: historicalId, revision: 1 })).resolves.toMatchObject({ status: "current" });
                        await expect(store.materializeEntityRevision({ entityId: historicalId, revision: 2 })).resolves.toMatchObject({ status: "current" });

                        await runMigrations(schemaPool, [adrStatusMigration]);
                        const secondPatch = await schemaPool.query(
                                "SELECT reverse_patch, source_hash, target_hash FROM revision_entries WHERE tenant_id = $1 AND record_key = $2 AND revision = 2",
                                [tenantId, encodeEntityRecordKey(historicalId)]
                        );
                        expect(secondPatch.rows).toEqual(firstPatch.rows);
                } finally {
                        await schemaPool.end();
                        await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
                }
        });
});