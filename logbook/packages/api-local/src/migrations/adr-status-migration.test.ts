import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
        createReverseFieldPatch,
        encodeEntityRecordKey,
        ENTITY_REVERSE_PATCH_REGISTRY
} from "@agent-issues/core";
import { ensureDatabase } from "../db/database.js";
import { encodeRevisionPatchHash } from "../db/revision-patch-hash.js";
import { runMigrations } from "../db/migration-runner.js";
import {
        createEntity,
        getEntityDetails,
        linkEntities,
        materializeEntityRevision
} from "../features/entity-store/store.js";
import { adrStatusMigration } from "./adr-status-migration.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
                rmSync(directory, { force: true, recursive: true });
        }
});

describe("ADR status migration", () => {
        it("resolves a late structural parent from the stored head hash", async () => {
                const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-adr-parent-"));
                temporaryDirectories.push(directory);
                const dbPath = path.join(directory, "test.db");
                const { executor } = await ensureDatabase(dbPath, { tenant: "migration-test" });
                executor.drizzle.run(sql`DELETE FROM schema_migrations WHERE id = ${adrStatusMigration.id}`);

                const parent = createEntity(executor, { kind: "initiative", title: "Parent" });
                const adr = createEntity(executor, { kind: "adr", title: "Decision" });
                linkEntities(executor, { fromId: parent.id, toId: adr.id, relationType: "records" });

                await runMigrations(executor, [adrStatusMigration]);

                expect(getEntityDetails(executor, adr.id).entity.id).toBe(adr.id);
                expect(materializeEntityRevision(executor, { entityId: adr.id, revision: 1 })).toMatchObject({
                        status: "current"
                });

                executor.close();
        });

        it("rewrites stored and historical ADR statuses while preserving derived superseded status", async () => {
                const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-adr-status-"));
                temporaryDirectories.push(directory);
                const dbPath = path.join(directory, "test.db");
                const { executor } = await ensureDatabase(dbPath, { tenant: "migration-test" });
                executor.drizzle.run(sql`DELETE FROM schema_migrations WHERE id = ${adrStatusMigration.id}`);

                const historicalAdr = createEntity(executor, { kind: "adr", title: "Historical decision" });
                const supersededAdr = createEntity(executor, { kind: "adr", title: "Old decision" });
                const replacementAdr = createEntity(executor, { kind: "adr", title: "New decision" });
                const proposedAdr = createEntity(executor, { kind: "adr", title: "Unreviewed decision" });
                linkEntities(executor, {
                        fromId: replacementAdr.id,
                        toId: supersededAdr.id,
                        relationType: "supersedes"
                });

                const successor = {
                        title: historicalAdr.title,
                        body: historicalAdr.body,
                        bodySource: historicalAdr.bodySource,
                        status: "accepted",
                        parentId: null,
                        tombstone: false
                };
                const predecessor = { ...successor, status: "proposed" };
                const transition = createReverseFieldPatch(
                        successor,
                        predecessor,
                        ENTITY_REVERSE_PATCH_REGISTRY
                );
                const baselineTransition = createReverseFieldPatch(
                        predecessor,
                        predecessor,
                        ENTITY_REVERSE_PATCH_REGISTRY
                );
                const now = new Date().toISOString();

                executor.drizzle.run(sql`
                        UPDATE entities
                        SET status = ${"accepted"}, revision = 2, updated_at = ${now}
                        WHERE id = ${historicalAdr.id}
                `);
                executor.drizzle.run(sql`
                        UPDATE entities SET status = ${"superseded"} WHERE id = ${supersededAdr.id}
                `);
                executor.drizzle.run(sql`
                        UPDATE entities SET status = ${"proposed"} WHERE id = ${proposedAdr.id}
                `);
                executor.drizzle.run(sql`
                        INSERT INTO revision_entries
                                (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
                        VALUES (
                                ${randomUUID()}, ${executor.tenantId}, ${executor.currentProjectId}, ${"entity"},
                                ${encodeEntityRecordKey(historicalAdr.id)}, 2, ${"migration-test"}, ${transition.patchFormat},
                                ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)},
                                ${encodeRevisionPatchHash(transition.targetHash)}, NULL, ${now}
                        )
                `);
                executor.drizzle.run(sql`
                        UPDATE revision_entries
                        SET reverse_patch = ${Buffer.from(baselineTransition.reversePatch)},
                                source_hash = ${encodeRevisionPatchHash(baselineTransition.sourceHash)},
                                target_hash = ${encodeRevisionPatchHash(baselineTransition.targetHash)}
                        WHERE tenant_id = ${executor.tenantId}
                                AND record_key = ${encodeEntityRecordKey(historicalAdr.id)}
                                AND revision = 1
                `);
                for (const [entity, status] of [
                        [supersededAdr, "superseded"],
                        [proposedAdr, "proposed"]
                ] as const) {
                        const baselineState = {
                                title: entity.title,
                                body: entity.body,
                                bodySource: entity.bodySource,
                                status,
                                parentId: null,
                                tombstone: false
                        };
                        const oldBaseline = createReverseFieldPatch(
                                baselineState,
                                baselineState,
                                ENTITY_REVERSE_PATCH_REGISTRY
                        );
                        executor.drizzle.run(sql`
                                UPDATE revision_entries
                                SET reverse_patch = ${Buffer.from(oldBaseline.reversePatch)},
                                        source_hash = ${encodeRevisionPatchHash(oldBaseline.sourceHash)},
                                        target_hash = ${encodeRevisionPatchHash(oldBaseline.targetHash)}
                                WHERE tenant_id = ${executor.tenantId}
                                        AND record_key = ${encodeEntityRecordKey(entity.id)}
                                        AND revision = 1
                        `);
                }

                await runMigrations(executor, [adrStatusMigration]);
                const firstPatch = executor.drizzle.get(sql`
                        SELECT reverse_patch, source_hash, target_hash
                        FROM revision_entries
                        WHERE record_key = ${encodeEntityRecordKey(historicalAdr.id)} AND revision = 2
                `);

                expect(executor.drizzle.all<{ status: string }>(sql`
                        SELECT status FROM entities WHERE kind = ${"adr"} ORDER BY id
                `).map(({ status }) => status)).toEqual(["current", "current", "current", "current"]);
                expect(getEntityDetails(executor, supersededAdr.id).entity.status).toBe("superseded");
                expect(materializeEntityRevision(executor, { entityId: historicalAdr.id, revision: 1 }).status).toBe("current");
                expect(materializeEntityRevision(executor, { entityId: historicalAdr.id, revision: 2 }).status).toBe("current");

                await runMigrations(executor, [adrStatusMigration]);
                expect(executor.drizzle.get(sql`
                        SELECT reverse_patch, source_hash, target_hash
                        FROM revision_entries
                        WHERE record_key = ${encodeEntityRecordKey(historicalAdr.id)} AND revision = 2
                `)).toEqual(firstPatch);

                executor.close();
        });
});