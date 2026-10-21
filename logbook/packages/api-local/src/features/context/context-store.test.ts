import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { encodeContextRecordKey, encodeContextTermRecordKey, formatTenantDisplayName, sanitizePathSegment } from "@agent-issues/core";
import { defineContextTerm, forgetContextTerm, getContextDetails, getContextDirectory, listContexts, materializeContextRevision, materializeContextTermRevision, queryContextDirectory, upsertContext } from "./context-store.js";
import { ensureDatabase, resolveLegacyWorkspaceTenantId } from "../../db/database.js";
import type { SqliteInternalConnection } from "../../db/sqlite-executor.js";
import { createEntity, deleteEntity } from "../entity-store/store.js";

let tempDir: string | null = null;

async function openTestDatabase(): Promise<SqliteInternalConnection> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
	const { executor } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return executor;
}

async function seedProjectContext(
	dbPath: string,
	projectTitle: string,
	term?: { definition: string; term: string }
): Promise<string> {
	const { db } = await ensureDatabase(dbPath, {});
	try {
		const projectId = "PROJ1";
		const projectReference = "PROJ1";
		const contextId = "CTX1";
		const contextReference = "CTX1";
		const now = new Date().toISOString();
		db.drizzle.run(sql`
			INSERT INTO entities (tenant_id, id, reference, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at)
			VALUES (${db.tenantId}, ${projectId}, ${projectReference}, 'project', ${projectTitle}, 'active', '', 'authored', 1, '', 0, ${projectId}, ${now}, ${now})
		`);
		if (term) {
			db.drizzle.run(sql`
				INSERT INTO contexts (tenant_id, id, reference, key, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
				VALUES (${db.tenantId}, ${contextId}, ${contextReference}, ${`default:${projectId}`}, NULL, ${`${projectTitle} Context`}, '', 1, '', ${now}, ${now})
			`);
			db.drizzle.run(sql`
				INSERT INTO context_terms (tenant_id, id, context_key, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at)
				VALUES (${db.tenantId}, ${randomUUID()}, ${`default:${projectId}`}, ${term.term}, ${term.definition}, '', 1, '', 0, ${now}, ${now})
			`);
		}
		return projectId;
	} finally {
		db.close();
	}
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("context directory", () => {
	it("stores ordered context reverse patches that materialize predecessor facts and attribution", async () => {
		const db = await openTestDatabase();
		const created = upsertContext(db, { title: "Initial", summary: "First", author: "alice" });
		upsertContext(db, {
			title: "Updated",
			summary: "Second",
			author: "bob",
			expectedRevision: created.context.revision,
			expectedContentHash: created.context.contentHash
		});
		const storedContext = db.drizzle.get<{ id: string; reference: string }>(
			sql`SELECT id, reference FROM contexts WHERE tenant_id = ${db.tenantId} AND key = ${created.context.key}`
		) as { id: string; reference: string };
		expect(created.context.id).toBe(storedContext.id);
		expect(created.context.reference).toBe(storedContext.reference);
		expect(created.context.reference).toMatch(/^CTX_[0-9A-HJKMNP-TV-Z]{26}$/);

		const deltas = db.drizzle.all(sql`SELECT revision, author, patch_format, length(reverse_patch) AS patch_bytes, source_hash, target_hash, created_at
			FROM revision_entries
			WHERE tenant_id = ${db.tenantId} AND project_id = ${db.currentProjectId} AND record_kind = 'context' AND record_key = ${encodeContextRecordKey(storedContext.id)}
			ORDER BY revision`);
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: "system", patch_format: 1, patch_bytes: 0, source_hash: expect.any(Buffer), target_hash: expect.any(Buffer), created_at: expect.any(String) }),
			expect.objectContaining({ revision: 2, author: "system", patch_format: 1, patch_bytes: expect.any(Number), source_hash: expect.any(Buffer), target_hash: expect.any(Buffer), created_at: expect.any(String) })
		]);
		expect(materializeContextRevision(db, { revision: 1 })).toMatchObject({ title: "Initial", summary: "First", author: "system" });
	});

	it("stores one linear context-term reverse-delta chain through removal", async () => {
		const db = await openTestDatabase();
		const created = defineContextTerm(db, { term: "Order", definition: "Initial.", avoid: ["request"], author: "alice" });
		const updated = defineContextTerm(db, {
			term: "Order",
			definition: "Updated.",
			avoid: ["draft"],
			author: "bob",
			expectedRevision: created.term.revision,
			expectedContentHash: created.term.contentHash
		});
		forgetContextTerm(db, {
			term: "Order",
			author: "carol",
			expectedRevision: updated.term.revision,
			expectedContentHash: updated.term.contentHash
		});
		const storedTerm = db.drizzle.get<{ id: string }>(
			sql`SELECT id FROM context_terms WHERE tenant_id = ${db.tenantId} AND context_key = ${created.context.key} AND term = ${"Order"}`
		) as { id: string };
		expect(created.term.id).toBe(storedTerm.id);
		expect(created.term.reference).toMatch(/^TERM_[0-9A-HJKMNP-TV-Z]{26}$/);

		const deltas = db.drizzle.all(sql`SELECT revision, author, patch_format, length(reverse_patch) AS patch_bytes, source_hash, target_hash
			FROM revision_entries
			WHERE tenant_id = ${db.tenantId} AND project_id = ${db.currentProjectId} AND record_kind = 'context-term' AND record_key = ${encodeContextTermRecordKey(storedTerm.id)}
			ORDER BY revision`);
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: "system", patch_format: 1, patch_bytes: 0, source_hash: expect.any(Buffer), target_hash: expect.any(Buffer) }),
			expect.objectContaining({ revision: 2, author: "system", patch_format: 1, patch_bytes: expect.any(Number), source_hash: expect.any(Buffer), target_hash: expect.any(Buffer) }),
			expect.objectContaining({ revision: 3, author: "system", patch_format: 1, patch_bytes: expect.any(Number), source_hash: expect.any(Buffer), target_hash: expect.any(Buffer) })
		]);
		expect(materializeContextTermRevision(db, { term: "Order", revision: 1 })).toMatchObject({ definition: "Initial.", avoid: ["request"], tombstone: false, author: "system" });
		expect(materializeContextTermRevision(db, { term: "Order", revision: 2 })).toMatchObject({ definition: "Updated.", avoid: ["draft"], tombstone: false, author: "system" });
		expect(getContextDetails(db).terms).toEqual([]);
	});

	it("includes the shared glossary and initiative-scoped discovery with duplicate detection", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment-specific order.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id,
			avoid: ["queued run"]
		});

		const directory = getContextDirectory(db);

		expect(directory.shared.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(directory.initiatives).toHaveLength(1);
		expect(directory.duplicateTerms).toEqual(["Order"]);

		const order = directory.terms.find((entry) => entry.term === "Order");
		expect(order?.hasDuplicates).toBe(true);
		expect(order?.hasSharedSource).toBe(true);
		expect(order?.hasConflictingDefinitions).toBe(true);
		expect(order?.sources.map((source) => source.scopeLabel)).toEqual(["Shared", "Payments"]);

		const settlement = directory.terms.find((entry) => entry.term === "Settlement");
		expect(settlement?.hasDuplicates).toBe(false);
		expect(settlement?.sources[0]?.avoid).toEqual(["queued run"]);
	});

	it("keeps scoped context reads precise for initiative lookups", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Semantic Review" });

		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Stored review output for one target.",
			scopeRef: initiative.id
		});

		const details = getContextDetails(db, { scopeRef: initiative.id });

		expect(details.context.scopeKind).toBe("initiative");
		expect(details.context.scopeEntityId).toBe(initiative.id);
		expect(details.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});

	it("creates context at the project scope", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Console" });

		const created = upsertContext(db, {
			scopeRef: project.id,
			title: "Console Context",
			summary: "Project-wide language."
		});

		expect(created.context).toMatchObject({
			exists: true,
			key: `default:${project.id}`,
			scopeKind: "project",
			scopeEntityId: project.id,
			scopeLabel: "Console"
		});
	});

	it("lists only the active project's initiative contexts", async () => {
		const db = await openTestDatabase();
		const firstProject = createEntity(db, { kind: "project", title: "First" });
		const firstEpic = createEntity(db, { kind: "epic", parentId: firstProject.id, title: "First epic" });
		const firstInitiative = createEntity(db, { kind: "initiative", parentId: firstEpic.id, title: "First initiative" });
		const secondProject = createEntity(db, { kind: "project", title: "Second" });
		const secondEpic = createEntity(db, { kind: "epic", parentId: secondProject.id, title: "Second epic" });
		const secondInitiative = createEntity(db, { kind: "initiative", parentId: secondEpic.id, title: "Second initiative" });

		defineContextTerm(db, { scopeRef: firstInitiative.id, term: "First term", definition: "First project only." });
		defineContextTerm(db, { scopeRef: secondInitiative.id, term: "Second term", definition: "Second project only." });
		db.currentProjectId = secondProject.id;

		const listed = listContexts(db);
		const directory = getContextDirectory(db);

		expect(listed.contexts.map((entry) => entry.context.scopeEntityId)).toContain(secondInitiative.id);
		expect(listed.contexts.map((entry) => entry.context.scopeEntityId)).not.toContain(firstInitiative.id);
		expect(directory.initiatives.map((details) => details.context.scopeEntityId)).toEqual([secondInitiative.id]);
	});

	it("updates initiative contexts that retain a legacy key", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Net Migration" });
		const created = upsertContext(db, {
			scopeRef: initiative.reference,
			title: "Net Migration Context",
			summary: "Original summary."
		});
		db.drizzle.run(sql`UPDATE contexts SET key = ${"INIT15"} WHERE tenant_id = ${db.tenantId} AND scope_entity_id = ${initiative.id}`);

		const updated = upsertContext(db, {
			scopeRef: initiative.reference,
			title: "Migrate eye-share-devops to .NET 10 (Photino) Context",
			summary: "Glossary for backend parity ports and migration-specific behavior.",
			expectedRevision: created.context.revision,
			expectedContentHash: created.context.contentHash
		});

		expect(updated.context).toMatchObject({
			key: "INIT15",
			scopeEntityId: initiative.id,
			title: "Migrate eye-share-devops to .NET 10 (Photino) Context",
			revision: 2
		});
		expect(
			db.drizzle.get<{ count: number }>(
				sql`SELECT count(*) AS count FROM contexts WHERE tenant_id = ${db.tenantId} AND scope_entity_id = ${initiative.id}`
			)
		).toEqual({ count: 1 });
	});

	it("supports global-only search against shared context", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "admin", view: "global" });

		expect(result.shared?.terms.map((term) => term.term)).toEqual(["Administration"]);
		expect(result.initiatives).toEqual([]);
		expect(result.terms.map((term) => term.term)).toEqual(["Administration"]);
	});

	it("supports initiative-only search without returning shared matches", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Administration",
			definition: "Shared admin surface.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Shipment batch",
			definition: "Grouped dispatch.",
			scopeRef: shipping.id
		});

		const result = queryContextDirectory(db, { query: "settle", view: "initiatives" });

		expect(result.shared).toBeNull();
		expect(result.initiatives.map((details) => details.context.scopeLabel)).toEqual(["Payments"]);
		expect(result.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("supports conflicts-only queries", async () => {
		const db = await openTestDatabase();
		const payments = createEntity(db, { kind: "initiative", title: "Payments" });
		const shipping = createEntity(db, { kind: "initiative", title: "Shipping" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Canonical order.",
			scopeRef: "default"
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Payment order.",
			scopeRef: payments.id
		});
		defineContextTerm(db, {
			term: "Order",
			definition: "Shipping order.",
			scopeRef: shipping.id
		});
		defineContextTerm(db, {
			term: "Settlement",
			definition: "Captured funds.",
			scopeRef: payments.id
		});

		const result = queryContextDirectory(db, { conflictsOnly: true });

		expect(result.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(result.duplicateTerms).toEqual(["Order"]);
		expect(result.terms[0]?.sources).toHaveLength(3);
	});

	it("excludes deleted initiative contexts from conflicts-only queries", async () => {
		const db = await openTestDatabase();
		const deletedInitiative = createEntity(db, { kind: "initiative", title: "Deprecated payments" });

		defineContextTerm(db, {
			term: "Order",
			definition: "Deprecated payment order.",
			scopeRef: deletedInitiative.id
		});
		deleteEntity(db, { entityId: deletedInitiative.id });

		const result = queryContextDirectory(db, { conflictsOnly: true });

		expect(result.terms).toEqual([]);
		expect(result.duplicateTerms).toEqual([]);
	});

	it("avoids substring-only false positives during search", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		defineContextTerm(db, {
			term: "Asset Inspector",
			definition: "Shows preview affordances for the selected asset.",
			scopeRef: initiative.id
		});
		defineContextTerm(db, {
			term: "Review Snapshot",
			definition: "Captured review result.",
			scopeRef: initiative.id
		});

		const result = queryContextDirectory(db, { query: "review", view: "initiatives" });

		expect(result.terms.map((term) => term.term)).toEqual(["Review Snapshot"]);
	});
});

