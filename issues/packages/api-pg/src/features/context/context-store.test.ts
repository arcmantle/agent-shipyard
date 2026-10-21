import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { deriveUserIdentity, encodeContextRecordKey, encodeContextTermRecordKey, SYSTEM_AUTHENTICATION_SUBJECT } from "@agent-issues/core";

import { createPgPool, migratePgDatabase, withTenantTransaction } from "../../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../../db/test-tenant-cleanup.js";
import { PgStore } from "../../pg-store.js";
import { contexts, contextTerms, revisionEntries } from "../../schema.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";
const SYSTEM_USER_ID = deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id;

describe("context and glossary", () => {
	let adminPool: Pool;
	let appPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	it("upserts a context's title and summary, defaulting when not yet configured", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		const beforeUpsert = await store.getContextDetails({ scopeRef: initiative.id });
		expect(beforeUpsert.context.exists).toBe(false);
		expect(beforeUpsert.context.title).toBe("Payments Context");

		const updated = await store.upsertContext({ scopeRef: initiative.id, title: "Custom title", summary: "Custom summary" });
		expect(updated.context.exists).toBe(true);
		expect(updated.context.title).toBe("Custom title");
		expect(updated.context.scopeKind).toBe("initiative");
		expect(updated.context.scopeEntityId).toBe(initiative.id);
		expect((await store.getContextDetails({ scopeRef: initiative.id })).context.summary).toBe("Custom summary");
	});

	it("updates initiative contexts that retain a legacy key", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Net Migration" });
		const created = await store.upsertContext({
			scopeRef: initiative.reference,
			title: "Net Migration Context",
			summary: "Original summary."
		});
		await withTenantTransaction(appPool, store.tenantId, async (client) => {
			await client.update(contexts)
				.set({ key: "INIT15" })
				.where(and(eq(contexts.tenantId, store.tenantId), eq(contexts.scopeEntityId, initiative.id)));
		});

		const updated = await store.upsertContext({
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
		const listed = await store.listContexts();
		expect(listed.contexts.find((entry) => entry.context.scopeEntityId === initiative.id)?.context).toMatchObject({
			key: "INIT15",
			title: "Migrate eye-share-devops to .NET 10 (Photino) Context"
		});
	});

	it("stores ordered context reverse patches that materialize predecessor facts and attribution", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const created = await store.upsertContext({ title: "Initial", summary: "First", author: "alice" });
		await store.upsertContext({
			title: "Updated",
			summary: "Second",
			author: "bob",
			expectedRevision: created.context.revision,
			expectedContentHash: created.context.contentHash
		});

		const deltas = await withTenantTransaction(appPool, store.tenantId, async (client) => {
			const [context] = await client.select({ id: contexts.id }).from(contexts).where(and(eq(contexts.tenantId, store.tenantId), eq(contexts.key, created.context.key)));
			return client.select().from(revisionEntries)
				.where(and(eq(revisionEntries.tenantId, store.tenantId), eq(revisionEntries.recordKind, "context"), eq(revisionEntries.recordKey, encodeContextRecordKey(context!.id))))
				.orderBy(revisionEntries.revision)
		});
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: SYSTEM_USER_ID, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer), createdAt: expect.any(String) }),
			expect.objectContaining({ revision: 2, author: SYSTEM_USER_ID, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer), createdAt: expect.any(String) })
		]);
		expect(deltas[0]?.reversePatch.byteLength).toBe(0);
		await expect(store.materializeContextRevision({ revision: 1 })).resolves.toMatchObject({ title: "Initial", summary: "First", author: SYSTEM_USER_ID });
	});

	it("defines a context term, auto-creating the context, and reports created vs. updated", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		const created = await store.defineContextTerm({
			scopeRef: initiative.id,
			term: "storage-driver seam",
			definition: "The engine-agnostic boundary the domain layer talks to."
		});
		expect(created.created).toBe(true);
		expect(created.context.exists).toBe(true);
		expect(created.term.term).toBe("storage-driver seam");

		const updated = await store.defineContextTerm({
			scopeRef: initiative.id,
			term: "storage-driver seam",
			definition: "Updated definition.",
			avoid: ["seam", "storage-driver seam", " duplicate ", "duplicate"],
			author: "bob",
			expectedRevision: created.term.revision,
			expectedContentHash: created.term.contentHash
		});
		expect(created.term.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(created.term.reference).toMatch(/^TERM_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(updated.term.id).toBe(created.term.id);
		expect(updated.created).toBe(false);
		expect(updated.term.avoid).toEqual(["seam", "duplicate"]);
		const storedTerm = (await store.getContextDetails({ scopeRef: initiative.id })).terms.find((term) => term.id === updated.term.id);
		expect(storedTerm?.definition).toBe("Updated definition.");

		const deltas = await withTenantTransaction(appPool, store.tenantId, async (client) => {
			const [term] = await client.select({ stableId: contextTerms.id }).from(contextTerms).where(and(eq(contextTerms.tenantId, store.tenantId), eq(contextTerms.contextKey, created.context.key), eq(contextTerms.term, created.term.term)));
			return client.select().from(revisionEntries)
				.where(and(eq(revisionEntries.tenantId, store.tenantId), eq(revisionEntries.recordKind, "context-term"), eq(revisionEntries.recordKey, encodeContextTermRecordKey(term!.stableId))))
				.orderBy(revisionEntries.revision)
		});
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, author: SYSTEM_USER_ID, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer) }),
			expect.objectContaining({ revision: 2, author: SYSTEM_USER_ID, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer) })
		]);
		await expect(store.materializeContextTermRevision({ scopeRef: initiative.id, term: "storage-driver seam", revision: 1 })).resolves.toMatchObject({ definition: "The engine-agnostic boundary the domain layer talks to.", tombstone: false, author: SYSTEM_USER_ID });
	});

	it("rejects an empty term or definition", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await expect(store.defineContextTerm({ scopeRef: initiative.id, term: "  ", definition: "x" })).rejects.toThrow(/term/i);
		await expect(store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "  " })).rejects.toThrow(/definition/i);
	});

	it("forgets a context term", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		const created = await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const forgotten = await store.forgetContextTerm({
			scopeRef: initiative.id,
			term: "Settlement",
			author: "alice",
			expectedRevision: created.term.revision,
			expectedContentHash: created.term.contentHash
		});
		expect(forgotten.removed).toBe(true);

		const details = await store.getContextDetails({ scopeRef: initiative.id });
		expect(details.terms).toHaveLength(0);

		const forgottenAgain = await store.forgetContextTerm({
			scopeRef: initiative.id,
			term: "Settlement",
			expectedRevision: forgotten.currentRevision,
			expectedContentHash: forgotten.currentContentHash
		});
		expect(forgottenAgain.removed).toBe(false);

		const deltas = await withTenantTransaction(appPool, store.tenantId, async (client) => {
			const [term] = await client.select({ stableId: contextTerms.id }).from(contextTerms).where(and(eq(contextTerms.tenantId, store.tenantId), eq(contextTerms.contextKey, created.context.key), eq(contextTerms.term, created.term.term)));
			return client.select().from(revisionEntries)
				.where(and(eq(revisionEntries.tenantId, store.tenantId), eq(revisionEntries.recordKind, "context-term"), eq(revisionEntries.recordKey, encodeContextTermRecordKey(term!.stableId))))
				.orderBy(revisionEntries.revision)
		});
		expect(deltas).toEqual([
			expect.objectContaining({ revision: 1, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer) }),
			expect.objectContaining({ revision: 2, author: SYSTEM_USER_ID, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer) })
		]);
		await expect(store.materializeContextTermRevision({ scopeRef: initiative.id, term: "Settlement", revision: 1 })).resolves.toMatchObject({ definition: "Captured funds.", tombstone: false });
	});

	it("resolves a non-initiative scopeRef to its owning initiative's context", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Ship it" });

		await store.defineContextTerm({ scopeRef: issue.id, term: "Settlement", definition: "Captured funds." });

		const details = await store.getContextDetails({ scopeRef: initiative.id });
		expect(details.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("creates context at the project scope", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const project = await store.createEntity({ kind: "project", title: "Console" });

		const created = await store.upsertContext({
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
		const tenantId = createTestTenantId();
		const firstStore = new PgStore(appPool, tenantId, "first-project");
		const secondStore = new PgStore(appPool, tenantId, "second-project");
		const firstInitiative = await firstStore.createEntity({ kind: "initiative", title: "First initiative" });
		const secondInitiative = await secondStore.createEntity({ kind: "initiative", title: "Second initiative" });

		await firstStore.defineContextTerm({ scopeRef: firstInitiative.id, term: "First term", definition: "First project only." });
		await secondStore.defineContextTerm({ scopeRef: secondInitiative.id, term: "Second term", definition: "Second project only." });

		const listed = await secondStore.listContexts();
		const directory = await secondStore.getContextDirectory();

		expect(listed.contexts.map((entry) => entry.context.scopeEntityId)).toContain(secondInitiative.id);
		expect(listed.contexts.map((entry) => entry.context.scopeEntityId)).not.toContain(firstInitiative.id);
		expect(directory.initiatives.map((details) => details.context.scopeEntityId)).toEqual([secondInitiative.id]);
	});

	it("lists contexts with term counts for shared and each initiative", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const listed = await store.listContexts();
		const shared = listed.contexts.find((entry) => entry.context.scopeKind === "default");
		const scoped = listed.contexts.find((entry) => entry.context.scopeEntityId === initiative.id);

		expect(shared?.termCount).toBe(1);
		expect(scoped?.termCount).toBe(1);
	});

	it("builds a context directory with duplicate and conflicting-definition detection", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Order", definition: "Payment-specific order." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds.", avoid: ["queued run"] });

		const directory = await store.getContextDirectory();

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

	it("supports global-only and initiative-only directory search views", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });

		await store.defineContextTerm({ scopeRef: "default", term: "Administration", definition: "Shared admin surface." });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const globalResult = await store.queryContextDirectory({ query: "admin", view: "global" });
		expect(globalResult.shared?.terms.map((term) => term.term)).toEqual(["Administration"]);
		expect(globalResult.initiatives).toEqual([]);
		expect(globalResult.terms.map((term) => term.term)).toEqual(["Administration"]);

		const initiativesResult = await store.queryContextDirectory({ query: "settle", view: "initiatives" });
		expect(initiativesResult.shared).toBeNull();
		expect(initiativesResult.initiatives.map((details) => details.context.scopeLabel)).toEqual(["Payments"]);
		expect(initiativesResult.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("supports conflicts-only queries", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const payments = await store.createEntity({ kind: "initiative", title: "Payments" });
		const shipping = await store.createEntity({ kind: "initiative", title: "Shipping" });

		await store.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Canonical order." });
		await store.defineContextTerm({ scopeRef: payments.id, term: "Order", definition: "Payment order." });
		await store.defineContextTerm({ scopeRef: shipping.id, term: "Order", definition: "Shipping order." });
		await store.defineContextTerm({ scopeRef: payments.id, term: "Settlement", definition: "Captured funds." });

		const result = await store.queryContextDirectory({ conflictsOnly: true });

		expect(result.terms.map((term) => term.term)).toEqual(["Order"]);
		expect(result.duplicateTerms).toEqual(["Order"]);
		expect(result.terms[0]?.sources).toHaveLength(3);
	});

	it("excludes deleted initiative contexts from conflicts-only queries", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const deletedInitiative = await store.createEntity({ kind: "initiative", title: "Deprecated payments" });

		await store.defineContextTerm({
			term: "Order",
			definition: "Deprecated payment order.",
			scopeRef: deletedInitiative.id
		});
		await store.deleteEntity({ entityId: deletedInitiative.id });

		const result = await store.queryContextDirectory({ conflictsOnly: true });

		expect(result.terms).toEqual([]);
		expect(result.duplicateTerms).toEqual([]);
	});

	it("exposes real context data in the database snapshot", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
		await store.defineContextTerm({ scopeRef: initiative.id, term: "Settlement", definition: "Captured funds." });

		const snapshot = await store.getDatabaseSnapshot();
		const initiativeContext = snapshot.contexts.initiatives.find((entry) => entry.context.scopeEntityId === initiative.id);

		expect(initiativeContext?.terms.map((term) => term.term)).toEqual(["Settlement"]);
	});

	it("keeps context data isolated per tenant", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.defineContextTerm({ scopeRef: "default", term: "Order", definition: "Tenant A's order." });

		const detailsForB = await storeB.getContextDetails();
		expect(detailsForB.terms).toHaveLength(0);

		const detailsForA = await storeA.getContextDetails();
		expect(detailsForA.terms.map((term) => term.term)).toEqual(["Order"]);
	});

	it("resolves the bare default scope to the tenant sentinel when no projectIdentity is set (no regression)", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);

		const details = await store.getContextDetails();
		expect(details.context.scopeKind).toBe("default");
		expect(details.context.scopeLabel).toBe("Shared");
	});

	it("resolves the bare default scope to the current project's own shared glossary when projectIdentity is set (ISS183)", async () => {
		const tenantId = createTestTenantId();
		const storeForRepoA = new PgStore(appPool, tenantId, "repo-a");
		const storeForRepoB = new PgStore(appPool, tenantId, "repo-b");

		await storeForRepoA.defineContextTerm({ term: "Order", definition: "Repo A's order." });
		await storeForRepoB.defineContextTerm({ term: "Order", definition: "Repo B's order." });

		const detailsForA = await storeForRepoA.getContextDetails();
		const detailsForB = await storeForRepoB.getContextDetails();

		expect(detailsForA.context.scopeLabel).toBe("repo-a");
		expect(detailsForA.terms.map((term) => term.definition)).toEqual(["Repo A's order."]);
		expect(detailsForB.context.scopeLabel).toBe("repo-b");
		expect(detailsForB.terms.map((term) => term.definition)).toEqual(["Repo B's order."]);
	});

	it("reuses the same project entity across calls for the same projectIdentity instead of minting a new one each time", async () => {
		const tenantId = createTestTenantId();
		const firstOpen = new PgStore(appPool, tenantId, "repo-a");
		const secondOpen = new PgStore(appPool, tenantId, "repo-a");

		const firstDetails = await firstOpen.getContextDetails();
		await secondOpen.defineContextTerm({ term: "Order", definition: "Repo A's order." });
		const secondDetails = await secondOpen.getContextDetails();

		expect(secondDetails.context.key).toBe(firstDetails.context.key);
	});
});
