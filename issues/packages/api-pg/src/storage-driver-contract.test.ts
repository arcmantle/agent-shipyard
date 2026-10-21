import { createHash, randomUUID } from "node:crypto";

import { CompletionObservationConflictError, createReverseFieldPatch, encodeCanonicalReference, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, IssueCommentConflictError, type CompletionObservation, type StorageDriver } from "@agent-issues/core";
import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced (Postgres superusers bypass RLS
// unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const schemaName = `storage_contract_${randomUUID().replace(/-/g, "_")}`;
const schemaOptions = `-c search_path=${schemaName}`;
let adminPool: Pool;

beforeAll(async () => {
	adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: schemaOptions });
	const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await databasePool.query(`CREATE SCHEMA ${schemaName}`);
		await migratePgDatabase(adminPool);
		await databasePool.query(`GRANT USAGE ON SCHEMA ${schemaName} TO agent_issues_app`);
		await databasePool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO agent_issues_app`);
	} finally {
		await databasePool.end();
	}
});

afterAll(async () => {
	try {
		await cleanupTestTenants(adminPool);
	} finally {
		await adminPool.end();
		const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		try {
			await databasePool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		} finally {
			await databasePool.end();
		}
	}
});

// Every store in this suite gets its own dedicated pool (rather than the
// single shared `appPool` `pg-store.test.ts` uses) because `PgStore.close()`
// ends the whole pool it was given, and the shared contract's lifecycle
// test deliberately calls `close()` and expects only that one store's
// connection to be gone. Each contract test closes its own store (and thus
// its own pool) in a `finally`, so no extra teardown is needed here.
async function openPgTestStore(): Promise<StorageDriver> {
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, createTestTenantId());
}

// Shares one tenant across the identities a single contract test opens, so
// the separation it asserts is genuinely project-level and not tenant-level.
let contractTenantId: string | undefined;
async function openPgTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
	contractTenantId ??= createTestTenantId();
	const pool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	return new PgStore(pool, contractTenantId, projectIdentity);
}

beforeEach(() => {
	contractTenantId = undefined;
});

runStorageDriverContractSuite({
	label: "PgStore (Postgres)",
	openStore: openPgTestStore,
	openStoreForProject: openPgTestStoreForProject
});

it("searches every supported source type and applies source filters", async () => {
	const store = await openPgTestStore();

	try {
		const initiative = await store.createEntity({ kind: "initiative", title: "Search initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Search plan", parentId: initiative.id });
		const issue = await store.createEntity({ kind: "issue", title: "Search issue", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Search Plan entry." });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Search issue comment." });
		const { context } = await store.upsertContext({ scopeRef: initiative.id, title: "Search context", summary: "Search context summary." });
		const { term } = await store.defineContextTerm({ scopeRef: initiative.id, term: "Search term", definition: "Search context term." });
		expect(entry.reference).not.toBeNull();
		expect(comment.reference).not.toBeNull();
		expect(context.reference).not.toBeNull();
		expect(term.reference).not.toBeNull();

		for (const [reference, sourceType] of [
			[entry.reference!, "plan-entry"],
			[comment.reference!, "issue-comment"],
			[context.reference!, "context"],
			[term.reference!, "context-term"]
		] as const) {
			await expect(store.search({ query: reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceType }) })]
			}));
		}
		for (const [query, sourceId, sourceType] of [
			['"search plan entry"', entry.id, "plan-entry"],
			['"search issue comment"', comment.id, "issue-comment"]
		] as const) {
			await expect(store.search({ query, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId, sourceType }), match: { field: "body" } })]
			}));
		}

		await expect(store.search({
			query: entry.reference,
			scope: { type: "all-projects" },
			filters: { sourceTypes: ["entity"] }
		})).resolves.toEqual({ state: "available", results: [] });
	} finally {
		await store.close();
	}
});

it("searches visible Markdown body text", async () => {
	const store = await openPgTestStore();

	try {
		const entity = await store.createEntity({
			kind: "initiative",
			title: "Markdown search",
			body: "# Visible heading\n\n[Visible label](https://example.com) and `visibleCode`."
		});

		await expect(store.search({ query: "visible label", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
			state: "available",
			results: [expect.objectContaining({
				identity: expect.objectContaining({ sourceId: entity.id }),
				match: { field: "body" },
				snippet: expect.objectContaining({ text: expect.stringContaining("Visible heading Visible label and visibleCode") })
			})]
		}));
	} finally {
		await store.close();
	}
});

it("searches a strict phrase through the indexed PostgreSQL query path", async () => {
	const store = await openPgTestStore();

	try {
		const entity = await store.createEntity({
			kind: "initiative",
			title: "Indexed search",
			body: "A distinct indexed phrase is present."
		});

		await expect(store.search({ query: '"indexed phrase"', scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
			state: "available",
			results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }), match: { field: "body" } })]
		}));
	} finally {
		await store.close();
	}
});

it("imports and exports a canonical issue comment with its ordered references", async () => {
	const store = await openPgTestStore();
	try {
		const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
		const referencedIssue = await store.createEntity({ kind: "issue", title: "Referenced issue" });
		const id = randomUUID();
		const reference = encodeCanonicalReference("issueComment", id);
		const body = "Needs a follow-up.";
		const referencedIssueIds = [referencedIssue.id];
		const now = "2026-08-08T00:00:00.000Z";
		const bundle = await store.exportCanonicalChains();
		await store.importCanonicalChains({
			...bundle,
			issueComments: [{
				head: {
					id,
					reference,
					issueId: issue.id,
					createdBy: issue.createdBy,
					updatedBy: issue.updatedBy,
					body,
					referencedIssueIds,
					tombstone: false,
					revision: 1,
					contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds, tombstone: false })).digest("hex"),
					createdAt: now,
					updatedAt: now
				},
				deltas: []
			}]
		});

		expect((await store.exportCanonicalChains()).issueComments).toEqual(expect.arrayContaining([
			expect.objectContaining({ head: expect.objectContaining({ id, reference, issueId: issue.id, referencedIssueIds }) })
		]));

		const updatedReferencedIssueIds: string[] = [];
		const updatedAt = "2026-08-08T01:00:00.000Z";
		const updatedComment = {
			head: {
				id,
				reference,
				issueId: issue.id,
				createdBy: issue.createdBy,
				updatedBy: issue.updatedBy,
				body,
				referencedIssueIds: updatedReferencedIssueIds,
				tombstone: false,
				revision: 2,
				contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false })).digest("hex"),
				createdAt: now,
				updatedAt
			},
			deltas: [{
				id: randomUUID(),
				revision: 2,
				author: issue.updatedBy,
				createdAt: updatedAt,
				...createReverseFieldPatch(
					{ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false },
					{ body, referencedIssueIds, tombstone: false },
					ISSUE_COMMENT_REVERSE_PATCH_REGISTRY
				)
			}]
		};
		const updatedBundle = await store.exportCanonicalChains();
		await store.importCanonicalChains({ ...updatedBundle, issueComments: [updatedComment] });

		expect((await store.exportCanonicalChains()).issueComments.find((chain) => chain.head.id === id)).toMatchObject({
			head: { referencedIssueIds: [] },
			deltas: [expect.objectContaining({ revision: 2 })]
		});
	} finally {
		await store.close();
	}
});

it("exports canonical Plan entries with their entity references and supersessions", async () => {
	const store = await openPgTestStore();
	try {
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
		const referencedEntity = await store.createEntity({ kind: "issue", title: "Referenced issue", parentId: initiative.id });
		const question = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which backend owns synchronization?" });
		const decision = await store.createPlanEntry({
			planId: plan.id,
			role: "decision",
			body: "Both backends use canonical chains.",
			referencedEntityIds: [referencedEntity.id],
			supersededEntryIds: [question.id]
		});

		expect((await store.exportCanonicalChains()).planEntries).toEqual(expect.arrayContaining([
			expect.objectContaining({ head: expect.objectContaining({ id: question.id, planId: plan.id, role: "question" }) }),
			expect.objectContaining({ head: expect.objectContaining({ id: decision.id, referencedEntityIds: [referencedEntity.id], supersededEntryIds: [question.id] }) })
		]));
	} finally {
		await store.close();
	}
});

it("preserves Plan-entry supersession creation order after an update", async () => {
	const store = await openPgTestStore();
	try {
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
		const firstQuestion = await store.createPlanEntry({ planId: plan.id, role: "question", body: "First question" });
		const secondQuestion = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Second question" });
		const supersededEntryIds = [firstQuestion.id, secondQuestion.id].sort().reverse();
		const decision = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Initial decision", supersededEntryIds });
		await store.updatePlanEntry({ entryId: decision.id, body: "Updated decision", expectedRevision: decision.revision, expectedContentHash: decision.contentHash });

		expect((await store.exportCanonicalChains()).planEntries.find((chain) => chain.head.id === decision.id)?.head).toMatchObject({
			body: "Updated decision",
			supersededEntryIds
		});
	} finally {
		await store.close();
	}
});

it("makes concurrent completion-observation imports idempotent", async () => {
	const tenantId = createTestTenantId();
	const firstStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	const secondStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	try {
		const issue = await firstStore.createEntity({ kind: "issue", title: "Concurrent observation" });
		const observation = createCompletionObservation(issue.id);
		const bundle = { ...(await firstStore.exportCanonicalChains()), completionObservations: [observation] };

		const results = await Promise.all([
			firstStore.importCanonicalChains(bundle),
			secondStore.importCanonicalChains(bundle)
		]);

		expect(results.map((result) => result.completionObservationsCreated)).toEqual(expect.arrayContaining([[observation.id], []]));
		expect((await firstStore.getEntityDetails(issue.id)).completionObservations).toEqual([observation]);
	} finally {
		await Promise.all([firstStore.close(), secondStore.close()]);
	}
});

it("reports an immutable-fact conflict for concurrent completion-observation imports", async () => {
	const tenantId = createTestTenantId();
	const firstStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	const secondStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	try {
		const issue = await firstStore.createEntity({ kind: "issue", title: "Conflicting concurrent observation" });
		const observation = createCompletionObservation(issue.id);
		const conflictingObservation = { ...observation, calculatedVersion: "2.0.0" };
		const bundle = await firstStore.exportCanonicalChains();

		const outcomes = await Promise.allSettled([
			firstStore.importCanonicalChains({ ...bundle, completionObservations: [observation] }),
			secondStore.importCanonicalChains({ ...bundle, completionObservations: [conflictingObservation] })
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.find((outcome) => outcome.status === "rejected")?.reason).toBeInstanceOf(CompletionObservationConflictError);
	} finally {
		await Promise.all([firstStore.close(), secondStore.close()]);
	}
});

function createCompletionObservation(issueId: string): CompletionObservation {
	return {
		id: randomUUID(),
		issueId,
		completionOrdinal: 1,
		repositoryIdentity: "a".repeat(64),
		commitSha: "b".repeat(40),
		branch: "main",
		dirty: false,
		capturedAt: "2026-09-23T14:00:00.000Z",
		calculatedVersionState: "available",
		calculatedVersion: "1.0.0",
		diagnostics: []
	};
}

it("reads an issue conversation without canonical-export tables", async () => {
	const store = await openPgTestStore();
	try {
		const issue = await store.createEntity({ kind: "issue", title: "Direct conversation read" });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Read this comment." });
		await adminPool.query("REVOKE SELECT ON contexts FROM agent_issues_app");

		await expect(store.listIssueComments({ issueId: issue.id })).resolves.toEqual(expect.objectContaining({
			comments: [expect.objectContaining({ id: comment.id, body: "Read this comment." })]
		}));
	} finally {
		await adminPool.query("GRANT SELECT ON contexts TO agent_issues_app");
		await store.close();
	}
});

it("reads comment history without canonical-export tables", async () => {
	const store = await openPgTestStore();
	try {
		const issue = await store.createEntity({ kind: "issue", title: "Direct history read" });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "First revision." });
		await store.updateIssueComment({
			commentId: comment.id,
			body: "Second revision.",
			expectedRevision: comment.revision,
			expectedContentHash: comment.contentHash
		});
		await adminPool.query("REVOKE SELECT ON contexts FROM agent_issues_app");

		await expect(store.listIssueCommentHistory({ commentId: comment.id })).resolves.toEqual([
			expect.objectContaining({ targetRevision: 1, body: "First revision." }),
			expect.objectContaining({ targetRevision: 2, body: "Second revision." })
		]);
	} finally {
		await adminPool.query("GRANT SELECT ON contexts TO agent_issues_app");
		await store.close();
	}
});

it("allows only one concurrent comment edit from the same revision", async () => {
	const tenantId = createTestTenantId();
	const firstStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	const secondStore = new PgStore(new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }), tenantId);
	try {
		const issue = await firstStore.createEntity({ kind: "issue", title: "Concurrent comment edit" });
		const comment = await firstStore.createIssueComment({ issueId: issue.id, body: "Original comment." });

		const outcomes = await Promise.allSettled([
			firstStore.updateIssueComment({
				commentId: comment.id,
				body: "First update.",
				expectedRevision: comment.revision,
				expectedContentHash: comment.contentHash
			}),
			secondStore.updateIssueComment({
				commentId: comment.id,
				body: "Second update.",
				expectedRevision: comment.revision,
				expectedContentHash: comment.contentHash
			})
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.find((outcome) => outcome.status === "rejected");
		expect(rejected?.reason).toBeInstanceOf(IssueCommentConflictError);
		const winningOutcome = outcomes.find((outcome) => outcome.status === "fulfilled");
		if (!winningOutcome || winningOutcome.status !== "fulfilled") {
			throw new Error("Expected one winning comment update.");
		}

		expect(await firstStore.listIssueComments({ issueId: issue.id })).toEqual(expect.objectContaining({
			comments: [expect.objectContaining({
				id: comment.id,
				body: winningOutcome.value.body,
				revision: winningOutcome.value.revision,
				contentHash: winningOutcome.value.contentHash
			})]
		}));
		expect(await firstStore.listIssueCommentHistory({ commentId: comment.id })).toEqual([
			expect.objectContaining({ targetRevision: 1, headRevision: 2, body: "Original comment." }),
			expect.objectContaining({ targetRevision: 2, headRevision: 2, body: winningOutcome.value.body })
		]);
	} finally {
		await Promise.all([firstStore.close(), secondStore.close()]);
	}
});

it("rejects a stale comment deletion without changing the current comment", async () => {
	const store = await openPgTestStore();
	try {
		const issue = await store.createEntity({ kind: "issue", title: "Stale comment deletion" });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Original comment." });
		const updated = await store.updateIssueComment({
			commentId: comment.id,
			body: "Current comment.",
			expectedRevision: comment.revision,
			expectedContentHash: comment.contentHash
		});

		await expect(store.deleteIssueComment({
			commentId: comment.id,
			expectedRevision: comment.revision,
			expectedContentHash: comment.contentHash
		})).rejects.toBeInstanceOf(IssueCommentConflictError);
		expect(await store.listIssueComments({ issueId: issue.id })).toEqual(expect.objectContaining({
			comments: [expect.objectContaining({
				id: comment.id,
				body: "Current comment.",
				revision: updated.revision,
				contentHash: updated.contentHash
			})]
		}));
	} finally {
		await store.close();
	}
});