describe("project-aware default context (ISS166)", () => {
	it("resolves bare context scope to the current workspace's own project once the tenant holds many projects", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
		const dbPath = path.join(tempDir, "test.db");
		const workspaceA = mkdtempSync(path.join(tmpdir(), "agent-issues-workspace-a-"));

		try {
			const workspaceMappingId = resolveLegacyWorkspaceTenantId(workspaceA);
			const projectTitle = formatTenantDisplayName(workspaceMappingId);
			const projectId = await seedProjectContext(dbPath, projectTitle, {
				definition: "Workspace A's own widget.",
				term: "Widget"
			});

			const projectIdentity = sanitizePathSegment(projectTitle);
			const { executor: dbFromWorkspaceA } = await ensureDatabase(dbPath, { currentWorkingDirectory: workspaceA, projectIdentity });
			const details = getContextDetails(dbFromWorkspaceA, {});

			expect(details.context.key).toBe(`default:${projectId}`);
			expect(details.context.scopeLabel).toBe(projectTitle);
			expect(details.terms.map((term) => term.term)).toEqual(["Widget"]);
			dbFromWorkspaceA.close();

			await expect(ensureDatabase(dbPath, {})).rejects.toThrow(/project identity is required/i);
		} finally {
			rmSync(workspaceA, { force: true, recursive: true });
		}
	});

	it("resolves a project entity id passed as --scope to that project's own default context", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-context-"));
		const dbPath = path.join(tempDir, "test.db");
		const workspaceB = mkdtempSync(path.join(tmpdir(), "agent-issues-workspace-b-"));

		try {
			const workspaceMappingId = resolveLegacyWorkspaceTenantId(workspaceB);
			const projectTitle = formatTenantDisplayName(workspaceMappingId);
			const projectId = await seedProjectContext(dbPath, projectTitle);

			const { executor: sharedDb } = await ensureDatabase(dbPath, { projectIdentity: sanitizePathSegment(projectTitle) });

			const details = getContextDetails(sharedDb, { scopeRef: projectId });

			expect(details.context.key).toBe(`default:${projectId}`);
			expect(details.context.scopeLabel).toBe(projectTitle);
			sharedDb.close();
		} finally {
			rmSync(workspaceB, { force: true, recursive: true });
		}
	});
});