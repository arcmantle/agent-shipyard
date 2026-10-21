import { describe, expect, it } from "vitest";

import { decodeCanonicalReference, deriveMigratedEntityIdentity, shortEntityReference } from "../entity-store/canonical-reference.js";
import { computeEntityContentHash, DEFAULT_EPIC_ID, EntityConflictError, EntityRevisionError } from "../entity-store/domain.js";
import { computeContextTermContentHash, ContextConflictError, ContextRevisionError, ContextTermConflictError } from "../context/context-types.js";
import { IssueCommentConflictError } from "./issue-comment-store.js";
import type { StorageDriver } from "./storage-driver.js";
import { projectProposedPlan } from "../plan/plan-snapshot.js";

export type StorageDriverContractOptions = {
	/** Folded into each describe block's title so a failure identifies which backend broke. */
	label: string;
	/** Opens a fresh `StorageDriver` for a single test; the test closes it via `store.close()`. */
	openStore: () => StorageDriver | Promise<StorageDriver>;
	/**
	 * Opens a store scoped to a workspace-derived project identity (ADR
	 * "Multi-source project identity resolution"), against the same underlying
	 * tenant as every other store the same factory returns. Required so the
	 * contract can pin how identity maps to a project on both backends - the
	 * seam was silent on this, and the two drivers had drifted into resolving
	 * it completely differently without a single test noticing.
	 */
	openStoreForProject: (projectIdentity: string) => StorageDriver | Promise<StorageDriver>;
};

/**
 * The behavioral contract every `StorageDriver` backend must satisfy
 * (ADR11, ADR13): entity lifecycle, handoffs, context/glossary, and
 * connection lifecycle - run against whichever backend `openStore` opens,
 * per the ai-tdd principle that both backends are held to one identical
 * spec rather than duplicated bespoke tests (ISS46).
 *
 * Tenant administration is deliberately excluded from this shared spec.
 * Postgres RLS (ADR9) makes each `PgStore` instance's own tenant the only
 * one it can ever see or touch, so "list every tenant"/cross-tenant admin
 * behavior is structurally different per backend by design, not an
 * oversight - each backend covers it with its own bespoke test instead
 * (`storage-driver.test.ts` for `SqliteStore`, `pg-store.test.ts` for
 * `PgStore`).
 */
export function runStorageDriverContractSuite(options: StorageDriverContractOptions): void {
	const { label, openStore, openStoreForProject } = options;

	describe(`storage-driver seam: deferred issues (${label})`, () => {
		it("retains deferred work and history while permitting parent completion", async () => {
			const store = await openStore();
			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Deferred work" });
				const parent = await store.createEntity({ kind: "issue", title: "Parent", parentId: initiative.id });
				const child = await store.createEntity({ kind: "issue", title: "Optional child", body: "Retained content", parentId: parent.id });
				const dependent = await store.createEntity({ kind: "issue", title: "Dependent", parentId: initiative.id });
				await store.linkEntities({ fromId: child.id, toId: dependent.id, relationType: "blocks" });
				await store.updateEntityStatus({ entityId: child.id, status: "deferred" });
				await expect(store.updateEntityStatus({ entityId: dependent.id, status: "in-progress" })).rejects.toThrow(/blocked by/);
				await store.updateEntityStatus({ entityId: dependent.id, status: "deferred" });
				await expect(store.updateEntityStatus({ entityId: parent.id, status: "done" })).resolves.toMatchObject({ entity: { status: "done" } });
				await expect(store.getEntityDetails(initiative.id)).resolves.toMatchObject({ entity: { status: "done" } });
				await expect(store.queryEntities({ kind: "issue", statuses: ["deferred"] })).resolves.toMatchObject({
					entities: expect.arrayContaining([expect.objectContaining({ id: child.id }), expect.objectContaining({ id: dependent.id })])
				});
				await store.updateEntityStatus({ entityId: child.id, status: "todo" });
				await expect(store.getEntityDetails(child.id)).resolves.toMatchObject({
					entity: { title: child.title, body: "Retained content", status: "todo" },
					incoming: expect.arrayContaining([expect.objectContaining({ relationType: "decomposes", entity: expect.objectContaining({ id: parent.id }) })]),
					outgoing: expect.arrayContaining([expect.objectContaining({ relationType: "blocks", entity: expect.objectContaining({ id: dependent.id }) })])
				});
				expect((await store.listEntityHistory(child.id)).map((entry) => entry.status)).toEqual(["todo", "deferred", "todo"]);
				await expect(store.getEntityDetails(initiative.id)).resolves.toMatchObject({ entity: { status: "active" } });
				await store.updateEntityStatus({ entityId: parent.id, status: "deferred" });
				await expect(store.getEntityDetails(parent.id)).resolves.toMatchObject({ entity: { status: "deferred" } });
				await expect(store.getEntityDetails(initiative.id)).resolves.toMatchObject({ entity: { status: "draft" } });
				await store.updateEntityStatus({ entityId: child.id, status: "deferred" });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "overview" })).resolves.toMatchObject({
					rollup: { issueCount: 0, totalIssueCount: 3, completedIssueCount: 0 }
				});
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Search (${label})`, () => {
		it("reports availability and returns an exact entity identity match", async () => {
			const store = await openStore();

			try {
				const entity = await store.createEntity({ kind: "initiative", title: "Searchable initiative" });

				await expect(store.getSearchCapability()).resolves.toEqual({ state: "available" });
				await expect(store.search({ query: entity.reference, scope: { type: "all-projects" } })).resolves.toEqual({
					state: "available",
					results: [expect.objectContaining({
						identity: expect.objectContaining({ sourceId: entity.id, sourceType: "entity" }),
						match: { field: "identity" },
						navigationTarget: { type: "entity", entityId: entity.id },
						title: entity.title
					})]
				});
			} finally {
				await store.close();
			}
		});

		it("returns a typed parse error for invalid search grammar", async () => {
			const store = await openStore();

			try {
				await expect(store.search({ query: "search OR", scope: { type: "all-projects" } })).resolves.toEqual({
					state: "parse-error",
					error: { message: "Expected a search term.", start: 9, end: 9 }
				});
			} finally {
				await store.close();
			}
		});

		it("uses the requested project for current-project searches", async () => {
			const firstProjectStore = await openStoreForProject("first-project");
			const secondProjectStore = await openStoreForProject("second-project");

			try {
				const entity = await firstProjectStore.createEntity({
					kind: "initiative",
					title: "First project search result",
					body: "Isolated search result."
				});
				await secondProjectStore.createEntity({ kind: "initiative", title: "Second project record" });
				const firstProject = (await firstProjectStore.getDatabaseSnapshot()).entities.find(({ kind }) => kind === "project")!;
				const secondProject = (await secondProjectStore.getDatabaseSnapshot()).entities.find(({ kind }) => kind === "project")!;

				await expect(secondProjectStore.search({
					query: "isolated result",
					scope: { type: "current-project", projectId: firstProject.id }
				})).resolves.toEqual(expect.objectContaining({
					state: "available",
					results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }) })]
				}));
				await expect(secondProjectStore.search({
					query: "isolated result",
					scope: { type: "current-project", projectId: secondProject.id }
				})).resolves.toEqual({ state: "available", results: [] });
			} finally {
				await firstProjectStore.close();
				await secondProjectStore.close();
			}
		});
	});

	describe(`storage-driver seam: Prospector settings (${label})`, () => {
		it("preserves all settings in the selected project without changing another project", async () => {
			const firstProject = await openStoreForProject("prospector-settings-first");
			const secondProject = await openStoreForProject("prospector-settings-second");
			const settings = {
				trunkBranches: ["main", "trunk"],
				tagPrefix: "release-",
				enableCommitBumps: false,
				commitBumpPatterns: {
					major: "BREAKING CHANGE|!:",
					minor: "^feat:",
					patch: "^fix:"
				},
				maxCommitScan: 1_000
			};

			try {
				await expect(firstProject.getProspectorSettings()).resolves.toEqual({});
				await expect(firstProject.setProspectorSettings(settings)).resolves.toEqual(settings);
				await expect(firstProject.getProspectorSettings()).resolves.toEqual(settings);
				await expect(secondProject.getProspectorSettings()).resolves.toEqual({});
			} finally {
				await firstProject.close();
				await secondProject.close();
			}
		});
	});

	describe(`storage-driver seam: Issue-breakdown drafts (${label})`, () => {
		it("stores and retrieves a complete ordered issue graph with a stable digest", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Issue-breakdown owner" });
				const created = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [
						{
							key: "storage",
							title: "Add draft storage",
							outcome: "Drafts persist.",
							scope: ["Add storage."],
							workMode: "AFK",
							acceptanceCriteria: ["A draft is retrievable."],
							relationReferences: []
						}
					]
				});

				await expect(store.getIssueBreakdownDraft({ draftId: created.id })).resolves.toEqual(created);
				expect(created).toMatchObject({ targetId: initiative.id, targetReference: initiative.reference, issues: [{ key: "storage" }] });
				expect(created.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
			} finally {
				await store.close();
			}
		});

		it("supersedes the prior active draft when it stores a later graph for the same target", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Revised issue-breakdown owner" });
				const first = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{ key: "first", title: "First graph", outcome: "First draft.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [] }]
				});
				const second = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{ key: "second", title: "Second graph", outcome: "Later draft.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [] }]
				});

				await expect(store.getIssueBreakdownDraft({ draftId: first.id })).resolves.toMatchObject({ status: "superseded" });
				await expect(store.getLatestIssueBreakdownDraft({ targetId: initiative.id })).resolves.toEqual(second);
			} finally {
				await store.close();
			}
		});

		it("approves a matching draft by creating its complete issue graph", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Approval owner" });
				const userStory = await store.createEntity({ kind: "userStory", title: "Approval outcome" });
				const draft = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [
						{ key: "parent", title: "Create parent", outcome: "A parent issue exists.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [] },
						{ key: "child", title: "Create child", outcome: "A child issue exists.", scope: [], workMode: "AFK", acceptanceCriteria: [], parentKey: "parent", relationReferences: [{ relationType: "fixes", targetId: userStory.id }] }
					]
				});

				const result = await store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: draft.snapshotDigest });

				expect(result).toMatchObject({ targetReference: initiative.reference, createdIssueReferences: [expect.stringMatching(/^ISS_/), expect.stringMatching(/^ISS_/)] });
				if (result.status !== "approved") {
					throw new Error("Expected matching draft approval to succeed.");
				}
				const createdIssues = await Promise.all(result.createdIssueReferences.map((reference) => store.getEntityDetails(reference)));
				expect(createdIssues.map(({ entity }) => entity.title)).toEqual(["Create parent", "Create child"]);
				expect((await store.queryEntityRelations({ entityId: createdIssues[1]!.entity.id })).outgoing).toEqual(expect.arrayContaining([
					expect.objectContaining({ relationType: "fixes", entity: expect.objectContaining({ id: userStory.id }) })
				]));
			} finally {
				await store.close();
			}
		});

		it("approves a matching draft with Plan-entry provenance", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan-entry approval owner" });
				const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Plan-entry approval plan" });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Record issue provenance in approval." });
				const draft = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{
						key: "provenance",
						title: "Link Plan entry during approval",
						outcome: "The approved issue has Plan-entry provenance.",
						scope: [],
						workMode: "AFK",
						acceptanceCriteria: [],
						planEntryIds: [entry.id],
						relationReferences: []
					}]
				});

				const result = await store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: draft.snapshotDigest });

				if (result.status !== "approved") {
					throw new Error("Expected matching draft approval to succeed.");
				}
				await expect(store.getEntityDetails(result.createdIssueReferences[0]!)).resolves.toMatchObject({
					planEntries: [expect.objectContaining({ id: entry.id })]
				});
			} finally {
				await store.close();
			}
		});

		it("returns the current draft without creating issues when its snapshot is stale", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Stale approval owner" });
				const draft = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{ key: "current", title: "Current issue", outcome: "The current draft is shown.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [] }]
				});

				await expect(store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: "stale" })).resolves.toEqual({ status: "stale", draft });
				expect(await store.getIssueBreakdownDraft({ draftId: draft.id })).toMatchObject({ status: "active", createdIssueReferences: [] });
			} finally {
				await store.close();
			}
		});

		it("returns the original references when approval repeats", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Repeat approval owner" });
				const draft = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{ key: "once", title: "Create once", outcome: "Only one issue exists.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [] }]
				});

				const first = await store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: draft.snapshotDigest });
				await expect(store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: draft.snapshotDigest })).resolves.toEqual(first);
				const approvedDraft = await store.getIssueBreakdownDraft({ draftId: draft.id });
				await expect(store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: "stale" })).resolves.toEqual({ status: "stale", draft: approvedDraft });
			} finally {
				await store.close();
			}
		});

		it("creates no partial graph when a relation target is invalid", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Atomic approval owner" });
				const draft = await store.createIssueBreakdownDraft({
					targetId: initiative.id,
					issues: [{ key: "invalid", title: "Do not create", outcome: "The transaction rolls back.", scope: [], workMode: "AFK", acceptanceCriteria: [], relationReferences: [{ relationType: "blocks", targetKey: "missing" }] }]
				});

				await expect(store.approveIssueBreakdownDraft({ draftId: draft.id, snapshotDigest: draft.snapshotDigest })).rejects.toThrow(/unresolved relation target/i);
				expect(await store.getIssueBreakdownDraft({ draftId: draft.id })).toMatchObject({ status: "active", createdIssueReferences: [] });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan lifecycle (${label})`, () => {
		it("confirms a matching Proposed Plan snapshot", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan confirmation owner" });
				const plan = await store.createEntity({
					kind: "plan",
					title: "Plan ready for confirmation",
					body: "## Goal\n\nConfirm the Plan.\n\n## Context\n\nUse the current snapshot.",
					parentId: initiative.id
				});
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use snapshot confirmation." });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);

				await expect(store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest })).resolves.toMatchObject({
					previousStatus: "in-progress",
					entity: { id: plan.id, status: "ready" }
				});
			} finally {
				await store.close();
			}
		});

		it("rejects a stale snapshot without changing Plan status", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Stale Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Stale Plan", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use the first decision." });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);
				const currentEntry = await store.getPlanEntry({ entryId: entry.id });
				await store.updatePlanEntry({ entryId: entry.id, body: "Use the revised decision.", expectedRevision: currentEntry.revision, expectedContentHash: currentEntry.contentHash });

				await expect(store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest })).rejects.toThrow(/snapshot is stale/i);
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("rejects confirmation while the Proposed Plan has active questions", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Incomplete Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Incomplete Plan", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "question", body: "What remains open?" });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);

				await expect(store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest })).rejects.toThrow(/active questions/i);
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("does not revise an already-confirmed matching Plan", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Idempotent Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Idempotent Plan", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Confirm once." });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });
				const confirmedPlan = (await store.getEntityDetails(plan.id)).entity;

				await expect(store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest })).resolves.toMatchObject({
					confirmed: false,
					entity: { id: plan.id, revision: confirmedPlan.revision, status: "ready" }
				});
			} finally {
				await store.close();
			}
		});

		it("reopens a ready Plan when its body changes", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan reopen owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan reopened by body change", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Confirm before changing." });
				const details = await store.getEntityDetails(plan.id);
				const proposedPlan = projectProposedPlan(details.entity, [await store.getPlanEntry({ entryId: entry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });
				const readyPlan = (await store.getEntityDetails(plan.id)).entity;

				await store.setEntityBody({
					entityId: plan.id,
					body: "## Goal\n\nReview the changed Plan.",
					expectedRevision: readyPlan.revision,
					expectedContentHash: readyPlan.contentHash
				});

				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("reopens a ready Plan when its title changes", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan title reopen owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Original Plan title", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Confirm before changing." });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });
				const readyPlan = (await store.getEntityDetails(plan.id)).entity;

				await store.updateEntity({
					entityId: plan.id,
					title: "Changed Plan title",
					expectedRevision: readyPlan.revision,
					expectedContentHash: readyPlan.contentHash
				});

				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("reopens a ready Plan when an active Plan entry changes", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry reopen owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan reopened by entry change", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Initial decision." });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });
				const readyEntry = await store.getPlanEntry({ entryId: entry.id });

				await store.updatePlanEntry({
					entryId: entry.id,
					body: "Changed decision.",
					expectedRevision: readyEntry.revision,
					expectedContentHash: readyEntry.contentHash
				});

				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("reopens a ready Plan when an active Plan entry is added or deleted", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry lifecycle reopen owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan reopened by entry lifecycle", parentId: initiative.id });
				const firstEntry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "First decision." });
				let proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: firstEntry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });

				const secondEntry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Second decision." });
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");

				proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: firstEntry.id }), await store.getPlanEntry({ entryId: secondEntry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });
				const activeSecondEntry = await store.getPlanEntry({ entryId: secondEntry.id });
				await store.deletePlanEntry({ entryId: secondEntry.id, expectedRevision: activeSecondEntry.revision, expectedContentHash: activeSecondEntry.contentHash });

				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("does not reopen a ready Plan when Plan entry references change", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan reference owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan with references", parentId: initiative.id });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Keep references out of the snapshot." });
				const issue = await store.createEntity({ kind: "issue", title: "Referenced implementation", parentId: initiative.id });
				const proposedPlan = projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]);
				await store.confirmPlan({ planId: plan.id, snapshotDigest: proposedPlan.snapshotDigest });

				await store.linkPlanEntryEntity({ entryId: entry.id, targetId: issue.id });
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("ready");
				await store.unlinkPlanEntryEntity({ entryId: entry.id, targetId: issue.id });
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("ready");
			} finally {
				await store.close();
			}
		});

		it("requires Plans to have an initiative owner", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Plan project" });

				await expect(store.createEntity({ kind: "plan", title: "Parentless Plan" })).rejects.toThrow(/initiative parent/i);
				await expect(store.createEntity({ kind: "plan", title: "Project-owned Plan", parentId: project.id })).rejects.toThrow(/initiative parent/i);
			} finally {
				await store.close();
			}
		});

		it("creates an initiative-owned draft Plan and links it to a PRD as provenance", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Implementation plan", body: "## Goal\n\nBuild the feature.\n\n## Context\n\nTrack the work.", parentId: initiative.id });
				const prd = await store.createEntity({ kind: "prd", title: "Feature PRD", parentId: initiative.id });

				expect(plan).toMatchObject({ kind: "plan", status: "draft", reference: expect.stringMatching(/^PLAN_/) });
				expect(plan).not.toHaveProperty("body");
				expect(plan).not.toHaveProperty("bodySource");
				expect((await store.getEntityDetails(plan.id)).entity).toMatchObject({ body: "## Goal\n\nBuild the feature.\n\n## Context\n\nTrack the work.", bodySource: "authored" });
				expect((await store.getEntityDetails(plan.id)).incoming).toEqual(expect.arrayContaining([
					expect.objectContaining({ relationType: "owns", entity: expect.objectContaining({ id: initiative.id }) })
				]));
				const statusUpdate = await store.updateEntityStatus({ entityId: plan.id, status: "ready" });
				expect(statusUpdate).toMatchObject({
					previousStatus: "draft",
					entity: expect.objectContaining({ status: "ready" })
				});
				expect(statusUpdate.entity).not.toHaveProperty("body");
				expect(statusUpdate.entity).not.toHaveProperty("bodySource");
				await expect(store.linkEntities({ fromId: plan.id, toId: prd.id, relationType: "informs" })).resolves.toMatchObject({ created: true });
				expect((await store.getEntityDetails(prd.id)).incoming).toEqual(expect.arrayContaining([
					expect.objectContaining({ relationType: "informs", entity: expect.objectContaining({ id: plan.id }) }),
					expect.objectContaining({ relationType: "owns", entity: expect.objectContaining({ id: initiative.id }) })
				]));
			} finally {
				await store.close();
			}
		});

		it("ignores caller-supplied statuses when creating a Plan", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan owner" });

				for (const status of ["ready", "superseded"]) {
					await expect(store.createEntity({
						kind: "plan",
						title: `Plan requested as ${status}`,
						parentId: initiative.id,
						status
					})).resolves.toMatchObject({ status: "draft" });
				}
			} finally {
				await store.close();
			}
		});

		it("rejects invalid Plan statuses and preserves supplied statuses for other kinds", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan owner" });

				await expect(store.createEntity({
					kind: "plan",
					title: "Plan requested with an invalid status",
					parentId: initiative.id,
					status: "invalid"
				})).rejects.toThrow(/invalid status/i);
				await expect(store.createEntity({ kind: "issue", title: "Explicitly started issue", status: "in-progress" })).resolves.toMatchObject({ status: "in-progress" });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry lifecycle (${label})`, () => {
		it("creates a typed entry and advances its Plan to in-progress", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan with entries", parentId: initiative.id });

				const entry = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which storage contract applies?" });

				expect(entry).toMatchObject({
					planId: plan.id,
					role: "question",
					tombstone: false,
					revision: 1,
					reference: expect.stringMatching(/^PLAN_ENTRY_/)
				});
				expect(entry).not.toHaveProperty("body");
				expect((await store.getPlanEntry({ entryId: entry.id })).body).toBe("Which storage contract applies?");
				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("in-progress");
			} finally {
				await store.close();
			}
		});

		it("links a Plan entry to same-project entities as idempotent informs relations", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry relation owner" });
				const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Plan entry relation Plan" });
				const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use the issue relation." });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Implement the decision" });
				const prd = await store.createEntity({ kind: "prd", parentId: initiative.id, title: "Decision product requirement" });

				for (const target of [issue, prd]) {
					expect(await store.linkPlanEntryEntity({ entryId: entry.reference, targetId: target.reference })).toMatchObject({
						created: true,
						relation: { fromId: entry.id, toId: target.id, type: "informs" }
					});
					expect(await store.linkPlanEntryEntity({ entryId: entry.id, targetId: target.id })).toMatchObject({ created: false });
				}
				expect(await store.getPlanEntry({ entryId: entry.id })).toMatchObject({
					referencedEntityIds: [issue.id, prd.id],
					revision: entry.revision + 2
				});
				for (const target of [issue, prd]) {
					expect(await store.unlinkPlanEntryEntity({ entryId: entry.id, targetId: target.id })).toMatchObject({ removed: true });
					expect(await store.unlinkPlanEntryEntity({ entryId: entry.id, targetId: target.id })).toMatchObject({ removed: false });
				}
				expect(await store.getPlanEntry({ entryId: entry.id })).toMatchObject({
					referencedEntityIds: [],
					revision: entry.revision + 4
				});
			} finally {
				await store.close();
			}
		});

		it("allows an independently created issue to complete when its initiative has a ready Plan", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry completion owner" });
				const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Ready Plan" });
				await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Record the implementation decision." });
				await store.updateEntityStatus({ entityId: plan.id, status: "ready" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Independent follow-up" });

				expect((await store.getEntityDetails(issue.id)).planEntries).toEqual([]);
				await expect(store.updateEntityStatus({ entityId: issue.id, status: "done" })).resolves.toMatchObject({ entity: { status: "done" } });
			} finally {
				await store.close();
			}
		});

		it("advances a Plan only when its first entry is created", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan with entries", parentId: initiative.id });

				await store.createPlanEntry({ planId: plan.id, role: "question", body: "First entry." });
				await store.updateEntityStatus({ entityId: plan.id, status: "draft" });
				await store.createPlanEntry({ planId: plan.id, role: "consideration", body: "Second entry." });

				expect((await store.getEntityDetails(plan.id)).entity.status).toBe("draft");
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry pagination (${label})`, () => {
		it("returns one bounded Plan-entry page and a cursor for older entries", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Paginated Plan owner" });
				const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Paginated Plan" });
				for (let index = 0; index < 51; index += 1) {
					await store.createPlanEntry({ planId: plan.id, role: "decision", body: `Decision ${index}` });
				}

				const firstPage = await store.listPlanEntryPage({ planId: plan.id });

				expect(firstPage).toMatchObject({ total: 51 });
				expect(firstPage.entries).toHaveLength(50);
				expect(firstPage.nextBefore).toEqual(expect.any(String));
				expect((await store.listPlanEntryPage({ planId: plan.id, before: firstPage.nextBefore! }))).toMatchObject({
					entries: [expect.objectContaining({ body: "Decision 0" })],
					nextBefore: null,
					total: 51
				});
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry supersession (${label})`, () => {
		it("lets decisions explicitly supersede questions and decisions", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Supersession owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Supersession Plan", parentId: initiative.id });
				const question = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which store should own entries?" });
				const consideration = await store.createPlanEntry({ planId: plan.id, role: "consideration", body: "The stores must stay symmetric." });
				const decision = await store.createPlanEntry({
					planId: plan.id,
					role: "decision",
					body: "Both stores own entries.",
					supersededEntryIds: [question.id]
				});
				const replacement = await store.createPlanEntry({
					planId: plan.id,
					role: "decision",
					body: "The local store owns entries.",
					supersededEntryIds: [decision.id]
				});

				expect(decision.supersededEntryIds).toEqual([question.id]);
				expect(replacement.supersededEntryIds).toEqual([decision.id]);
				await expect(store.createPlanEntry({
					planId: plan.id,
					role: "decision",
					body: "Invalid resolution.",
					supersededEntryIds: [consideration.id]
				})).rejects.toThrow(/question or decision/i);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry history (${label})`, () => {
		it("preserves revisions and tombstones after an optimistic update", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan entry history owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan entry history", parentId: initiative.id });
				const created = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Initial question." });
				const updated = await store.updatePlanEntry({
					entryId: created.id,
					body: "Revised question.",
					expectedRevision: created.revision,
					expectedContentHash: created.contentHash
				});

				expect(updated).toMatchObject({ body: "Revised question.", revision: 2, tombstone: false });
				await expect(store.updatePlanEntry({
					entryId: created.id,
					body: "Stale question.",
					expectedRevision: created.revision,
					expectedContentHash: created.contentHash
				})).rejects.toThrow(/stale edit/i);
				const deleted = await store.deletePlanEntry({
					entryId: updated.id,
					expectedRevision: updated.revision,
					expectedContentHash: updated.contentHash
				});

				expect(deleted).toMatchObject({ tombstone: true, revision: 3 });
				expect(await store.listPlanEntryHistory({ entryId: created.id })).toEqual([
					expect.objectContaining({ targetRevision: 1, body: "Initial question.", tombstone: false }),
					expect.objectContaining({ targetRevision: 2, body: "Revised question.", tombstone: false }),
					expect.objectContaining({ targetRevision: 3, body: "Revised question.", tombstone: true })
				]);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry roles (${label})`, () => {
		it("accepts only valid scope directions for scope entries", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Scoped Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Scoped Plan", parentId: initiative.id });

				await expect(store.createPlanEntry({ planId: plan.id, role: "scope", body: "Missing direction." })).rejects.toThrow(/scope direction/i);
				await expect(store.createPlanEntry({ planId: plan.id, role: "scope", body: "Invalid direction.", scopeDirection: "maybe" as "included" })).rejects.toThrow(/scope direction/i);
				await expect(store.createPlanEntry({ planId: plan.id, role: "decision", body: "Wrong direction.", scopeDirection: "included" })).rejects.toThrow(/only scope/i);
				await expect(store.createPlanEntry({ planId: plan.id, role: "scope", body: "Included scope.", scopeDirection: "included" })).resolves.toMatchObject({ scopeDirection: "included" });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Plan entry references (${label})`, () => {
		it("preserves ordered references to Plan-related entities", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Referenced Plan owner" });
				const plan = await store.createEntity({ kind: "plan", title: "Referenced Plan", parentId: initiative.id });
				const firstReference = await store.createEntity({ kind: "issue", title: "First reference", parentId: initiative.id });
				const secondReference = await store.createEntity({ kind: "issue", title: "Second reference", parentId: initiative.id });

				await store.createPlanEntry({
					planId: plan.id,
					role: "consideration",
					body: "Use both references.",
					referencedEntityIds: [secondReference.id, firstReference.id]
				});

				await expect(store.listPlanEntries({ planId: plan.id })).resolves.toEqual([
					expect.objectContaining({ referencedEntityIds: [secondReference.id, firstReference.id] })
				]);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: user directory (${label})`, () => {
		it("upserts one deterministic user and keeps a non-empty display name", async () => {
			const store = await openStore();

			try {
				const first = await store.upsertUser({ authenticationSubject: "entra:alice", displayName: "Alice" });
				const second = await store.upsertUser({ authenticationSubject: "entra:alice", displayName: "" });

				expect(second).toEqual(first);
				expect(await store.listUsers()).toEqual([first]);
			} finally {
				await store.close();
			}
		});

		it("attributes a new entity to the authenticated user", async () => {
			const store = await openStore();

			try {
				const actor = { userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" };
				const entity = await store.withAuthenticatedIdentity(actor).createEntity({ kind: "initiative", title: "Attributed initiative" });
				const user = await store.listUsers();

				expect(entity).toMatchObject({ createdBy: user[0]?.id, updatedBy: user[0]?.id });
			} finally {
				await store.close();
			}
		});

		it("preserves the creator and attributes later changes to the authenticated user", async () => {
			const store = await openStore();

			try {
				const alice = store.withAuthenticatedIdentity({ userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" });
				const created = await alice.createEntity({ kind: "initiative", title: "Original title" });
				const bob = store.withAuthenticatedIdentity({ userId: "entra:bob", tenantId: store.tenantId, displayName: "Bob" });
				const updated = await bob.updateEntity({
					entityId: created.id,
					title: "Updated title",
					expectedRevision: created.revision,
					expectedContentHash: created.contentHash
				});
				const users = await store.listUsers();
				const aliceId = users.find((user) => user.authenticationSubject === "entra:alice")?.id;
				const bobId = users.find((user) => user.authenticationSubject === "entra:bob")?.id;

				expect(updated).toMatchObject({ createdBy: aliceId, updatedBy: bobId });
				expect((await store.listEntityHistory(created.id))[1]).toMatchObject({ author: bobId });
			} finally {
				await store.close();
			}
		});

		it("attributes a new context to the authenticated user", async () => {
			const store = await openStore();

			try {
				const actor = { userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" };
				const details = await store.withAuthenticatedIdentity(actor).upsertContext({ title: "Attributed context", summary: "Shared terms" });
				const actorId = (await store.listUsers()).find((user) => user.authenticationSubject === actor.userId)?.id;

				expect(details.context).toMatchObject({ createdBy: actorId, updatedBy: actorId });
			} finally {
				await store.close();
			}
		});

		it("preserves the context creator and attributes later changes to the authenticated user", async () => {
			const store = await openStore();

			try {
				const alice = store.withAuthenticatedIdentity({ userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" });
				const created = await alice.upsertContext({ title: "Original context", summary: "Original summary" });
				const bob = store.withAuthenticatedIdentity({ userId: "entra:bob", tenantId: store.tenantId, displayName: "Bob" });
				const updated = await bob.upsertContext({
					title: "Updated context",
					summary: "Updated summary",
					expectedRevision: created.context.revision,
					expectedContentHash: created.context.contentHash
				});
				const users = await store.listUsers();
				const aliceId = users.find((user) => user.authenticationSubject === "entra:alice")?.id;
				const bobId = users.find((user) => user.authenticationSubject === "entra:bob")?.id;

				expect(updated.context).toMatchObject({ createdBy: aliceId, updatedBy: bobId });
				expect(await store.materializeContextRevision({ revision: 2 })).toMatchObject({ author: bobId });
			} finally {
				await store.close();
			}
		});

		it("attributes an entity status change to the authenticated user", async () => {
			const store = await openStore();

			try {
				const alice = store.withAuthenticatedIdentity({ userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" });
				const created = await alice.createEntity({ kind: "issue", title: "Status attribution" });
				const bob = store.withAuthenticatedIdentity({ userId: "entra:bob", tenantId: store.tenantId, displayName: "Bob" });
				const updated = await bob.updateEntityStatus({ entityId: created.id, status: "in-progress" });
				const users = await store.listUsers();
				const aliceId = users.find((user) => user.authenticationSubject === "entra:alice")?.id;
				const bobId = users.find((user) => user.authenticationSubject === "entra:bob")?.id;

				expect(updated.entity).toMatchObject({ createdBy: aliceId, updatedBy: bobId });
				expect((await store.listEntityHistory(created.id))[1]).toMatchObject({ author: bobId });
			} finally {
				await store.close();
			}
		});

		it("attributes a new context term to the authenticated user", async () => {
			const store = await openStore();

			try {
				const actor = { userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" };
				const result = await store.withAuthenticatedIdentity(actor).defineContextTerm({ term: "Provenance", definition: "Records a trusted actor." });
				const actorId = (await store.listUsers()).find((user) => user.authenticationSubject === actor.userId)?.id;

				expect(result.term).toMatchObject({ createdBy: actorId, updatedBy: actorId });
			} finally {
				await store.close();
			}
		});

		it("attributes a new relation to the authenticated user", async () => {
			const store = await openStore();

			try {
				const actor = { userId: "entra:alice", tenantId: store.tenantId, displayName: "Alice" };
				const actorStore = store.withAuthenticatedIdentity(actor);
				const initiative = await actorStore.createEntity({ kind: "initiative", title: "Relation owner" });
				const issue = await actorStore.createEntity({ kind: "issue", title: "Related issue" });
				const linked = await actorStore.linkEntities({ fromId: initiative.id, toId: issue.id, relationType: "tracks" });
				const actorId = (await store.listUsers()).find((user) => user.authenticationSubject === actor.userId)?.id;

				expect(linked.relation).toMatchObject({ createdBy: actorId });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: project identity (${label})`, () => {
		it("registers an unseen identity as its own project and keeps each identity's work separate", async () => {
			const repoA = await openStoreForProject("repo-a");
			const repoB = await openStoreForProject("repo-b");

			try {
				const initiativeA = await repoA.createEntity({ kind: "initiative", title: "Initiative A" });
				const initiativeB = await repoB.createEntity({ kind: "initiative", title: "Initiative B" });

				// A parent-less initiative has to land in its own workspace's
				// project, not a shared default one: this is what kept cloud
				// putting every fresh workspace's first issue in Default Project.
				expect((await repoA.listEntities("initiative")).map((entity) => entity.title)).toEqual(["Initiative A"]);
				expect((await repoB.listEntities("initiative")).map((entity) => entity.title)).toEqual(["Initiative B"]);

				expect((await repoA.listEntities("initiative")).map((entity) => entity.id)).not.toContain(initiativeB.id);
				expect((await repoB.listEntities("initiative")).map((entity) => entity.id)).not.toContain(initiativeA.id);

				const discovery = await repoA.getProjectDiscovery();
				expect(discovery.kind).toBe("available");
				if (discovery.kind !== "available") {
					return;
				}

				expect(discovery.projects.map((entry) => entry.project.title).sort()).toEqual(["repo-a", "repo-b"]);
				for (const entry of discovery.projects) {
					expect(entry).toMatchObject({ epicCount: 1, initiativeCount: 1 });
				}
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("returns only the selected project's entities from an unfiltered query", async () => {
			const repoA = await openStoreForProject("entity-query-repo-a");
			const repoB = await openStoreForProject("entity-query-repo-b");

			try {
				const issueA = await repoA.createEntity({ kind: "issue", title: "Issue in project A" });
				await repoB.createEntity({ kind: "issue", title: "Issue in project B" });

				await expect(repoA.queryEntities({ kind: "issue" })).resolves.toMatchObject({
					entities: [expect.objectContaining({ id: issueA.id })],
					total: 1
				});
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("keeps parent-filtered, status-filtered, and limited queries in the selected project", async () => {
			const repoA = await openStoreForProject("filtered-entity-query-repo-a");
			const repoB = await openStoreForProject("filtered-entity-query-repo-b");

			try {
				const initiativeA = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });
				const todoIssueA = await repoA.createEntity({ kind: "issue", title: "Todo issue in project A", parentId: initiativeA.id });
				const activeIssueA = await repoA.createEntity({ kind: "issue", title: "Active issue in project A", parentId: initiativeA.id, status: "in-progress" });
				const initiativeB = await repoB.createEntity({ kind: "initiative", title: "Initiative in project B" });
				await repoB.createEntity({ kind: "issue", title: "Active issue in project B", parentId: initiativeB.id, status: "in-progress" });

				await expect(repoA.queryEntities({ kind: "issue", parentId: initiativeA.id })).resolves.toMatchObject({
					entities: expect.arrayContaining([
						expect.objectContaining({ id: todoIssueA.id }),
						expect.objectContaining({ id: activeIssueA.id })
					]),
					total: 2
				});
				await expect(repoA.queryEntities({ kind: "issue", statuses: ["in-progress"] })).resolves.toMatchObject({
					entities: [expect.objectContaining({ id: activeIssueA.id })],
					total: 1
				});
				await expect(repoA.queryEntities({ kind: "issue", limit: 1 })).resolves.toMatchObject({
					entities: [expect.objectContaining({ id: expect.any(String) })],
					total: 2
				});
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not include cross-project blockers in query results", async () => {
			const repoA = await openStoreForProject("blocker-query-repo-a");
			const repoB = await openStoreForProject("blocker-query-repo-b");

			try {
				const issue = await repoA.createEntity({ kind: "issue", title: "Issue in project A" });
				const blocker = await repoB.createEntity({ kind: "issue", title: "Blocker in project B" });
				await repoA.applyRelations([{ fromId: blocker.id, toId: issue.id, type: "blocks", createdBy: "system", createdAt: new Date().toISOString() }]);

				await expect(repoA.queryEntities({ kind: "issue" })).resolves.toMatchObject({
					entities: [expect.objectContaining({ id: issue.id })],
					openBlockers: { [issue.reference]: [] }
				});
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not derive a selected-project status from a foreign relation", async () => {
			const repoA = await openStoreForProject("status-query-repo-a");
			const repoB = await openStoreForProject("status-query-repo-b");

			try {
				const initiative = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });
				const issue = await repoB.createEntity({ kind: "issue", title: "Issue in project B", status: "in-progress" });
				await repoA.applyRelations([{ fromId: initiative.id, toId: issue.id, type: "tracks", createdBy: "system", createdAt: new Date().toISOString() }]);

				await expect(repoA.queryEntities({ kind: "initiative", statuses: ["in-progress"] })).resolves.toMatchObject({
					entities: [],
					total: 0
				});
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not use a foreign parent to filter selected-project entities", async () => {
			const repoA = await openStoreForProject("foreign-parent-query-repo-a");
			const repoB = await openStoreForProject("foreign-parent-query-repo-b");

			try {
				const issue = await repoA.createEntity({ kind: "issue", title: "Issue in project A" });
				const initiative = await repoB.createEntity({ kind: "initiative", title: "Initiative in project B" });
				await repoA.applyRelations([{ fromId: initiative.id, toId: issue.id, type: "tracks", createdBy: "system", createdAt: new Date().toISOString() }]);

				await expect(repoA.queryEntities({ kind: "issue", parentId: initiative.id })).resolves.toMatchObject({
					entities: [],
					total: 0
				});
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not query relations for an entity outside the selected project", async () => {
			const repoA = await openStoreForProject("relation-query-repo-a");
			const repoB = await openStoreForProject("relation-query-repo-b");

			try {
				const initiative = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });
				const issue = await repoA.createEntity({ kind: "issue", title: "Issue in project A", parentId: initiative.id });

				await expect(repoB.queryEntityRelations({ entityId: issue.id })).rejects.toThrow(`Entity not found: ${issue.id}`);
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not get details for a non-issue outside the selected project", async () => {
			const repoA = await openStoreForProject("entity-detail-repo-a");
			const repoB = await openStoreForProject("entity-detail-repo-b");

			try {
				const initiative = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });

				await expect(repoB.getEntityDetails(initiative.id)).rejects.toThrow(/not found/i);
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not return revision history outside the selected project", async () => {
			const repoA = await openStoreForProject("history-repo-a");
			const repoB = await openStoreForProject("history-repo-b");

			try {
				const initiative = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });

				await expect(repoB.listEntityHistory(initiative.id)).rejects.toThrow(/not found/i);
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("does not return a foreign relation neighbor", async () => {
			const repoA = await openStoreForProject("relation-neighbor-repo-a");
			const repoB = await openStoreForProject("relation-neighbor-repo-b");

			try {
				const initiative = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });
				const issue = await repoB.createEntity({ kind: "issue", title: "Issue in project B" });
				await repoA.applyRelations([{ fromId: initiative.id, toId: issue.id, type: "tracks", createdBy: "system", createdAt: new Date().toISOString() }]);

				await expect(repoA.queryEntityRelations({ entityId: initiative.id })).resolves.toMatchObject({ outgoing: [] });
				await expect(repoA.getEntityDetails(initiative.id)).resolves.toMatchObject({ outgoing: [] });
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("lists relations only from the selected project", async () => {
			const repoA = await openStoreForProject("relation-list-repo-a");
			const repoB = await openStoreForProject("relation-list-repo-b");

			try {
				const initiativeA = await repoA.createEntity({ kind: "initiative", title: "Initiative in project A" });
				const issueA = await repoA.createEntity({ kind: "issue", title: "Issue in project A", parentId: initiativeA.id });
				const initiativeB = await repoB.createEntity({ kind: "initiative", title: "Initiative in project B" });
				const issueB = await repoB.createEntity({ kind: "issue", title: "Issue in project B", parentId: initiativeB.id });

				const relations = await repoA.listAllRelations();
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiativeA.id, toId: issueA.id, type: "tracks" }));
				expect(relations).not.toContainEqual(expect.objectContaining({ fromId: initiativeB.id, toId: issueB.id, type: "tracks" }));
			} finally {
				await repoA.close();
				await repoB.close();
			}
		});

		it("resolves an identity that differs only in case and separators to the same project", async () => {
			const store = await openStoreForProject("repo-a");
			const restyled = await openStoreForProject("Repo A");

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Shared initiative" });

				expect((await restyled.listEntities("initiative")).map((entity) => entity.id)).toEqual([initiative.id]);

				const discovery = await restyled.getProjectDiscovery();
				expect(discovery.kind === "available" && discovery.projects).toHaveLength(1);
			} finally {
				await store.close();
				await restyled.close();
			}
		});
	});

		describe(`storage-driver seam: ADR lifecycle (${label})`, () => {
			it("keeps ADR status independent from issue progress", async () => {
				const store = await openStore();

				try {
					const initiative = await store.createEntity({ kind: "initiative", title: "ADR lifecycle" });
					const adr = await store.createEntity({ kind: "adr", title: "Use SQLite", parentId: initiative.id });
					const issue = await store.createEntity({ kind: "issue", title: "Implement it", parentId: initiative.id });

					expect(adr.status).toBe("current");
					await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });
					await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
					expect((await store.getEntityDetails(adr.id)).entity.status).toBe("current");
					await store.updateEntityStatus({ entityId: issue.id, status: "done" });
					expect((await store.getEntityDetails(adr.id)).entity.status).toBe("current");
					await expect(store.updateEntityStatus({ entityId: adr.id, status: "current" })).resolves.toBeDefined();

					const replacement = await store.createEntity({ kind: "adr", title: "Use Postgres", parentId: initiative.id });
					await store.linkEntities({ fromId: replacement.id, toId: adr.id, relationType: "supersedes" });
					expect((await store.getEntityDetails(adr.id)).entity.status).toBe("superseded");
					await expect(store.updateEntityStatus({ entityId: adr.id, status: "current" })).rejects.toThrow(/superseded/i);
				} finally {
					await store.close();
				}
			});

			it("archives an ADR and restores it to current", async () => {
				const store = await openStore();

				try {
					const adr = await store.createEntity({ kind: "adr", title: "Archive this decision" });

					const archived = await store.archiveEntity({ entityId: adr.id });
					expect(archived.entity.status).toBe("archived");

					const restored = await store.updateEntityStatus({ entityId: adr.id, status: "current" });
					expect(restored.entity.status).toBe("current");
				} finally {
					await store.close();
				}
			});

			it("clears an archived ADR before linking a superseding ADR", async () => {
				const store = await openStore();

				try {
					const oldAdr = await store.createEntity({ kind: "adr", title: "Old decision" });
					const replacement = await store.createEntity({ kind: "adr", title: "Replacement decision" });
					await store.archiveEntity({ entityId: oldAdr.id });

					await expect(store.linkEntities({ fromId: replacement.id, toId: oldAdr.id, relationType: "supersedes" })).resolves.toMatchObject({
						created: true,
						relation: { fromId: replacement.id, toId: oldAdr.id, type: "supersedes" }
					});
					expect((await store.getEntityDetails(oldAdr.id)).entity.status).toBe("superseded");

					await store.unlinkEntities({ fromId: replacement.id, toId: oldAdr.id, relationType: "supersedes" });
					expect((await store.getEntityDetails(oldAdr.id)).entity.status).toBe("current");

					const history = await store.listEntityHistory(oldAdr.id);
					expect(history.map((entry) => ({ version: entry.version, status: entry.status }))).toEqual([
						{ version: 1, status: "current" },
						{ version: 2, status: "archived" },
						{ version: 3, status: "current" }
					]);
				} finally {
					await store.close();
				}
			});

			it("refuses to archive a superseded ADR and names the replacement", async () => {
				const store = await openStore();

				try {
					const initiative = await store.createEntity({ kind: "initiative", title: "ADR lifecycle" });
					const oldAdr = await store.createEntity({ kind: "adr", title: "Old decision", parentId: initiative.id });
					const replacement = await store.createEntity({ kind: "adr", title: "Replacement decision", parentId: initiative.id });
					await store.linkEntities({ fromId: replacement.id, toId: oldAdr.id, relationType: "supersedes" });

					await expect(store.archiveEntity({ entityId: oldAdr.id })).rejects.toThrow(new RegExp(replacement.id));
				} finally {
					await store.close();
				}
			});
		});

	describe(`storage-driver seam: Stable identity and Canonical reference (${label})`, () => {
		it("creates and resolves an entity by UUID or Canonical reference", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "Canonical identity" });

				expect(created).toEqual(expect.objectContaining({
					id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
					reference: expect.stringMatching(/^INIT_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
					shortReference: expect.stringMatching(/^INIT_[0-9A-HJKMNP-TV-Z]{6}$/)
				}));
				expect(decodeCanonicalReference(created.reference)).toEqual({ kind: "initiative", stableId: created.id });

				const byId = await store.getEntityDetails(created.id);
				const byReference = await store.getEntityDetails(created.reference);
				const byShortReference = await store.getEntityDetails(created.shortReference);
				expect(byId.entity).toMatchObject({ id: created.id, reference: created.reference, shortReference: created.shortReference });
				expect(byReference.entity).toMatchObject({ id: created.id, reference: created.reference, shortReference: created.shortReference });
				expect(byShortReference.entity).toMatchObject({ id: created.id, reference: created.reference, shortReference: created.shortReference });
			} finally {
				await store.close();
			}
		});

		it("accepts a viewer short reference as a parent selector", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Short parent reference" });
				const issue = await store.createEntity({ kind: "issue", title: "Short reference child", parentId: initiative.id });

				const result = await store.queryEntities({ kind: "issue", parentId: initiative.shortReference });

				expect(result.entities).toEqual([expect.objectContaining({ id: issue.id })]);
				expect(result.parentGroups).toBeUndefined();
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: canonical revision patch hashes (${label})`, () => {
		it("exposes lowercase 64-character hexadecimal hashes", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "First" });
				await store.updateEntity({ entityId: created.id, title: "Second", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				const chain = (await store.exportCanonicalChains()).entities.find((candidate) => candidate.head.id === created.id);

				expect(chain).toBeDefined();
				expect(chain!.deltas.every((delta) => /^[0-9a-f]{64}$/.test(delta.sourceHash) && /^[0-9a-f]{64}$/.test(delta.targetHash))).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: history diagnostics (${label})`, () => {
		it("measures empty, short, and multi-step chains without charging ordinary reads", async () => {
			const store = await openStore();

			try {
				const initial = await store.getHistoryDiagnostics();
				expect(initial.entity.maxMaterializationDepth).toBe(0);
				expect(initial.context).toMatchObject({ historyBytes: 0, deltaCount: 0, maxChainLength: 0, maxMaterializationDepth: 0, records: [] });
				expect(initial["context-term"]).toMatchObject({ historyBytes: 0, deltaCount: 0, maxChainLength: 0, maxMaterializationDepth: 0, records: [] });

				const entityV1 = await store.createEntity({ kind: "initiative", title: "History diagnostics" });
				const entityV2 = await store.updateEntity({ entityId: entityV1.id, body: "Second", expectedRevision: entityV1.revision, expectedContentHash: entityV1.contentHash });
				await store.updateEntity({ entityId: entityV1.id, body: "Third", expectedRevision: entityV2.revision, expectedContentHash: entityV2.contentHash });
				const contextV1 = await store.upsertContext({ title: "Initial context", summary: "First" });
				await store.upsertContext({ title: "Current context", summary: "Second", expectedRevision: contextV1.context.revision, expectedContentHash: contextV1.context.contentHash });
				const termV1 = await store.defineContextTerm({ term: "Diagnostic", definition: "Initial" });
				await store.defineContextTerm({ term: "Diagnostic", definition: "Current", expectedRevision: termV1.term.revision, expectedContentHash: termV1.term.contentHash });

				const beforeOrdinaryReads = await store.getHistoryDiagnostics();
				expect(beforeOrdinaryReads.entity.deltaCount).toBe(initial.entity.deltaCount + 3);
				expect(beforeOrdinaryReads.entity).toMatchObject({ maxChainLength: 3, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads.context).toMatchObject({ deltaCount: 2, maxChainLength: 2, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads["context-term"]).toMatchObject({ deltaCount: 2, maxChainLength: 2, maxMaterializationDepth: 0 });
				expect(beforeOrdinaryReads.entity.records).toContainEqual({ recordId: entityV1.id, deltaCount: 3, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads.context.records).toContainEqual({ recordId: "default", deltaCount: 2, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads["context-term"].records).toContainEqual({ recordId: "default:Diagnostic", deltaCount: 2, historyBytes: expect.any(Number) });
				expect(beforeOrdinaryReads.entity.historyBytes).toBeGreaterThan(0);
				expect(beforeOrdinaryReads.context.historyBytes).toBeGreaterThan(0);
				expect(beforeOrdinaryReads["context-term"].historyBytes).toBeGreaterThan(0);
				for (const kind of ["entity", "context", "context-term"] as const) {
					expect(beforeOrdinaryReads[kind].historyBytes).toBe(beforeOrdinaryReads[kind].records.reduce((total, record) => total + record.historyBytes, 0));
					expect(beforeOrdinaryReads[kind].records.every((record) => record.historyBytes >= 0)).toBe(true);
				}

				await store.listEntities("initiative");
				await store.getEntityDetails(entityV1.id);
				await store.listEntityHistory(entityV1.id);
				await store.listAllRelations();
				await store.listOrphans();
				await store.listProjectAdrs();
				await store.getInitiativeBundle(entityV1.id);
				await store.getDatabaseSnapshot();
				await store.getProjectDiscovery();
				await store.listContexts();
				await store.getContextDetails();
				await store.getContextDirectory();
				await store.queryContextDirectory({ query: "Diagnostic" });
				await expect(store.updateEntity({ entityId: entityV1.id, title: "Stale", expectedRevision: entityV1.revision, expectedContentHash: entityV1.contentHash })).rejects.toBeInstanceOf(EntityConflictError);
				await expect(store.upsertContext({ title: "Stale", summary: "Stale", expectedRevision: contextV1.context.revision, expectedContentHash: contextV1.context.contentHash })).rejects.toBeInstanceOf(ContextConflictError);
				await expect(store.defineContextTerm({ term: "Diagnostic", definition: "Stale", expectedRevision: termV1.term.revision, expectedContentHash: termV1.term.contentHash })).rejects.toBeInstanceOf(ContextTermConflictError);
				expect(await store.getHistoryDiagnostics()).toEqual(beforeOrdinaryReads);

				await store.materializeEntityRevision({ entityId: entityV1.id, revision: 1 });
				await store.materializeContextRevision({ revision: 1 });
				await store.materializeContextTermRevision({ term: "Diagnostic", revision: 1 });
				const afterHistoricalReads = await store.getHistoryDiagnostics();
				expect(afterHistoricalReads.entity.maxMaterializationDepth).toBe(2);
				expect(afterHistoricalReads.context.maxMaterializationDepth).toBe(1);
				expect(afterHistoricalReads["context-term"].maxMaterializationDepth).toBe(1);
			} finally {
				await store.close();
			}
		});

		it("keeps a tiny edit to a large body proportional to the edit", async () => {
			const store = await openStore();

			try {
				const largeBody = "a".repeat(50 * 1024);
				const created = await store.createEntity({ kind: "initiative", title: "Compact history", body: largeBody });
				await store.updateEntity({ entityId: created.id, body: `${largeBody}!`, expectedRevision: created.revision, expectedContentHash: created.contentHash });

				const diagnostics = await store.getHistoryDiagnostics();
				const record = diagnostics.entity.records.find((candidate) => candidate.recordId === created.id);
				expect(record).toBeDefined();
				expect(record!.historyBytes).toBeLessThan(largeBody.length / 100);
				expect(diagnostics.entity.historyBytes).toBe(diagnostics.entity.records.reduce((total, candidate) => total + candidate.historyBytes, 0));
			} finally {
				await store.close();
			}
		});

		it("records restore traversal without counting the appended live head", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.createEntity({ kind: "initiative", title: "Restore diagnostics" });
				const revision2 = await store.updateEntity({ entityId: revision1.id, body: "Second", expectedRevision: revision1.revision, expectedContentHash: revision1.contentHash });
				const revision3 = await store.updateEntity({ entityId: revision1.id, body: "Third", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
				const revision4 = await store.updateEntity({ entityId: revision1.id, body: "Fourth", expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash });

				expect((await store.getHistoryDiagnostics()).entity.maxMaterializationDepth).toBe(0);
				await store.restoreEntityRevision({ entityId: revision1.id, revision: 1, expectedRevision: revision4.revision, expectedContentHash: revision4.contentHash });
				expect((await store.getHistoryDiagnostics()).entity.maxMaterializationDepth).toBe(3);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: project discovery (${label})`, () => {
		it("returns an empty visible-project list for a sentinel-only tenant without changing its snapshot signature", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const discovery = await store.getProjectDiscovery();
				const after = await store.getSnapshotSignature();

				expect(discovery).toEqual({ kind: "available", projects: [] });
				expect(after).toBe(before);
			} finally {
				await store.close();
			}
		});

		it("returns visible projects with isolated epic, initiative, and completion rollups", async () => {
			const store = await openStore();

			try {
				const firstProject = await store.createEntity({ kind: "project", title: "First project" });
				const firstEpic = await store.createEntity({ kind: "epic", title: "First epic", parentId: firstProject.id });
				const completedInitiative = await store.createEntity({ kind: "initiative", title: "Completed", parentId: firstEpic.id });
				await store.updateEntityStatus({ entityId: completedInitiative.id, status: "done" });
				await store.createEntity({ kind: "initiative", title: "Open", parentId: firstEpic.id });
				const secondProject = await store.createEntity({ kind: "project", title: "Second project" });
				await store.createEntity({ kind: "epic", title: "Second epic", parentId: secondProject.id });

				const discovery = await store.getProjectDiscovery();

				expect(discovery).toEqual({
					kind: "available",
					projects: expect.arrayContaining([
						expect.objectContaining({
							project: expect.objectContaining({ id: firstProject.id }),
							epicCount: 1,
							initiativeCount: 2,
							completedInitiativeCount: 1
						}),
						expect.objectContaining({
							project: expect.objectContaining({ id: secondProject.id }),
							epicCount: 1,
							initiativeCount: 0,
							completedInitiativeCount: 0
						})
					])
				});
			} finally {
				await store.close();
			}
		});

		it("returns a typed unavailable result for a missing project without changing its snapshot signature", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const discovery = await store.getProjectDiscovery({ projectId: "PROJ404" });
				const after = await store.getSnapshotSignature();

				expect(discovery).toEqual({ kind: "unavailable" });
				expect(after).toBe(before);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: project-scoped snapshots (${label})`, () => {
		it("returns only the selected project's snapshot data and rejects unavailable projects", async () => {
			const store = await openStore();

			try {
				const selectedProject = await store.createEntity({ kind: "project", title: "Selected project" });
				const selectedEpic = await store.createEntity({ kind: "epic", title: "Selected epic", parentId: selectedProject.id });
				const selectedInitiative = await store.createEntity({ kind: "initiative", title: "Selected initiative", parentId: selectedEpic.id });
				const selectedIssue = await store.createEntity({ kind: "issue", title: "Selected issue", parentId: selectedInitiative.id });
				const selectedAdr = await store.createEntity({ kind: "adr", title: "Selected ADR", parentId: selectedInitiative.id });
				await store.upsertContext({ scopeRef: selectedInitiative.id, title: "Selected context", summary: "Only selected project" });

				const otherProject = await store.createEntity({ kind: "project", title: "Other project" });
				const otherEpic = await store.createEntity({ kind: "epic", title: "Other epic", parentId: otherProject.id });
				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative", parentId: otherEpic.id });
				const otherIssue = await store.createEntity({ kind: "issue", title: "Other issue", parentId: otherInitiative.id });
				const otherAdr = await store.createEntity({ kind: "adr", title: "Other ADR", parentId: otherInitiative.id });
				const otherPrd = await store.createEntity({ kind: "prd", title: "Other PRD", parentId: otherInitiative.id });
				const otherStory = await store.createEntity({ kind: "userStory", title: "Other story", parentId: otherPrd.id });
				await store.linkEntities({ fromId: selectedIssue.id, toId: otherIssue.id, relationType: "blocks" });
				await store.upsertContext({ scopeRef: otherInitiative.id, title: "Other context", summary: "Must not leak" });

				const snapshot = await store.getDatabaseSnapshot({ projectId: selectedProject.id });
				expect(snapshot).toEqual(expect.objectContaining({ kind: "available" }));
				if (snapshot.kind !== "available") {
					return;
				}

				const selectedIds = [selectedProject.id, selectedEpic.id, selectedInitiative.id, selectedIssue.id, selectedAdr.id];
				const otherIds = [otherProject.id, otherEpic.id, otherInitiative.id, otherIssue.id, otherAdr.id];
				expect(snapshot.snapshot.entities.map((entity) => entity.id)).toEqual(expect.arrayContaining(selectedIds));
				expect(snapshot.snapshot.entities.map((entity) => entity.id)).not.toEqual(expect.arrayContaining(otherIds));
				expect(snapshot.snapshot.relations.every((relation) => !otherIds.includes(relation.fromId) && !otherIds.includes(relation.toId))).toBe(true);
				expect(snapshot.snapshot.projectAdrs).toEqual([]);
				expect(snapshot.snapshot.initiatives.map((bundle) => bundle.initiative.id)).toEqual([selectedInitiative.id]);
				expect(snapshot.snapshot.initiatives[0]?.userStories.map((story) => story.id)).not.toContain(otherStory.id);
				expect(snapshot.snapshot.initiatives[0]?.blockerLinks).toEqual([]);
				expect(snapshot.snapshot.contexts.initiatives.map((context) => context.context.scopeEntityId)).toEqual([selectedInitiative.id]);

				expect(await store.getDatabaseSnapshot({ projectId: "PROJ404" })).toEqual({ kind: "unavailable" });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: Project Summary (${label})`, () => {
		it("uses the same direct project epic membership as Project Discovery", async () => {
			const store = await openStoreForProject("summary-membership");

			try {
				await store.createEntity({ kind: "initiative", title: "Project bootstrap" });
				const discoveryBefore = await store.getProjectDiscovery();
				expect(discoveryBefore.kind).toBe("available");
				if (discoveryBefore.kind !== "available") {
					return;
				}

				const project = discoveryBefore.projects[0]!.project;
				const summaryBefore = await store.getProjectSummary({ projectId: project.id });
				expect(summaryBefore.kind).toBe("available");
				if (summaryBefore.kind !== "available") {
					return;
				}
				const expectedEpicIds = summaryBefore.epics.map((group) => group.epic.id);
				await store.createEntity({ kind: "epic", title: "Parentless epic" });

				const discovery = await store.getProjectDiscovery({ projectId: project.id });
				const summary = await store.getProjectSummary({ projectId: project.id });

				expect(discovery.kind).toBe("available");
				expect(summary.kind).toBe("available");
				if (discovery.kind === "available" && summary.kind === "available") {
					expect({
						discoveryEpicCount: discovery.projects[0]!.epicCount,
						summaryEpicCount: summary.counts.epics,
						summaryEpicIds: summary.epics.map((group) => group.epic.id)
					}).toEqual({
						discoveryEpicCount: expectedEpicIds.length,
						summaryEpicCount: expectedEpicIds.length,
						summaryEpicIds: expectedEpicIds
					});
				}
			} finally {
				await store.close();
			}
		});

		it("returns project navigation and Initiative Rollups without initiative detail", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Summary project" });
				const epic = await store.createEntity({ kind: "epic", title: "Summary epic", parentId: project.id });
				const initiative = await store.createEntity({
					kind: "initiative",
					title: "Summary initiative",
					body: "Initiative detail",
					parentId: epic.id
				});
				await store.createEntity({ kind: "issue", title: "Open issue", parentId: initiative.id });
				await store.createEntity({ kind: "issue", title: "Done issue", parentId: initiative.id, status: "done" });
				await store.createEntity({ kind: "issue", title: "Deferred issue", parentId: initiative.id, status: "deferred" });
				const prd = await store.createEntity({ kind: "prd", title: "Summary PRD", parentId: initiative.id });
				await store.createEntity({ kind: "userStory", title: "Summary story", parentId: prd.id });
				await store.createEntity({ kind: "plan", title: "Summary Plan", parentId: initiative.id });
				await store.createEntity({ kind: "adr", title: "Summary ADR", parentId: initiative.id });
				await store.createEntity({ category: "technical", kind: "debt", priority: "high", title: "Summary debt", parentId: initiative.id });
				await store.defineContextTerm({ scopeRef: initiative.id, term: "Summary", definition: "Project Summary context." });
				const otherProject = await store.createEntity({ kind: "project", title: "Other project" });
				const otherEpic = await store.createEntity({ kind: "epic", title: "Other epic", parentId: otherProject.id });
				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative", parentId: otherEpic.id });

				const summary = await store.getProjectSummary({ projectId: project.id });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "overview" })).resolves.toMatchObject({
					rollup: { issueCount: 2, totalIssueCount: 3, completedIssueCount: 1 }
				});

				expect(summary).toEqual(expect.objectContaining({
					kind: "available",
					project: expect.objectContaining({ id: project.id }),
					epics: [expect.objectContaining({
						epic: expect.objectContaining({ id: epic.id }),
						initiatives: [expect.objectContaining({
							initiative: expect.objectContaining({ id: initiative.id }),
							adrCount: 1,
							contextTermCount: 1,
							debtCount: 1,
							issueCount: 2,
							totalIssueCount: 3,
								completedIssueCount: 1,
							planCount: 1,
							prdCount: 1,
								userStoryCount: 1
						})]
					})],
					counts: { epics: 1, initiatives: 1, completedInitiatives: 0 }
				}));
				if (summary.kind === "available") {
					expect(summary.epics[0]?.initiatives[0]?.initiative).not.toHaveProperty("body");
					expect(summary.epics[0]?.initiatives[0]).not.toHaveProperty("entities");
					expect(summary.epics.flatMap((epicGroup) => epicGroup.initiatives).map((rollup) => rollup.initiative.id)).not.toContain(otherInitiative.id);
				}
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: entity lifecycle (${label})`, () => {
		it("creates an entity and reads it back through the async seam", async () => {
			const store = await openStore();

			try {
				const created = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const details = await store.getEntityDetails(created.id);

				expect(details.entity).toMatchObject(created);
			} finally {
				await store.close();
			}
		});

		it("creates open debt with required metadata under a supported owner", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Debt owner" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: project.id,
					category: "technical",
					priority: "high"
				});

				expect(debt).toEqual(expect.objectContaining({
					reference: expect.stringMatching(/^DEBT_[0-9A-HJKMNP-TV-Z]{26}$/),
					kind: "debt",
					status: "open",
					category: "technical",
					priority: "high"
				}));
			} finally {
				await store.close();
			}
		});

		it("materializes debt metadata at its initial revision", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Debt owner" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: project.id,
					category: "technical",
					priority: "high"
				});

				await expect(store.materializeEntityRevision({ entityId: debt.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ category: "technical", priority: "high", status: "open" })
				);
			} finally {
				await store.close();
			}
		});

		it("prevents a debt record from gaining a second structural owner", async () => {
			const store = await openStore();

			try {
				const owner = await store.createEntity({ kind: "project", title: "Debt owner" });
				const secondOwner = await store.createEntity({ kind: "project", title: "Second debt owner" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: owner.id,
					category: "technical",
					priority: "high"
				});

				await expect(store.linkEntities({ fromId: secondOwner.id, toId: debt.id, relationType: "records" })).rejects.toThrow(/structural owner/i);
			} finally {
				await store.close();
			}
		});

		it("requires controlled debt metadata and permits it on other entity kinds", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Debt owner" });
				await expect(store.createEntity({ kind: "debt", title: "Missing metadata", parentId: project.id })).rejects.toThrow(/requires category and priority/i);
				await expect(store.createEntity({
					kind: "debt",
					title: "Invalid category",
					parentId: project.id,
					category: "unknown",
					priority: "high"
				})).rejects.toThrow(/invalid entity category/i);
				await expect(store.createEntity({
					kind: "debt",
					title: "Invalid priority",
					parentId: project.id,
					category: "technical",
					priority: "urgent"
				})).rejects.toThrow(/invalid entity priority/i);

				const initiative = await store.createEntity({ kind: "initiative", title: "Optional metadata", category: "product", priority: "low" });
				expect(initiative).toEqual(expect.objectContaining({ category: "product", priority: "low" }));
			} finally {
				await store.close();
			}
		});

		it("edits metadata independently and preserves the prior revision", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({
					kind: "initiative",
					title: "Metadata edits",
					category: "technical",
					priority: "high"
				});
				const categoryEdited = await store.updateEntity({
					entityId: initiative.id,
					category: "product",
					expectedRevision: initiative.revision,
					expectedContentHash: initiative.contentHash
				});
				expect(categoryEdited).toEqual(expect.objectContaining({ category: "product", priority: "high" }));

				const priorityEdited = await store.updateEntity({
					entityId: initiative.id,
					priority: "critical",
					expectedRevision: categoryEdited.revision,
					expectedContentHash: categoryEdited.contentHash
				});
				expect(priorityEdited).toEqual(expect.objectContaining({ category: "product", priority: "critical" }));
				await expect(store.materializeEntityRevision({ entityId: initiative.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ category: "technical", priority: "high" })
				);
			} finally {
				await store.close();
			}
		});

		it("changes debt lifecycle manually and reversibly", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Debt owner" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: project.id,
					category: "technical",
					priority: "high"
				});

				const resolved = await store.updateEntityStatus({ entityId: debt.id, status: "resolved" });
				expect(resolved.entity.status).toBe("resolved");
				const archived = await store.archiveEntity({ entityId: debt.id });
				expect(archived.entity.status).toBe("archived");
				const reopened = await store.updateEntityStatus({ entityId: debt.id, status: "open" });
				expect(reopened.entity.status).toBe("open");
			} finally {
				await store.close();
			}
		});

		it("links an issue to debt that it resolves", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Debt initiative" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Resolve debt" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: initiative.id,
					category: "technical",
					priority: "high"
				});

				await expect(store.linkEntities({ fromId: issue.id, toId: debt.id, relationType: "resolves" })).resolves.toEqual(
					expect.objectContaining({ relation: expect.objectContaining({ fromId: issue.id, toId: debt.id, type: "resolves" }) })
				);
				expect((await store.getEntityDetails(debt.id)).entity.status).toBe("open");
			} finally {
				await store.close();
			}
		});

		it("links epics and initiatives to debt that they resolve without changing its lifecycle", async () => {
			const store = await openStore();

			try {
				const project = await store.createEntity({ kind: "project", title: "Debt project" });
				const epic = await store.createEntity({ kind: "epic", parentId: project.id, title: "Resolve debt" });
				const initiative = await store.createEntity({ kind: "initiative", parentId: epic.id, title: "Resolve debt" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: initiative.id,
					category: "technical",
					priority: "high"
				});

				for (const resolver of [epic, initiative]) {
					await expect(store.linkEntities({ fromId: resolver.id, toId: debt.id, relationType: "resolves" })).resolves.toEqual(
						expect.objectContaining({ relation: expect.objectContaining({ fromId: resolver.id, toId: debt.id, type: "resolves" }) })
					);
				}
				await expect(store.linkEntities({ fromId: project.id, toId: debt.id, relationType: "resolves" })).rejects.toThrow("Relation resolves is not allowed from project to debt. Valid relation types: records.");
				expect((await store.getEntityDetails(debt.id)).entity.status).toBe("open");
			} finally {
				await store.close();
			}
		});

		it("links debt to a record for context but rejects handoffs as context targets", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Debt initiative" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Context issue" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: initiative.id,
					category: "technical",
					priority: "high"
				});
				const handoff = await store.createEntity({
					kind: "handoff",
					title: "Investigate debt"
				});

				await expect(store.linkEntities({ fromId: debt.id, toId: issue.id, relationType: "relatesTo" })).resolves.toEqual(
					expect.objectContaining({ relation: expect.objectContaining({ fromId: debt.id, toId: issue.id, type: "relatesTo" }) })
				);
				await expect(store.linkEntities({ fromId: debt.id, toId: handoff.id, relationType: "relatesTo" })).rejects.toThrow("not allowed");
			} finally {
				await store.close();
			}
		});

		it("creates a handoff that targets debt", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Debt initiative" });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Replace the legacy worker",
					parentId: initiative.id,
					category: "technical",
					priority: "high"
				});

				const handoff = await store.createEntity({
					kind: "handoff",
					title: "Investigate debt",
					links: [{ relationType: "handsOff", targetId: debt.id }]
				});

				expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
					expect.objectContaining({ fromId: handoff.id, toId: debt.id, type: "handsOff" })
				]));
			} finally {
				await store.close();
			}
		});

		it("creates a handoff as an ordinary entity with handsOff links only to ADR50 focus kinds", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Initiative focus" });
				const prd = await store.createEntity({ kind: "prd", parentId: initiative.id, title: "PRD focus" });
				const story = await store.createEntity({ kind: "userStory", parentId: prd.id, title: "Story focus" });
				const adr = await store.createEntity({ kind: "adr", parentId: initiative.id, title: "ADR focus" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Issue focus" });
				const allowedTargets = [initiative, prd, story, adr, issue];

				for (const target of allowedTargets) {
					const handoff = await store.createEntity({
						kind: "handoff",
						title: `Resume ${target.kind}`,
						body: "The migration test is green.",
						links: [{ relationType: "handsOff", targetId: target.id }]
					});

					expect(handoff).toEqual(expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), reference: expect.stringMatching(/^HO_[0-9A-HJKMNP-TV-Z]{26}$/), kind: "handoff" }));
					await expect(store.materializeEntityRevision({ entityId: handoff.id, revision: 1 })).resolves.toEqual(
						expect.objectContaining({ title: `Resume ${target.kind}`, body: "The migration test is green.", headRevision: 1 })
					);
					expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
						expect.objectContaining({ fromId: handoff.id, toId: target.id, type: "handsOff" })
					]));
				}

				const project = await store.createEntity({ kind: "project", title: "Forbidden project" });
				const version = await store.createEntity({ kind: "version", parentId: project.id, title: "Forbidden version" });
				const standaloneHandoff = await store.createEntity({ kind: "handoff", title: "Standalone handoff" });
				const defaultEpicId = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId;
				for (const targetId of [project.id, defaultEpicId, version.id, standaloneHandoff.id]) {
					await expect(store.createEntity({
						kind: "handoff",
						title: "Invalid target",
						links: [{ relationType: "handsOff", targetId }]
					})).rejects.toThrow("not allowed");
				}
			} finally {
				await store.close();
			}
		});

		it("creates initial links atomically and records one complete revision for a generic edit", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const blocker = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Blocking issue" });
				const dependency = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Dependency issue" });
				const created = await store.createEntity({
					kind: "issue",
					parentId: initiative.id,
					title: "Created with links",
					links: [
						{ relationType: "blocks", targetId: blocker.id },
						{ relationType: "blocks", targetId: dependency.id }
					]
				});

				expect(await store.listAllRelations()).toEqual(expect.arrayContaining([
					expect.objectContaining({ fromId: created.id, toId: blocker.id, type: "blocks" }),
					expect.objectContaining({ fromId: created.id, toId: dependency.id, type: "blocks" })
				]));
				const relationsBeforeRejectedCreate = await store.listAllRelations();
				const signatureBeforeRejectedCreate = await store.getSnapshotSignature();

				await expect(store.createEntity({
					kind: "issue",
					parentId: initiative.id,
					title: "Rejected atomically",
					links: [
						{ relationType: "blocks", targetId: blocker.id },
						{ relationType: "blocks", targetId: "ISS404" }
					]
				})).rejects.toThrow("Entity not found: ISS404");
				expect((await store.listEntities("issue")).map((entity) => entity.title)).not.toContain("Rejected atomically");
				expect(await store.listAllRelations()).toEqual(relationsBeforeRejectedCreate);
				expect(await store.getSnapshotSignature()).toBe(signatureBeforeRejectedCreate);

				const edited = await store.updateEntity({ entityId: created.id, body: "Final body", title: "Final title", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				expect(edited).toEqual(expect.objectContaining({ body: "Final body", title: "Final title" }));
				await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ title: "Created with links", body: "", headRevision: 2 })
				);
			} finally {
				await store.close();
			}
		});

		it("updates status, links, moves, and archives an entity through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocking issue", parentId: initiative.id });

				const linked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
				expect(linked.created).toBe(true);

				const unlinked = await store.unlinkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
				expect(unlinked.removed).toBe(true);

				const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
				expect(statusUpdate.entity.status).toBe("in-progress");

				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative" });
				const moved = await store.moveEntity({ entityId: issue.id, newParentId: otherInitiative.id });
				expect(moved.newParentId).toBe(otherInitiative.id);
				expect(moved.entity).not.toHaveProperty("body");
				expect(moved.entity).not.toHaveProperty("bodySource");

				const bodyUpdated = await store.setEntityBody({ entityId: issue.id, body: "Detailed plan.", expectedRevision: moved.entity.revision, expectedContentHash: moved.entity.contentHash });
				expect(bodyUpdated.body).toBe("Detailed plan.");

				const archived = await store.archiveEntity({ entityId: issue.id });
				expect(archived.entity.status).toBe("done");

				const deleted = await store.deleteEntity({ entityId: issue.id });
				expect(deleted.entity.id).toBe(issue.id);
				expect(deleted.entity).not.toHaveProperty("body");
				expect(deleted.entity).not.toHaveProperty("bodySource");
			} finally {
				await store.close();
			}
		});

		it("lists entities, orphans, project ADRs, and a complete initiative bundle through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
				const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
				const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
				const subIssue = await store.createEntity({ kind: "issue", title: "Sub issue", parentId: initiative.id });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
				const adr = await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });
				const orphanAdr = await store.createEntity({ kind: "adr", title: "Project-scoped ADR" });
				await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });
				await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });
				await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
				await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Snapshot comment." });

				expect((await store.listEntities("initiative")).map((entity) => entity.id)).toContain(initiative.id);
				expect((await store.listOrphans()).map((entity) => entity.id)).not.toContain(orphanAdr.id);
				expect((await store.listProjectAdrs()).map((entity) => entity.id)).toContain(orphanAdr.id);

				const snapshot = await store.getDatabaseSnapshot();
				expect(snapshot.entities.map((entity) => entity.id)).toContain(initiative.id);
				expect(snapshot.issueComments[issue.id]?.users).toEqual([
					expect.objectContaining({ id: comment.createdBy })
				]);

				const bundle = await store.getInitiativeBundle(initiative.id);
				expect(bundle.prds.map((entity) => entity.id)).toEqual([prd.id]);
				expect(bundle.userStories.map((entity) => entity.id)).toEqual([story.id]);
				expect(bundle.issues.map((entity) => entity.id).sort()).toEqual([blocker.id, issue.id, subIssue.id].sort());
				expect(bundle.adrs.map((entity) => entity.id)).toEqual([adr.id]);
				expect(bundle.fixLinks).toEqual([{ issue: expect.objectContaining({ id: issue.id }), userStory: expect.objectContaining({ id: story.id }) }]);
				expect(bundle.subIssueLinks).toEqual([{ parent: expect.objectContaining({ id: issue.id }), issue: expect.objectContaining({ id: subIssue.id }) }]);
				expect(bundle.blockerLinks).toEqual([{ source: expect.objectContaining({ id: blocker.id }), target: expect.objectContaining({ id: issue.id }) }]);
				expect(bundle.constrainsLinks).toEqual([{ adr: expect.objectContaining({ id: adr.id }), issue: expect.objectContaining({ id: issue.id }) }]);

				const bundleByReference = await store.getInitiativeBundle(initiative.reference);
				expect(bundleByReference).toEqual(bundle);
			} finally {
				await store.close();
			}
		});

		it("derives version coverage from completed tracked issues", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Version coverage initiative" });
				const issue = await store.createEntity({ kind: "issue", title: "Completed issue", parentId: initiative.id });
				await store.updateEntityStatus({
					entityId: issue.id,
					status: "done",
					workspaceObservation: {
						state: "available",
						repositoryIdentity: "a".repeat(64),
						commitSha: "b".repeat(40),
						branch: "main",
						dirty: false,
						capturedAt: "2026-09-23T10:00:00.000Z",
						calculatedVersion: {
							state: "available",
							version: "1.2.3",
							branch: "main",
							currentCommit: "b".repeat(40),
							isTrunkBranch: true,
							commitsSinceTag: 0,
							commitBumps: { major: 0, minor: 0, patch: 0 }
						},
						fingerprint: {
							repositoryIdentity: "a".repeat(64),
							commitSha: "b".repeat(40),
							branch: "main",
							refsHash: "c".repeat(64)
						}
					}
				});

				await expect(store.getInitiativeBundle(initiative.id)).resolves.toMatchObject({
					versionCoverage: [{ calculatedVersion: "1.2.3", issueCount: 1, latestCapturedAt: "2026-09-23T10:00:00.000Z" }]
				});
			} finally {
				await store.close();
			}
		});

		it("derives Plan coverage from issues referenced by active entries", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Plan coverage initiative" });
				const plan = await store.createEntity({ kind: "plan", title: "Covered Plan", parentId: initiative.id });
				const includedIssue = await store.createEntity({ kind: "issue", title: "Included issue", parentId: initiative.id });
				const supersededIssue = await store.createEntity({ kind: "issue", title: "Superseded issue", parentId: initiative.id });
				const unlinkedIssue = await store.createEntity({ kind: "issue", title: "Unlinked issue", parentId: initiative.id });
				const observation = {
					state: "available" as const,
					repositoryIdentity: "d".repeat(64),
					commitSha: "e".repeat(40),
					branch: "main",
					dirty: false,
					capturedAt: "2026-09-23T11:00:00.000Z",
					calculatedVersion: {
						state: "available" as const,
						version: "2.0.0",
						branch: "main",
						currentCommit: "e".repeat(40),
						isTrunkBranch: true,
						commitsSinceTag: 0,
						commitBumps: { major: 0, minor: 0, patch: 0 }
					},
					fingerprint: {
						repositoryIdentity: "d".repeat(64),
						commitSha: "e".repeat(40),
						branch: "main",
						refsHash: "f".repeat(64)
					}
				};
				await Promise.all([
					store.updateEntityStatus({ entityId: includedIssue.id, status: "done", workspaceObservation: observation }),
					store.updateEntityStatus({ entityId: supersededIssue.id, status: "done", workspaceObservation: { ...observation, calculatedVersion: { ...observation.calculatedVersion, version: "3.0.0" } } }),
					store.updateEntityStatus({ entityId: unlinkedIssue.id, status: "done", workspaceObservation: { ...observation, calculatedVersion: { ...observation.calculatedVersion, version: "4.0.0" } } })
				]);
				const supersededEntry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Superseded scope.", referencedEntityIds: [supersededIssue.id] });
				await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Current scope.", referencedEntityIds: [includedIssue.id], supersededEntryIds: [supersededEntry.id] });

				await expect(store.getEntityDetails(plan.id)).resolves.toMatchObject({
					versionCoverage: [{ calculatedVersion: "2.0.0", issueCount: 1, latestCapturedAt: "2026-09-23T11:00:00.000Z" }]
				});
			} finally {
				await store.close();
			}
		});

		it("groups unknown versions and counts a repeatedly completed issue once per version", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Repeated version coverage" });
				const repeatedIssue = await store.createEntity({ kind: "issue", title: "Repeated completion", parentId: initiative.id });
				const unknownIssue = await store.createEntity({ kind: "issue", title: "Unknown version", parentId: initiative.id });
				const observation = {
					state: "available" as const,
					repositoryIdentity: "g".repeat(64),
					commitSha: "h".repeat(40),
					branch: "main",
					dirty: false,
					capturedAt: "2026-09-23T12:00:00.000Z",
					calculatedVersion: {
						state: "available" as const,
						version: "5.0.0",
						branch: "main",
						currentCommit: "h".repeat(40),
						isTrunkBranch: true,
						commitsSinceTag: 0,
						commitBumps: { major: 0, minor: 0, patch: 0 }
					},
					fingerprint: {
						repositoryIdentity: "g".repeat(64),
						commitSha: "h".repeat(40),
						branch: "main",
						refsHash: "i".repeat(64)
					}
				};
				await store.updateEntityStatus({ entityId: repeatedIssue.id, status: "done", workspaceObservation: observation });
				await store.updateEntityStatus({ entityId: repeatedIssue.id, status: "in-progress" });
				await store.updateEntityStatus({ entityId: repeatedIssue.id, status: "done", workspaceObservation: { ...observation, capturedAt: "2026-09-23T14:00:00.000Z" } });
				await store.updateEntityStatus({
					entityId: unknownIssue.id,
					status: "done",
					workspaceObservation: {
						state: "unknown",
						capturedAt: "2026-09-23T13:00:00.000Z",
						diagnostics: [{ code: "prospector-calculation-failed", message: "Unable to calculate version." }]
					}
				});

				await expect(store.getInitiativeBundle(initiative.id)).resolves.toMatchObject({
					versionCoverage: [
						{ calculatedVersionState: "available", calculatedVersion: "5.0.0", issueCount: 1, latestCapturedAt: "2026-09-23T14:00:00.000Z" },
						{ calculatedVersionState: "unknown", calculatedVersion: null, issueCount: 1, latestCapturedAt: "2026-09-23T13:00:00.000Z" }
					]
				});
			} finally {
				await store.close();
			}
		});

		it("returns empty coverage for an initiative and Plan without completion observations", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Empty version coverage" });
				const plan = await store.createEntity({ kind: "plan", title: "Empty coverage Plan", parentId: initiative.id });

				await expect(store.getInitiativeBundle(initiative.id)).resolves.toMatchObject({ versionCoverage: [] });
				await expect(store.getEntityDetails(plan.id)).resolves.toMatchObject({ versionCoverage: [] });
			} finally {
				await store.close();
			}
		});

		it("keeps coverage separate for Plans in the same initiative", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Separate Plan coverage" });
				const firstPlan = await store.createEntity({ kind: "plan", title: "First Plan", parentId: initiative.id });
				const secondPlan = await store.createEntity({ kind: "plan", title: "Second Plan", parentId: initiative.id });
				const firstIssue = await store.createEntity({ kind: "issue", title: "First Plan issue", parentId: initiative.id });
				const secondIssue = await store.createEntity({ kind: "issue", title: "Second Plan issue", parentId: initiative.id });
				const observation = {
					state: "available" as const,
					repositoryIdentity: "j".repeat(64),
					commitSha: "k".repeat(40),
					branch: "main",
					dirty: false,
					capturedAt: "2026-09-23T15:00:00.000Z",
					calculatedVersion: {
						state: "available" as const,
						version: "6.0.0",
						branch: "main",
						currentCommit: "k".repeat(40),
						isTrunkBranch: true,
						commitsSinceTag: 0,
						commitBumps: { major: 0, minor: 0, patch: 0 }
					},
					fingerprint: {
						repositoryIdentity: "j".repeat(64),
						commitSha: "k".repeat(40),
						branch: "main",
						refsHash: "l".repeat(64)
					}
				};
				await Promise.all([
					store.updateEntityStatus({ entityId: firstIssue.id, status: "done", workspaceObservation: observation }),
					store.updateEntityStatus({ entityId: secondIssue.id, status: "done", workspaceObservation: { ...observation, calculatedVersion: { ...observation.calculatedVersion, version: "7.0.0" } } })
				]);
				await store.createPlanEntry({ planId: firstPlan.id, role: "decision", body: "First Plan scope.", referencedEntityIds: [firstIssue.id] });
				await store.createPlanEntry({ planId: secondPlan.id, role: "decision", body: "Second Plan scope.", referencedEntityIds: [secondIssue.id] });

				await expect(store.getEntityDetails(firstPlan.id)).resolves.toMatchObject({
					versionCoverage: [{ calculatedVersion: "6.0.0", issueCount: 1 }]
				});
				await expect(store.getEntityDetails(secondPlan.id)).resolves.toMatchObject({
					versionCoverage: [{ calculatedVersion: "7.0.0", issueCount: 1 }]
				});
			} finally {
				await store.close();
			}
		});

		it("returns only issue records and their local relations for an initiative Issues tab", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Scoped tab reads" });
				const issue = await store.createEntity({ kind: "issue", title: "Visible issue", parentId: initiative.id });
				const blocker = await store.createEntity({ kind: "issue", title: "Visible blocker", parentId: initiative.id });
				const adr = await store.createEntity({ kind: "adr", title: "Hidden ADR", parentId: initiative.id });
				await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
				await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });

				const tab = await store.getInitiativeTab({ initiativeId: initiative.id, tab: "issues" });

				expect(tab.records.map((record) => record.id).sort()).toEqual([blocker.id, issue.id].sort());
				expect(tab.relations).toEqual([
					expect.objectContaining({ fromId: blocker.id, toId: issue.id, type: "blocks" })
				]);
			} finally {
				await store.close();
			}
		});

		it("returns all local records and relations for an initiative Graph tab", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Graph initiative" });
				const issue = await store.createEntity({ kind: "issue", title: "Graph issue", parentId: initiative.id });
				const adr = await store.createEntity({ kind: "adr", title: "Graph ADR", parentId: initiative.id });
				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative" });
				const otherIssue = await store.createEntity({ kind: "issue", title: "Other issue", parentId: otherInitiative.id });
				await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });

				const tab = await store.getInitiativeTab({ initiativeId: initiative.id, tab: "graph" });

				expect(tab.records.map((record) => record.id).sort()).toEqual([initiative.id, issue.id, adr.id].sort());
				expect(tab.records.map((record) => record.id)).not.toContain(otherIssue.id);
				expect(tab.relations).toContainEqual(expect.objectContaining({ fromId: adr.id, toId: issue.id, type: "constrains" }));
			} finally {
				await store.close();
			}
		});

		it("returns an initiative body without its related-record collections", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Detailed initiative", body: "Initiative body" });
				await store.createEntity({ kind: "issue", title: "Unrelated detail record", parentId: initiative.id });

				const detail = await store.getInitiativeDetail({ initiativeId: initiative.id });

				expect(detail).toEqual({
					initiative: expect.objectContaining({ body: "Initiative body", id: initiative.id })
				});
			} finally {
				await store.close();
			}
		});

		it("returns the records required by each active initiative record tab", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Record tabs" });
				const plan = await store.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
				const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
				const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
				const issue = await store.createEntity({ kind: "issue", title: "Issue", parentId: initiative.id });
				const adr = await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });
				const debt = await store.createEntity({
					kind: "debt",
					title: "Debt",
					parentId: initiative.id,
					category: "technical",
					priority: "high"
				});
				await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });

				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "plans" })).resolves.toMatchObject({ records: [expect.objectContaining({ id: plan.id })] });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "prds" })).resolves.toMatchObject({ records: [expect.objectContaining({ id: prd.id })] });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "adrs" })).resolves.toMatchObject({ records: [expect.objectContaining({ id: adr.id })] });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "debt" })).resolves.toMatchObject({ records: [expect.objectContaining({ id: debt.id })] });
				await expect(store.getInitiativeTab({ initiativeId: initiative.id, tab: "userStories" })).resolves.toMatchObject({
					records: [expect.objectContaining({ id: story.id }), expect.objectContaining({ id: issue.id })],
					relations: [expect.objectContaining({ fromId: issue.id, toId: story.id, type: "fixes" })]
				});
			} finally {
				await store.close();
			}
		});

		it("returns an initiative rollup and glossary in their own tabs", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Specialized tabs" });
				await store.createEntity({ kind: "issue", title: "Done issue", parentId: initiative.id, status: "done" });
				const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
				await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
				await store.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
				await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });
				await store.createEntity({ category: "technical", kind: "debt", priority: "high", title: "Debt", parentId: initiative.id });
				await store.upsertContext({ scopeRef: initiative.id, title: "Initiative Context", summary: "Initiative glossary" });
				await store.defineContextTerm({ scopeRef: initiative.id, term: "Overview", definition: "Initiative overview." });

				const overview = await store.getInitiativeTab({ initiativeId: initiative.id, tab: "overview" });
				const context = await store.getInitiativeTab({ initiativeId: initiative.id, tab: "context" });

				expect(overview).toMatchObject({
					records: [],
					relations: [],
					rollup: { adrCount: 1, completedIssueCount: 1, contextTermCount: 1, debtCount: 1, issueCount: 1, planCount: 1, prdCount: 1, userStoryCount: 1 }
				});
				expect(context).toMatchObject({
					records: [],
					relations: [],
					context: { context: expect.objectContaining({ scopeEntityId: initiative.id, summary: "Initiative glossary" }) }
				});
			} finally {
				await store.close();
			}
		});

		it("records lifecycle revisions in the canonical reverse-delta chain", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.updateEntityStatus({ entityId: initiative.id, status: "active" });

				await expect(store.materializeEntityRevision({ entityId: initiative.id, revision: 1 })).resolves.toEqual(
					expect.objectContaining({ status: "draft", headRevision: 2 })
				);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: snapshot signature (${label})`, () => {
		it("stays stable across calls with no intervening write, then changes after one (ISS191)", async () => {
			const store = await openStore();

			try {
				const before = await store.getSnapshotSignature();
				const stillBefore = await store.getSnapshotSignature();
				expect(stillBefore).toBe(before);

				await store.createEntity({ kind: "initiative", title: "Snapshot signature bump" });

				const after = await store.getSnapshotSignature();
				expect(after).not.toBe(before);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: canonical-chain import (${label})`, () => {
		it("imports an initiative-owned ready Plan through its canonical entity chain", async () => {
			const source = await openStore();
			const target = await openStore();
			try {
				const initiative = await source.createEntity({ kind: "initiative", title: "Plan owner" });
				const plan = await source.createEntity({ kind: "plan", title: "Imported plan", body: "## Goal\n\nBuild it.\n\n## Context\n\nTrack it.", parentId: initiative.id });
				await source.updateEntityStatus({ entityId: plan.id, status: "ready" });
				const sourcePlan = (await source.getEntityDetails(plan.id)).entity;
				const bundle = await source.exportCanonicalChains();

				await target.importCanonicalChains(bundle);

				expect((await target.getEntityDetails(plan.id)).entity).toMatchObject({
					body: sourcePlan.body,
					kind: "plan",
					reference: plan.reference,
					status: "ready"
				});
				expect((await target.getEntityDetails(plan.id)).incoming).toEqual(expect.arrayContaining([
					expect.objectContaining({ relationType: "owns", entity: expect.objectContaining({ id: initiative.id }) })
				]));
			} finally {
				await source.close();
				await target.close();
			}
		});

		it("imports new records, strict extensions, contexts, and terms exactly once", async () => {
			const source = await openStore();
			const target = await openStore();
			try {
				const created = await source.createEntity({ kind: "issue", title: "First", body: "First body" });
				const revision2 = await source.updateEntity({ entityId: created.id, title: "Second", body: "Second body", expectedRevision: created.revision, expectedContentHash: created.contentHash });
				await source.updateEntity({ entityId: created.id, title: "Third", body: "Third body", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
				const context = await source.upsertContext({ title: "Language", summary: "Canonical terms." });
				const term = await source.defineContextTerm({ term: "Order", definition: "Initial." });
				await source.defineContextTerm({ term: "Order", definition: "Current.", expectedRevision: term.term.revision, expectedContentHash: term.term.contentHash });
				expect(context.context.shortReference).toMatch(/^CTX_[0-9A-HJKMNP-TV-Z]{6}$/);
				expect(term.term.shortReference).toMatch(/^TERM_[0-9A-HJKMNP-TV-Z]{6}$/);

				const bundle = await source.exportCanonicalChains();
				await source.deleteTenant(source.tenantId);
				const imported = await target.importCanonicalChains(bundle);
				expect(imported.entitiesCreated).toContain(created.id);
				expect(imported.contextsCreated).toContain(context.context.key);
				expect(imported.contextTermsCreated).toContain(`${context.context.key}:Order`);
				await expect(target.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toMatchObject({ title: "First", body: "First body", headRevision: 3 });
				await expect(target.materializeEntityRevision({ entityId: created.id, revision: 2 })).resolves.toMatchObject({ title: "Second", body: "Second body", headRevision: 3 });
				await expect(target.materializeContextTermRevision({ term: "Order", revision: 1 })).resolves.toMatchObject({ definition: "Initial.", headRevision: 2 });
				expect(await target.importCanonicalChains(bundle)).toEqual({ entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [], issueCommentsCreated: [], issueCommentsAdvanced: [], planEntriesCreated: [], planEntriesAdvanced: [], completionObservationsCreated: [], usersCreated: [], usersUpdated: [] });
				const afterImport = await target.createEntity({ kind: "issue", title: "After import" });
				expect(afterImport.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
				expect(afterImport.reference).toMatch(/^ISS_[0-9A-HJKMNP-TV-Z]{26}$/);
				expect(afterImport.id).not.toBe(created.id);
			} finally {
				await source.close();
				await target.close();
			}
		});

		it("rejects a divergent batch atomically with current head metadata", async () => {
			const source = await openStore();
			const target = await openStore();
			try {
				const shared = await source.createEntity({ kind: "issue", title: "Shared" });
				await target.importCanonicalChains(await source.exportCanonicalChains());
				await source.updateEntity({ entityId: shared.id, title: "Source", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
				await target.updateEntity({ entityId: shared.id, title: "Target", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
				const newRecord = await source.createEntity({ kind: "issue", title: "Must not import" });
				const bundle = await source.exportCanonicalChains();
				await source.deleteTenant(source.tenantId);
				const signatureBefore = await target.getSnapshotSignature();

				await expect(target.importCanonicalChains(bundle)).rejects.toMatchObject({ name: "SynchronizeConflictError", recordKind: "entity", recordId: shared.id, currentRevision: 2 });
				await expect(target.getEntityDetails(newRecord.id)).rejects.toThrow(/not found/i);
				expect(await target.getSnapshotSignature()).toBe(signatureBefore);
			} finally {
				await source.close();
				await target.close();
			}
		});
	});

	describe(`storage-driver seam: context lifecycle (${label})`, () => {
		it("resolves a nested issue scope through its owning initiative", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
				const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Settlement" });
				const subIssue = await store.createEntity({ kind: "issue", parentId: issue.id, title: "Retries" });

				await store.defineContextTerm({ scopeRef: subIssue.id, term: "Capture", definition: "Confirmed funds." });

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.terms.map((term) => term.term)).toContain("Capture");
			} finally {
				await store.close();
			}
		});

		it("context term creation establishes a revision-1 baseline with a canonical content hash", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({
					term: "Order",
					definition: "A confirmed purchase.",
					avoid: [" request ", "Request", "Order"]
				});

				expect(created.term.revision).toBe(1);
				expect(created.term.contentHash).toBe(
					computeContextTermContentHash("Order", "A confirmed purchase.", ["request"], false)
				);
				expect(created.term).not.toHaveProperty("definition");
				expect((await store.getContextDetails()).terms.find((term) => term.id === created.term.id)?.definition).toBe("A confirmed purchase.");
			} finally {
				await store.close();
			}
		});

		it("context term edits use CAS and stale writes leave the current head unchanged", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
				const updated = await store.defineContextTerm({
					term: "Order",
					definition: "Updated definition.",
					avoid: ["request"],
					author: "alice",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				});

				expect(updated.created).toBe(false);
				expect(updated.term.revision).toBe(2);
				expect(updated.term.contentHash).toBe(
					computeContextTermContentHash("Order", "Updated definition.", ["request"], false)
				);

				await expect(store.defineContextTerm({
					term: "Order",
					definition: "Stale definition.",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				})).rejects.toMatchObject({
					name: "ContextTermConflictError",
					term: "Order",
					currentRevision: updated.term.revision,
					currentContentHash: updated.term.contentHash
				});

				const head = (await store.getContextDetails()).terms.find((candidate) => candidate.term === "Order");
				expect(head).toMatchObject(updated.term);
			} finally {
				await store.close();
			}
		});

		it("context term removal tombstones the chain and a matching define resurrects it", async () => {
			const store = await openStore();

			try {
				const created = await store.defineContextTerm({ term: "Order", definition: "Initial definition." });
				const forgotten = await store.forgetContextTerm({
					term: "Order",
					author: "alice",
					expectedRevision: created.term.revision,
					expectedContentHash: created.term.contentHash
				});

				expect(forgotten).toMatchObject({ removed: true, currentRevision: 2 });
				expect((await store.getContextDetails()).terms).toEqual([]);

				let tombstoneHead: ContextTermConflictError | undefined;
				try {
					await store.defineContextTerm({ term: "Order", definition: "Restored definition." });
				} catch (error) {
					if (error instanceof ContextTermConflictError) {
						tombstoneHead = error;
					}
				}
				expect(tombstoneHead?.currentRevision).toBe(2);

				const restored = await store.defineContextTerm({
					term: "Order",
					definition: "Restored definition.",
					expectedRevision: tombstoneHead!.currentRevision,
					expectedContentHash: tombstoneHead!.currentContentHash
				});
				expect(restored).toMatchObject({ created: false, term: { revision: 3 } });
				const restoredTerm = (await store.getContextDetails()).terms.find((candidate) => candidate.id === restored.term.id);
				expect(restoredTerm).toMatchObject({ ...restored.term, definition: "Restored definition." });
			} finally {
				await store.close();
			}
		});

		it("defines, reads, queries, and forgets a context term through the seam", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				await store.upsertContext({ scopeRef: initiative.id, title: "Custom title", summary: "Custom summary" });

				const defineResult = await store.defineContextTerm({
					scopeRef: initiative.id,
					term: "storage-driver seam",
					definition: "The engine-agnostic boundary the domain layer talks to."
				});
				expect(defineResult.created).toBe(true);

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.context.title).toBe("Custom title");
				expect(details.terms.map((term) => term.term)).toContain("storage-driver seam");

				const directory = await store.getContextDirectory();
				expect(directory.initiatives.map((entry) => entry.context.scopeEntityId)).toContain(initiative.id);

				const queried = await store.queryContextDirectory({ query: "storage-driver" });
				expect(queried.terms.map((term) => term.term)).toContain("storage-driver seam");

				expect((await store.listContexts()).contexts.length).toBeGreaterThan(0);

				const forgotten = await store.forgetContextTerm({
					scopeRef: initiative.id,
					term: "storage-driver seam",
					expectedRevision: defineResult.term.revision,
					expectedContentHash: defineResult.term.contentHash
				});
				expect(forgotten.removed).toBe(true);
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: lifecycle (${label})`, () => {
		it("releases the underlying connection on close", async () => {
			const store = await openStore();
			await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });

			await store.close();

			await expect(store.listEntities("initiative")).rejects.toThrow();
		});
	});

	describe(`storage-driver seam: bulk relations (${label})`, () => {
		it("queries bounded entities and selected relation edges", async () => {
			const store = await openStore();

			try {
				const selectedParent = await store.createEntity({ kind: "initiative", title: "Selected parent" });
				const otherParent = await store.createEntity({ kind: "initiative", title: "Other parent" });
				const first = await store.createEntity({ kind: "issue", title: "First", body: "First body", parentId: selectedParent.id });
				const second = await store.createEntity({ kind: "issue", title: "Second", parentId: selectedParent.id, status: "in-progress" });
				await store.createEntity({ kind: "issue", title: "Other", parentId: otherParent.id });
				await store.linkEntities({ fromId: first.id, toId: second.id, relationType: "blocks" });

				const queried = await store.queryEntities({
					kind: "issue",
					statuses: ["todo", "in-progress"],
					parentId: selectedParent.reference,
					limit: 1
				});
				expect(queried.entities).toHaveLength(1);
				expect([first.id, second.id]).toContain(queried.entities[0]?.id);
				expect(queried.total).toBe(2);
				expect(queried.entities[0]).not.toHaveProperty("body");
				expect(queried.entities[0]).not.toHaveProperty("bodySource");

				const relations = await store.queryEntityRelations({ entityId: second.id, direction: "incoming", types: ["blocks"] });
				expect(relations.incoming).toEqual([expect.objectContaining({ relationType: "blocks", entity: expect.objectContaining({ id: first.id }) })]);
				expect(relations.outgoing).toEqual([]);
				expect(relations.entity).not.toHaveProperty("body");
				expect(relations.incoming[0]?.entity).not.toHaveProperty("body");
				expect((await store.getEntityDetails(first.id)).entity).toMatchObject({ body: "First body", bodySource: "authored" });
			} finally {
				await store.close();
			}
		});

		it("reports open blockers inline on issue queries, keyed by reference so a caller can rank workable candidates from one list call", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Workable ranking" });
				const doneBlocker = await store.createEntity({ kind: "issue", title: "Done blocker", parentId: initiative.id, status: "done" });
				const openBlocker = await store.createEntity({ kind: "issue", title: "Open blocker", parentId: initiative.id });
				const secondOpenBlocker = await store.createEntity({ kind: "issue", title: "Second open blocker", parentId: initiative.id });
				const blocked = await store.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
				const unblocked = await store.createEntity({ kind: "issue", title: "Unblocked issue", parentId: initiative.id });
				await store.linkEntities({ fromId: doneBlocker.id, toId: blocked.id, relationType: "blocks" });
				await store.linkEntities({ fromId: openBlocker.id, toId: blocked.id, relationType: "blocks" });
				await store.linkEntities({ fromId: secondOpenBlocker.id, toId: blocked.id, relationType: "blocks" });

				const queried = await store.queryEntities({ kind: "issue", parentId: initiative.id });

				expect(queried.openBlockers?.[blocked.reference]?.sort()).toEqual([openBlocker.reference, secondOpenBlocker.reference].sort());
				expect(queried.openBlockers?.[unblocked.reference]).toEqual([]);
				expect(queried.openBlockers?.[openBlocker.reference]).toEqual([]);
				expect(queried.openBlockers?.[doneBlocker.reference]).toEqual([]);
				expect(Object.keys(queried.openBlockers ?? {})).not.toContain(blocked.id);

				const nonIssueQuery = await store.queryEntities({ kind: "initiative" });
				expect(nonIssueQuery.openBlockers).toBeUndefined();

				// A blocker outside the returned/scoped set must still be found:
				// its open/done status is looked up independently of which
				// issues `--parent`/`--limit` actually returned.
				const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other initiative" });
				const outsideScopeBlocker = await store.createEntity({ kind: "issue", title: "Outside-scope blocker", parentId: otherInitiative.id });
				const blockedByOutsider = await store.createEntity({ kind: "issue", title: "Blocked by outsider", parentId: initiative.id });
				await store.linkEntities({ fromId: outsideScopeBlocker.id, toId: blockedByOutsider.id, relationType: "blocks" });

				const scoped = await store.queryEntities({ kind: "issue", parentId: initiative.id });
				expect(scoped.entities.map((entity) => entity.id)).not.toContain(outsideScopeBlocker.id);
				expect(scoped.openBlockers?.[blockedByOutsider.reference]).toEqual([outsideScopeBlocker.reference]);

				const emptyMatch = await store.queryEntities({ kind: "issue", parentId: initiative.id, statuses: ["in-progress"] });
				expect(emptyMatch.entities).toEqual([]);
				expect(emptyMatch.openBlockers).toEqual({});

				const missingParent = await store.queryEntities({ kind: "issue", parentId: "missing-parent-id" });
				expect(missingParent).toEqual({ entities: [], total: 0, openBlockers: {} });
			} finally {
				await store.close();
			}
		});

		it("lists every relation key and idempotently applies a batch (ISS267/ADR55)", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const blocker = await store.createEntity({ kind: "issue", title: "Blocker issue", parentId: initiative.id });
				const blocked = await store.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
				await store.linkEntities({ fromId: blocker.id, toId: blocked.id, relationType: "blocks" });

				const relations = await store.listAllRelations();
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: blocker.id, type: "tracks" }));
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: blocked.id, type: "tracks" }));
				expect(relations).toContainEqual(expect.objectContaining({ fromId: blocker.id, toId: blocked.id, type: "blocks" }));

				const reapplied = await store.applyRelations(relations);
				expect(reapplied.inserted).toBe(0);

				const foreignRelation = { fromId: blocked.id, toId: blocker.id, type: "blocks" as const, createdBy: "system", createdAt: new Date().toISOString() };
				const appliedForeign = await store.applyRelations([foreignRelation, ...relations]);
				expect(appliedForeign.inserted).toBe(1);

				const afterApply = await store.listAllRelations();
				expect(afterApply).toContainEqual(expect.objectContaining({ fromId: blocked.id, toId: blocker.id, type: "blocks" }));
			} finally {
				await store.close();
			}
		});

		it("still lists a structural-type relation manually linked alongside an entity's real structural parent", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
				const issueA = await store.createEntity({ kind: "issue", title: "Issue A", parentId: initiative.id });
				const issueB = await store.createEntity({ kind: "issue", title: "Issue B", parentId: initiative.id });

				// A "decomposes" edge is structural (usually auto-derived from
				// `parentId`), but the `link` command lets it be created as a
				// plain manual annotation too, coexisting with issueB's real
				// structural parent (the initiative, via "tracks") -
				// `reconcileStructuralParent` tolerates this extra row but never
				// reconstructs it, so `listAllRelations` must not drop it either.
				await store.linkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "decomposes" });

				const relations = await store.listAllRelations();
				expect(relations).toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: issueB.id, type: "tracks" }));
				expect(relations).toContainEqual(expect.objectContaining({ fromId: issueA.id, toId: issueB.id, type: "decomposes" }));
			} finally {
				await store.close();
			}
		});
	});

describe(`storage-driver seam: entity revision and reverse-delta chain (${label})`, () => {
	it("creation establishes revision-1 baseline with a correct content hash", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body." });

			expect(entity.revision).toBe(1);
			expect(entity.contentHash).toBe(computeEntityContentHash("Initial title", "Initial body."));

			const details = await store.getEntityDetails(entity.id);
			expect(details.entity.revision).toBe(1);
			expect(details.entity.contentHash).toBe(entity.contentHash);

			const listed = await store.listEntities("issue");
			const found = listed.find((e) => e.id === entity.id);
			expect(found?.revision).toBe(1);
			expect(found?.contentHash).toBe(entity.contentHash);
		} finally {
			await store.close();
		}
	});

	it("a matching edit atomically advances revision and appends a reverse delta", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });
			expect(created.revision).toBe(1);

			const edited = await store.updateEntity({
				entityId: created.id,
				title: "Updated title",
				body: "Updated body.",
				expectedRevision: created.revision,
				expectedContentHash: created.contentHash
			});

			expect(edited.revision).toBe(2);
			expect(edited.contentHash).toBe(computeEntityContentHash("Updated title", "Updated body."));
			expect(edited.title).toBe("Updated title");
			expect(edited.body).toBe("Updated body.");

			const details = await store.getEntityDetails(edited.id);
			expect(details.entity.revision).toBe(2);
			expect(details.entity.contentHash).toBe(edited.contentHash);

			await expect(store.materializeEntityRevision({ entityId: edited.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ title: "Original title", body: "Original body.", headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("content mutations resolve stable entity references", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });
			const edited = await store.updateEntity({
				entityId: created.reference,
				title: "Updated title",
				expectedRevision: created.revision,
				expectedContentHash: created.contentHash
			});
			const bodyUpdated = await store.setEntityBody({
				entityId: created.reference,
				body: "Updated body.",
				expectedRevision: edited.revision,
				expectedContentHash: edited.contentHash
			});
			const statusUpdated = await store.updateEntityStatus({ entityId: created.reference, status: "in-progress" });
			const restored = await store.restoreEntityRevision({
				entityId: created.reference,
				revision: 1,
				expectedRevision: statusUpdated.entity.revision,
				expectedContentHash: statusUpdated.entity.contentHash
			});
			const deleted = await store.deleteEntity({ entityId: created.reference });

			expect(bodyUpdated).toMatchObject({
				id: created.id,
				reference: created.reference,
				title: "Updated title",
				body: "Updated body.",
				revision: 3
			});
			expect(restored).toMatchObject({ entityId: created.id, title: "Original title", body: "Original body." });
			expect(deleted).toMatchObject({ entity: { id: created.id, reference: created.reference }, removed: true });
			await expect(store.getEntityDetails(created.id)).rejects.toThrow(`Entity not found: ${created.id}`);
		} finally {
			await store.close();
		}
	});

	it("a stale revision rejects with current revision metadata and leaves head unchanged", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });

			await expect(
				store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 99,
					expectedContentHash: created.contentHash
				})
			).rejects.toThrow(EntityConflictError);

			try {
				await store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 99,
					expectedContentHash: created.contentHash
				});
			} catch (err) {
				expect(err).toBeInstanceOf(EntityConflictError);
				expect((err as EntityConflictError).currentRevision).toBe(1);
				expect((err as EntityConflictError).currentContentHash).toBe(created.contentHash);
			}

			const unchanged = await store.getEntityDetails(created.id);
			expect(unchanged.entity.title).toBe("Original title");
			expect(unchanged.entity.revision).toBe(1);

			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 1, headRevision: 1, title: "Original title", body: "Original body." })
			);
		} finally {
			await store.close();
		}
	});

	it("a stale content hash rejects even when revision matches", async () => {
		const store = await openStore();

		try {
			const created = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body." });

			await expect(
				store.updateEntity({
					entityId: created.id,
					title: "Should not apply",
					expectedRevision: 1,
					expectedContentHash: "wrong-hash-never-valid"
				})
			).rejects.toThrow(EntityConflictError);

			const unchanged = await store.getEntityDetails(created.id);
			expect(unchanged.entity.title).toBe("Original title");
			expect(unchanged.entity.revision).toBe(1);
		} finally {
			await store.close();
		}
	});

	it("setEntityBody also validates revision/hash and appends a delta on match", async () => {
		const store = await openStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Plan", body: "" });
			const issue = await store.createEntity({ kind: "issue", title: "Issue", parentId: initiative.id });

			const updated = await store.setEntityBody({
				entityId: issue.id,
				body: "Detailed plan.",
				expectedRevision: issue.revision,
				expectedContentHash: issue.contentHash
			});

			expect(updated.revision).toBe(2);
			expect(updated.body).toBe("Detailed plan.");
			expect(updated.contentHash).toBe(computeEntityContentHash("Issue", "Detailed plan."));

			await expect(
				store.setEntityBody({
					entityId: issue.id,
					body: "Late arrival.",
					expectedRevision: issue.revision,
					expectedContentHash: issue.contentHash
				})
			).rejects.toThrow(EntityConflictError);

			try {
				await store.setEntityBody({
					entityId: issue.id,
					body: "Late arrival.",
					expectedRevision: issue.revision,
					expectedContentHash: issue.contentHash
				});
			} catch (error) {
				expect(error).toBeInstanceOf(EntityConflictError);
				expect((error as EntityConflictError).currentRevision).toBe(updated.revision);
				expect((error as EntityConflictError).currentContentHash).toBe(updated.contentHash);
			}
		} finally {
			await store.close();
		}
	});

	it("sequential edits build a chain where each revision's hash matches its head content", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "v0 title", body: "v0 body." });

			const v2 = await store.updateEntity({
				entityId: entity.id,
				title: "v1 title",
				body: "v1 body.",
				expectedRevision: entity.revision,
				expectedContentHash: entity.contentHash
			});

			const v3 = await store.updateEntity({
				entityId: entity.id,
				title: "v2 title",
				body: "v2 body.",
				expectedRevision: v2.revision,
				expectedContentHash: v2.contentHash
			});

			expect(v2.revision).toBe(2);
			expect(v3.revision).toBe(3);
			expect(v3.contentHash).toBe(computeEntityContentHash("v2 title", "v2 body."));

			await expect(store.materializeEntityRevision({ entityId: entity.id, revision: 1 })).resolves.toEqual(expect.objectContaining({ title: "v0 title", body: "v0 body.", headRevision: 3 }));
			await expect(store.materializeEntityRevision({ entityId: entity.id, revision: 2 })).resolves.toEqual(expect.objectContaining({ title: "v1 title", body: "v1 body.", headRevision: 3 }));
		} finally {
			await store.close();
		}
	});

	it("materializes prior revisions without changing the current head or history", async () => {
		const store = await openStore();

		try {
			const revision1 = await store.createEntity({ kind: "issue", title: "First title", body: "First body." });
			const revision2 = await store.updateEntity({
				entityId: revision1.id,
				title: "Second title",
				body: "Second body.",
				expectedRevision: revision1.revision,
				expectedContentHash: revision1.contentHash
			});
			const revision3 = await store.updateEntity({
				entityId: revision1.id,
				title: "Third title",
				body: "Third body.",
				expectedRevision: revision2.revision,
				expectedContentHash: revision2.contentHash
			});
			const historyBefore = await store.listEntityHistory(revision1.id);

			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 2 })).resolves.toEqual(
				expect.objectContaining({
					entityId: revision1.id,
					targetRevision: 2,
					headRevision: 3,
					title: "Second title",
					body: "Second body.",
					bodySource: "authored"
				})
			);
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({
					entityId: revision1.id,
					targetRevision: 1,
					headRevision: 3,
					title: "First title",
					body: "First body.",
					bodySource: "authored"
				})
			);

			const headAfter = await store.getEntityDetails(revision1.id);
			expect(headAfter.entity).toEqual(revision3);
			expect(await store.listEntityHistory(revision1.id)).toEqual(historyBefore);
		} finally {
			await store.close();
		}
	});

	it("restores a prior revision as a new head and preserves the existing chain", async () => {
		const store = await openStore();

		try {
			const revision1 = await store.createEntity({ kind: "issue", title: "First title", body: "First body." });
			const revision2 = await store.updateEntity({ entityId: revision1.id, title: "Second title", body: "Second body.", expectedRevision: revision1.revision, expectedContentHash: revision1.contentHash });
			const revision3 = await store.updateEntity({ entityId: revision1.id, title: "Third title", body: "Third body.", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
			const users = await store.listUsers();
			const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
				?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
				?? users[0]?.id;

			const restored = await store.restoreEntityRevision({ entityId: revision1.id, revision: 1, author: "restorer", expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash });
			expect(restored).toEqual(expect.objectContaining({ entityId: revision1.id, targetRevision: 4, headRevision: 4, title: "First title", body: "First body.", author: defaultUserId, restoredFromRevision: 1 }));
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 3 })).resolves.toEqual(expect.objectContaining({ title: "Third title", body: "Third body.", restoredFromRevision: null }));
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 1 })).resolves.toEqual(expect.objectContaining({ title: "First title", body: "First body.", restoredFromRevision: null }));

			await expect(store.restoreEntityRevision({ entityId: revision1.id, revision: 2, expectedRevision: revision3.revision, expectedContentHash: revision3.contentHash })).rejects.toMatchObject({ name: "EntityConflictError", currentRevision: 4 });
			await expect(store.materializeEntityRevision({ entityId: revision1.id, revision: 4 })).resolves.toEqual(restored);
		} finally {
			await store.close();
		}
	});

	it("restores active and tombstoned lifecycle states through new heads", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
			const created = await store.createEntity({ kind: "issue", title: "Recoverable", parentId: parent.id });
			await store.deleteEntity({ entityId: created.id });

			const active = await store.restoreEntityRevision({
				entityId: created.id,
				revision: 1,
				expectedRevision: 2,
				expectedContentHash: created.contentHash
			});
			expect(active).toEqual(expect.objectContaining({ targetRevision: 3, headRevision: 3, tombstone: false, parentId: parent.id, restoredFromRevision: 1 }));
			await expect(store.getEntityDetails(created.id)).resolves.toEqual(expect.objectContaining({ entity: expect.objectContaining({ id: created.id, revision: 3 }) }));

			const tombstoned = await store.restoreEntityRevision({
				entityId: created.id,
				revision: 2,
				expectedRevision: 3,
				expectedContentHash: computeEntityContentHash(active.title, active.body)
			});
			expect(tombstoned).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, tombstone: true, parentId: null, restoredFromRevision: 2 }));
			await expect(store.getEntityDetails(created.id)).rejects.toThrow(`Entity not found: ${created.id}`);
			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 3 })).resolves.toEqual(expect.objectContaining({ tombstone: false, parentId: parent.id }));
		} finally {
			await store.close();
		}
	});

	it("returns stable errors for missing entities and out-of-range revisions", async () => {
		const store = await openStore();

		try {
			const entity = await store.createEntity({ kind: "issue", title: "Only revision" });
			const requests = [
				{ input: { entityId: "ISS-does-not-exist", revision: 1 }, reason: "entity-not-found" },
				{ input: { entityId: entity.id, revision: 0 }, reason: "revision-out-of-range" },
				{ input: { entityId: entity.id, revision: 2 }, reason: "revision-out-of-range" }
			] as const;

			for (const request of requests) {
				try {
					await store.materializeEntityRevision(request.input);
					expect.unreachable("Expected materialization to reject");
				} catch (error) {
					expect(error).toBeInstanceOf(EntityRevisionError);
					expect((error as EntityRevisionError).reason).toBe(request.reason);
				}
			}
		} finally {
			await store.close();
		}
	});

	it("records status changes in the revision chain", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Lifecycle issue" });
			const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });

			expect(statusUpdate.entity).toEqual(expect.objectContaining({ status: "in-progress", revision: 2 }));
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({
					entityId: issue.id,
					targetRevision: 1,
					headRevision: 2,
					status: "todo"
				})
			);
		} finally {
			await store.close();
		}
	});

	it("records an available workspace observation when an issue enters done", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Observed completion" });
			const workspaceObservation = {
				state: "available" as const,
				repositoryIdentity: "a".repeat(64),
				commitSha: "b".repeat(40),
				branch: "main",
				dirty: true,
				capturedAt: "2026-09-22T13:00:00.000Z",
				calculatedVersion: {
					state: "available" as const,
					version: "1.2.3",
					branch: "main",
					currentCommit: "b".repeat(40),
					isTrunkBranch: true,
					commitsSinceTag: 0,
					commitBumps: { major: 0, minor: 0, patch: 0 }
				},
				fingerprint: {
					repositoryIdentity: "a".repeat(64),
					commitSha: "b".repeat(40),
					branch: "main",
					refsHash: "c".repeat(64)
				}
			};

			await store.updateEntityStatus({ entityId: issue.id, status: "done", workspaceObservation });

			const details = await store.getEntityDetails(issue.id);
			expect(details.completionObservations).toEqual([
				expect.objectContaining({
					id: expect.any(String),
					issueId: issue.id,
					completionOrdinal: 1,
					repositoryIdentity: workspaceObservation.repositoryIdentity,
					commitSha: workspaceObservation.commitSha,
					branch: "main",
					dirty: true,
					capturedAt: "2026-09-22T13:00:00.000Z",
					calculatedVersionState: "available",
					calculatedVersion: "1.2.3",
					diagnostics: []
				})
			]);
			expect(details.currentCompletionObservation).toMatchObject({
				issueId: issue.id,
				completionOrdinal: 1
			});
		} finally {
			await store.close();
		}
	});

	it("imports completion observations after their issue", async () => {
		const source = await openStore();
		const target = await openStore();

		try {
			const issue = await source.createEntity({ kind: "issue", title: "Synchronized completion" });
			await source.updateEntityStatus({
				entityId: issue.id,
				status: "done",
				workspaceObservation: {
					state: "unknown",
					capturedAt: "2026-09-23T13:00:00.000Z",
					diagnostics: [{ code: "workspace-observation-failed", message: "No repository is available." }]
				}
			});

			await target.importCanonicalChains(await source.exportCanonicalChains());

			expect((await target.getEntityDetails(issue.id)).completionObservations).toEqual(
				(await source.getEntityDetails(issue.id)).completionObservations
			);
		} finally {
			await source.close();
			await target.close();
		}
	});

	it("imports a legacy canonical bundle without completion observations", async () => {
		const source = await openStore();
		const target = await openStore();

		try {
			const issue = await source.createEntity({ kind: "issue", title: "Legacy completion synchronization" });
			await target.importCanonicalChains(await source.exportCanonicalChains());
			await target.updateEntityStatus({
				entityId: issue.id,
				status: "done",
				workspaceObservation: {
					state: "unknown",
					capturedAt: "2026-09-23T13:00:00.000Z",
					diagnostics: [{ code: "workspace-observation-failed", message: "No repository is available." }]
				}
			});
			const expected = (await target.getEntityDetails(issue.id)).completionObservations;
			const { completionObservations: _completionObservations, ...legacyBundle } = await source.exportCanonicalChains();

			await target.importCanonicalChains(legacyBundle);

			expect((await target.getEntityDetails(issue.id)).completionObservations).toEqual(expected);
		} finally {
			await source.close();
			await target.close();
		}
	});

	it("keeps earlier observations and makes the latest re-completion current", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Re-completed observation" });
			const initialObservation = {
				state: "available" as const,
				repositoryIdentity: "d".repeat(64),
				commitSha: "e".repeat(40),
				branch: "main",
				dirty: false,
				capturedAt: "2026-09-22T13:00:00.000Z",
				calculatedVersion: {
					state: "available" as const,
					version: "1.2.3",
					branch: "main",
					currentCommit: "e".repeat(40),
					isTrunkBranch: true,
					commitsSinceTag: 0,
					commitBumps: { major: 0, minor: 0, patch: 0 }
				},
				fingerprint: { repositoryIdentity: "d".repeat(64), commitSha: "e".repeat(40), branch: "main", refsHash: "f".repeat(64) }
			};
			await store.updateEntityStatus({ entityId: issue.id, status: "done", workspaceObservation: initialObservation });
			await store.updateEntityStatus({ entityId: issue.id, status: "done", workspaceObservation: initialObservation });
			await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
			await store.updateEntityStatus({
				entityId: issue.id,
				status: "done",
				workspaceObservation: {
					...initialObservation,
					capturedAt: "2026-09-23T13:00:00.000Z",
					calculatedVersion: {
						state: "unknown",
						diagnostics: [{ code: "prospector-calculation-failed", message: "Unable to calculate version." }]
					}
				}
			});

			const details = await store.getEntityDetails(issue.id);
			expect(details.completionObservations).toEqual([
				expect.objectContaining({ completionOrdinal: 1, calculatedVersion: "1.2.3", diagnostics: [] }),
				expect.objectContaining({
					completionOrdinal: 2,
					calculatedVersionState: "unknown",
					calculatedVersion: null,
					diagnostics: [{ code: "prospector-calculation-failed", message: "Unable to calculate version." }]
				})
			]);
			expect(details.currentCompletionObservation).toMatchObject({ completionOrdinal: 2, calculatedVersion: null });
		} finally {
			await store.close();
		}
	});

	it("does not create an observation without a workspace observation or for a non-issue", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Unobserved completion" });
			await store.updateEntityStatus({ entityId: issue.id, status: "done" });
			expect((await store.getEntityDetails(issue.id)).completionObservations).toEqual([]);

			const project = await store.createEntity({ kind: "project", title: "Completed project" });
			await store.updateEntityStatus({
				entityId: project.id,
				status: "done",
				workspaceObservation: {
					state: "unknown",
					capturedAt: "2026-09-24T13:00:00.000Z",
					diagnostics: [{ code: "workspace-observation-failed", message: "No repository is available." }]
				}
			});
			const details = await store.getEntityDetails(project.id);
			expect(details.completionObservations).toEqual([]);
			expect(details.currentCompletionObservation).toBeNull();
		} finally {
			await store.close();
		}
	});

	it("ranks a completed issue with the exact commit before the caller limit", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const otherCommit = "c".repeat(40);
		const workspaceObservation = (commitSha: string, calculatedVersion: string) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: {
				state: "available" as const,
				version: calculatedVersion,
				branch: "main",
				currentCommit: commitSha,
				isTrunkBranch: true,
				commitsSinceTag: 0,
				commitBumps: { major: 0, minor: 0, patch: 0 }
			},
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "d".repeat(64) }
		});

		try {
			await store.createEntity({ kind: "issue", title: "Other completed issue" });
			await store.createEntity({ kind: "issue", title: "Exact completed issue" });
			const normalOrder = await store.queryEntities({ kind: "issue" });
			const [otherIssue, exactIssue] = normalOrder.entities;
			expect(otherIssue).toBeDefined();
			expect(exactIssue).toBeDefined();

			await store.updateEntityStatus({ entityId: otherIssue!.id, status: "done", workspaceObservation: workspaceObservation(otherCommit, "1.1.0") });
			await store.updateEntityStatus({ entityId: exactIssue!.id, status: "done", workspaceObservation: workspaceObservation(exactCommit, "1.2.3") });

			const ranked = await store.queryEntities({
				kind: "issue",
				statuses: ["done"],
				limit: 1,
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, calculatedVersion: "1.2.3", diagnostics: [] }
			});

			expect(ranked).toMatchObject({
				total: 2,
				retrievalDiagnostics: [],
				entities: [expect.objectContaining({ id: exactIssue!.id, codeCompatibility: "exact-commit" })]
			});
		} finally {
			await store.close();
		}
	});

	it("orders completed issues by calculated-version compatibility", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string, calculatedVersion: string | null) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: calculatedVersion === null
				? { state: "unknown" as const, diagnostics: [{ code: "prospector-calculation-failed" as const, message: "Version is unavailable." }] }
				: {
					state: "available" as const,
					version: calculatedVersion,
					branch: "main",
					currentCommit: commitSha,
					isTrunkBranch: true,
					commitsSinceTag: 0,
					commitBumps: { major: 0, minor: 0, patch: 0 }
				},
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "d".repeat(64) }
		});

		try {
			for (const title of ["Different major", "Same major", "Same minor", "Exact version", "Exact commit", "Unknown version"]) {
				await store.createEntity({ kind: "issue", title });
			}
			const normalOrder = await store.queryEntities({ kind: "issue" });
			const [differentMajor, sameMajor, sameMinor, exactVersion, exactCommitIssue, unknownVersion] = normalOrder.entities;
			expect(normalOrder.entities).toHaveLength(6);

			await store.updateEntityStatus({ entityId: differentMajor!.id, status: "done", workspaceObservation: workspaceObservation("c".repeat(40), "2.0.0") });
			await store.updateEntityStatus({ entityId: sameMajor!.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40), "1.3.0") });
			await store.updateEntityStatus({ entityId: sameMinor!.id, status: "done", workspaceObservation: workspaceObservation("e".repeat(40), "1.2.0") });
			await store.updateEntityStatus({ entityId: exactVersion!.id, status: "done", workspaceObservation: workspaceObservation("f".repeat(40), "1.2.3") });
			await store.updateEntityStatus({ entityId: exactCommitIssue!.id, status: "done", workspaceObservation: workspaceObservation(exactCommit, "1.2.3") });
			await store.updateEntityStatus({ entityId: unknownVersion!.id, status: "done", workspaceObservation: workspaceObservation("g".repeat(40), null) });

			const ranked = await store.queryEntities({
				kind: "issue",
				statuses: ["done"],
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, calculatedVersion: "1.2.3", diagnostics: [] }
			});

			expect(ranked.entities.map((entity) => [entity.id, entity.codeCompatibility])).toEqual([
				[exactCommitIssue!.id, "exact-commit"],
				[exactVersion!.id, "exact-version"],
				[sameMinor!.id, "same-minor-version"],
				[sameMajor!.id, "same-major-version"],
				[differentMajor!.id, "different-major-version"],
				[unknownVersion!.id, "unknown"]
			]);
		} finally {
			await store.close();
		}
	});

	it("keeps normal issue order when workspace version calculation fails", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: {
				state: "available" as const,
				version: "1.2.3",
				branch: "main",
				currentCommit: commitSha,
				isTrunkBranch: true,
				commitsSinceTag: 0,
				commitBumps: { major: 0, minor: 0, patch: 0 }
			},
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "c".repeat(64) }
		});

		try {
			await store.createEntity({ kind: "issue", title: "Normal first issue" });
			await store.createEntity({ kind: "issue", title: "Matching second issue" });
			const normalOrder = await store.queryEntities({ kind: "issue" });
			const [firstIssue, secondIssue] = normalOrder.entities;

			await store.updateEntityStatus({ entityId: firstIssue!.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40)) });
			await store.updateEntityStatus({ entityId: secondIssue!.id, status: "done", workspaceObservation: workspaceObservation(exactCommit) });

			const diagnostic = { code: "prospector-calculation-failed" as const, message: "Version is unavailable." };
			const queried = await store.queryEntities({
				kind: "issue",
				statuses: ["done"],
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, diagnostics: [diagnostic] }
			});

			expect(queried.entities.map((entity) => [entity.id, entity.codeCompatibility])).toEqual([
				[firstIssue!.id, "unknown"],
				[secondIssue!.id, "unknown"]
			]);
			expect(queried.retrievalDiagnostics).toEqual([diagnostic]);
		} finally {
			await store.close();
		}
	});

	it("ranks an exact completion commit in global search before the caller limit", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: {
				state: "available" as const,
				version: "1.2.3",
				branch: "main",
				currentCommit: commitSha,
				isTrunkBranch: true,
				commitsSinceTag: 0,
				commitBumps: { major: 0, minor: 0, patch: 0 }
			},
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "c".repeat(64) }
		});

		try {
			const otherIssue = await store.createEntity({ kind: "issue", title: "Completed search result" });
			const exactIssue = await store.createEntity({ kind: "issue", title: "Completed search result" });
			await store.updateEntityStatus({ entityId: exactIssue.id, status: "done", workspaceObservation: workspaceObservation(exactCommit) });
			await store.updateEntityStatus({ entityId: otherIssue.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40)) });

			const searched = await store.search({
				query: "Completed search result",
				scope: { type: "all-projects" },
				limit: 1,
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, calculatedVersion: "1.2.3", diagnostics: [] }
			});

			expect(searched).toMatchObject({
				state: "available",
				retrievalDiagnostics: [],
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: exactIssue.id }), codeCompatibility: "exact-commit" })]
			});
		} finally {
			await store.close();
		}
	});

	it("returns unknown compatibility for a completed search result without an observation", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Unobserved completed search result" });
			await store.updateEntityStatus({ entityId: issue.id, status: "done" });

			const searched = await store.search({
				query: "Unobserved completed search result",
				scope: { type: "all-projects" },
				retrievalContext: {
					repositoryIdentity: "a".repeat(64),
					commitSha: "b".repeat(40),
					calculatedVersion: "1.2.3",
					diagnostics: []
				}
			});

			expect(searched).toMatchObject({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: issue.id }), codeCompatibility: "unknown" })]
			});
		} finally {
			await store.close();
		}
	});

	it("orders equal global-search matches by calculated-version compatibility", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string, calculatedVersion: string | null) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: calculatedVersion === null
				? { state: "unknown" as const, diagnostics: [{ code: "prospector-calculation-failed" as const, message: "Version is unavailable." }] }
				: {
					state: "available" as const,
					version: calculatedVersion,
					branch: "main",
					currentCommit: commitSha,
					isTrunkBranch: true,
					commitsSinceTag: 0,
					commitBumps: { major: 0, minor: 0, patch: 0 }
				},
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "c".repeat(64) }
		});

		try {
			const issues = await Promise.all(Array.from({ length: 6 }, () => store.createEntity({ kind: "issue", title: "Versioned search result" })));
			await store.updateEntityStatus({ entityId: issues[0]!.id, status: "done", workspaceObservation: workspaceObservation("c".repeat(40), "2.0.0") });
			await store.updateEntityStatus({ entityId: issues[1]!.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40), "1.3.0") });
			await store.updateEntityStatus({ entityId: issues[2]!.id, status: "done", workspaceObservation: workspaceObservation("e".repeat(40), "1.2.0") });
			await store.updateEntityStatus({ entityId: issues[3]!.id, status: "done", workspaceObservation: workspaceObservation("f".repeat(40), "1.2.3") });
			await store.updateEntityStatus({ entityId: issues[4]!.id, status: "done", workspaceObservation: workspaceObservation(exactCommit, "1.2.3") });
			await store.updateEntityStatus({ entityId: issues[5]!.id, status: "done", workspaceObservation: workspaceObservation("g".repeat(40), null) });

			const searched = await store.search({
				query: "Versioned search result",
				scope: { type: "all-projects" },
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, calculatedVersion: "1.2.3", diagnostics: [] }
			});

			expect(searched).toMatchObject({
				state: "available",
				results: [
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[4]!.id }), codeCompatibility: "exact-commit" }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[3]!.id }), codeCompatibility: "exact-version" }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[2]!.id }), codeCompatibility: "same-minor-version" }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[1]!.id }), codeCompatibility: "same-major-version" }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[0]!.id }), codeCompatibility: "different-major-version" }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: issues[5]!.id }), codeCompatibility: "unknown" })
				]
			});
		} finally {
			await store.close();
		}
	});

	it("keeps global-search text relevance ahead of code compatibility", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: { state: "available" as const, version: "1.2.3", branch: "main", currentCommit: commitSha, isTrunkBranch: true, commitsSinceTag: 0, commitBumps: { major: 0, minor: 0, patch: 0 } },
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "c".repeat(64) }
		});

		try {
			const titleMatch = await store.createEntity({ kind: "issue", title: "Text priority result" });
			const exactCommitMatch = await store.createEntity({ kind: "issue", title: "Other result", body: "Text priority result" });
			await store.updateEntityStatus({ entityId: titleMatch.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40)) });
			await store.updateEntityStatus({ entityId: exactCommitMatch.id, status: "done", workspaceObservation: workspaceObservation(exactCommit) });

			const searched = await store.search({
				query: "Text priority result",
				scope: { type: "all-projects" },
				limit: 1,
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, calculatedVersion: "1.2.3", diagnostics: [] }
			});

			expect(searched).toMatchObject({ state: "available", results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: titleMatch.id }) })] });
		} finally {
			await store.close();
		}
	});

	it("keeps normal global-search order when workspace calculation fails", async () => {
		const store = await openStore();
		const repositoryIdentity = "a".repeat(64);
		const exactCommit = "b".repeat(40);
		const workspaceObservation = (commitSha: string) => ({
			state: "available" as const,
			repositoryIdentity,
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: { state: "available" as const, version: "1.2.3", branch: "main", currentCommit: commitSha, isTrunkBranch: true, commitsSinceTag: 0, commitBumps: { major: 0, minor: 0, patch: 0 } },
			fingerprint: { repositoryIdentity, commitSha, branch: "main", refsHash: "c".repeat(64) }
		});

		try {
			const firstIssue = await store.createEntity({ kind: "issue", title: "Diagnostic search result" });
			const exactIssue = await store.createEntity({ kind: "issue", title: "Diagnostic search result" });
			await store.updateEntityStatus({ entityId: exactIssue.id, status: "done", workspaceObservation: workspaceObservation(exactCommit) });
			await store.updateEntityStatus({ entityId: firstIssue.id, status: "done", workspaceObservation: workspaceObservation("d".repeat(40)) });
			const normal = await store.search({ query: "Diagnostic search result", scope: { type: "all-projects" } });
			const diagnostic = { code: "prospector-calculation-failed" as const, message: "Version is unavailable." };
			const searched = await store.search({
				query: "Diagnostic search result",
				scope: { type: "all-projects" },
				retrievalContext: { repositoryIdentity, commitSha: exactCommit, diagnostics: [diagnostic] }
			});

			expect(searched).toMatchObject({ state: "available", retrievalDiagnostics: [diagnostic] });
			if (normal.state !== "available" || searched.state !== "available") throw new Error("Search must be available.");
			expect(searched.results.map((result) => [result.identity.sourceId, result.codeCompatibility])).toEqual(
				normal.results.map((result) => [result.identity.sourceId, "unknown"])
			);
		} finally {
			await store.close();
		}
	});

	it("records archive status in the revision chain", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Archivable" });
			const archived = await store.archiveEntity({ entityId: issue.id });

			expect(archived.entity).toEqual(expect.objectContaining({ status: "done", revision: 2 }));
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ status: "todo", targetRevision: 1, headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("failed lifecycle writes leave the head and revision chain unchanged", async () => {
		const store = await openStore();

		try {
			const issue = await store.createEntity({ kind: "issue", title: "Stable" });
			const historyBefore = await store.listEntityHistory(issue.id);

			await expect(store.updateEntityStatus({ entityId: issue.id, status: "not-a-status" })).rejects.toThrow();
			await expect(store.moveEntity({ entityId: issue.id, newParentId: issue.id })).rejects.toThrow();

			const unchanged = await store.getEntityDetails(issue.id);
			expect(unchanged.entity).toMatchObject(issue);
			expect(await store.listEntityHistory(issue.id)).toEqual(historyBefore);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 2 })).rejects.toMatchObject({
				reason: "revision-out-of-range",
				headRevision: 1
			});
		} finally {
			await store.close();
		}
	});

	it("records structural moves in the revision chain", async () => {
		const store = await openStore();

		try {
			const firstParent = await store.createEntity({ kind: "initiative", title: "First parent" });
			const secondParent = await store.createEntity({ kind: "initiative", title: "Second parent" });
			const issue = await store.createEntity({ kind: "issue", title: "Movable", parentId: firstParent.id });
			const moved = await store.moveEntity({ entityId: issue.id, newParentId: secondParent.id });

			expect(moved.entity.revision).toBe(2);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ parentId: firstParent.id, targetRevision: 1, headRevision: 2 })
			);
		} finally {
			await store.close();
		}
	});

	it("records deletion as a tombstone while hiding the live entity", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
			const issue = await store.createEntity({ kind: "issue", title: "Disposable", parentId: parent.id });
			const deleted = await store.deleteEntity({ entityId: issue.id });

			expect(deleted).toEqual(expect.objectContaining({ removed: true, entity: expect.objectContaining({ id: issue.id }) }));
			await expect(store.getEntityDetails(issue.id)).rejects.toThrow(`Entity not found: ${issue.id}`);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 1, headRevision: 2, parentId: parent.id, tombstone: false })
			);
			await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 2 })).resolves.toEqual(
				expect.objectContaining({ targetRevision: 2, headRevision: 2, tombstone: true })
			);
		} finally {
			await store.close();
		}
	});

	it("listEntityHistory returns full revision facts from the reverse-delta chain", async () => {
		const store = await openStore();

		try {
			const parent = await store.createEntity({ kind: "initiative", title: "Host initiative" });
			const issue = await store.createEntity({ kind: "issue", title: "Initial title", body: "Initial body." });

			// revision 2: title/body edit
			const rev2 = await store.updateEntity({
				entityId: issue.id,
				title: "Revised title",
				body: "Revised body.",
				author: "alice",
				expectedRevision: 1,
				expectedContentHash: issue.contentHash
			});

			// revision 3: status change
			await store.updateEntityStatus({ entityId: issue.id, status: "in-progress", author: "bob" });

			// revision 4: structural move
			await store.moveEntity({ entityId: issue.id, newParentId: parent.id, author: "charlie" });

			// revision 5: tombstone (no author param on deleteEntity)
			await store.deleteEntity({ entityId: issue.id });

			// revision 6: restore revision 1
			await store.restoreEntityRevision({
				entityId: issue.id,
				revision: 1,
				author: "dave",
				expectedRevision: 5,
				expectedContentHash: rev2.contentHash
			});

			const history = await store.listEntityHistory(issue.id);
			const users = await store.listUsers();
			const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
				?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
				?? users[0]?.id;
			expect(await store.listEntityHistory(issue.reference)).toEqual(history);

			expect(history).toHaveLength(6);

			// Entries are oldest-first
			expect(history[0]).toMatchObject({
				entityId: issue.id,
				version: 1,
				title: "Initial title",
				body: "Initial body.",
				bodySource: "authored",
				status: "todo",
				parentId: null
			});
			expect(history[1]).toMatchObject({
				entityId: issue.id,
				version: 2,
				title: "Revised title",
				body: "Revised body.",
				bodySource: "authored",
				status: "todo",
				parentId: null,
				author: defaultUserId
			});
			expect(history[2]).toMatchObject({
				entityId: issue.id,
				version: 3,
				title: "Revised title",
				body: "Revised body.",
				status: "in-progress",
				parentId: null,
				author: defaultUserId
			});
			expect(history[3]).toMatchObject({
				entityId: issue.id,
				version: 4,
				status: "in-progress",
				parentId: parent.id,
				author: defaultUserId
			});
			expect(history[4]).toMatchObject({
				entityId: issue.id,
				version: 5,
				status: "in-progress",
				parentId: null,
				author: defaultUserId
			});
			expect(history[5]).toMatchObject({
				entityId: issue.id,
				version: 6,
				title: "Initial title",
				body: "Initial body.",
				status: "todo",
				parentId: null,
				author: defaultUserId
			});

			// IDs are real UUIDs from revision_entries — not fabricated ephemeral strings
			const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			expect(history.every((entry) => UUID_RE.test(entry.id))).toBe(true);
			// History is stable across repeated calls
			expect(await store.listEntityHistory(issue.id)).toEqual(history);
		} finally {
			await store.close();
		}
	});
});

	describe(`storage-driver seam: context revision history (${label})`, () => {
		it("creation establishes a revision-1 baseline with a correct content hash", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });

				expect(created.context.revision).toBe(1);
				expect(created.context.contentHash).toMatch(/^[0-9a-f]{64}$/);
				expect(created.context.exists).toBe(true);
				expect(created.context).not.toHaveProperty("summary");

				const direct = await store.getContextDetails();
				expect(direct.context.revision).toBe(1);
				expect(direct.context.contentHash).toBe(created.context.contentHash);
			} finally {
				await store.close();
			}
		});

		it("a matching update atomically advances to revision 2 and appends a reverse delta", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });
				expect(created.context.revision).toBe(1);

				const updated = await store.upsertContext({
					title: "Updated title",
					summary: "Updated summary",
					expectedRevision: created.context.revision,
					expectedContentHash: created.context.contentHash
				});

				expect(updated.context.revision).toBe(2);
				expect(updated.context.contentHash).not.toBe(created.context.contentHash);
				expect(updated.context.title).toBe("Updated title");
				expect(updated.context).not.toHaveProperty("summary");
				expect(updated.context.exists).toBe(true);
				expect((await store.getContextDetails()).context.summary).toBe("Updated summary");
			} finally {
				await store.close();
			}
		});

		it("a stale revision rejects with ContextConflictError and leaves head unchanged", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });
				const updated = await store.upsertContext({
					title: "Updated title",
					summary: "Updated summary",
					expectedRevision: created.context.revision,
					expectedContentHash: created.context.contentHash
				});
				expect(updated.context.revision).toBe(2);

				// Stale: still at revision 1
				let caughtError: unknown;
				try {
					await store.upsertContext({
						title: "Stale title",
						summary: "Stale summary",
						expectedRevision: created.context.revision,
						expectedContentHash: created.context.contentHash
					});
					expect.unreachable("Expected ContextConflictError to be thrown");
				} catch (err) {
					caughtError = err;
				}

				expect(caughtError).toBeInstanceOf(ContextConflictError);
				expect((caughtError as ContextConflictError).contextKey).toBeDefined();
				expect((caughtError as ContextConflictError).currentRevision).toBe(2);

				// Head unchanged after rejected write
				const head = await store.getContextDetails();
				expect(head.context.revision).toBe(2);
				expect(head.context.title).toBe("Updated title");
			} finally {
				await store.close();
			}
		});

		it("an existing context cannot be updated without its expected head", async () => {
			const store = await openStore();

			try {
				const created = await store.upsertContext({ title: "Initial title", summary: "Initial summary" });

				await expect(store.upsertContext({ title: "Unguarded title", summary: "Unguarded summary" })).rejects.toMatchObject({
					name: "ContextConflictError",
					currentRevision: created.context.revision,
					currentContentHash: created.context.contentHash
				});

				expect((await store.getContextDetails()).context).toMatchObject(created.context);
			} finally {
				await store.close();
			}
		});

		it("direct reads (list/search/getContextDetails) remain direct and do not require revision tracking", async () => {
			const store = await openStore();

			try {
				const initiative = await store.createEntity({ kind: "initiative", title: "Payments" });
				await store.upsertContext({ scopeRef: initiative.id, title: "Payments context", summary: "Payments glossary" });

				const details = await store.getContextDetails({ scopeRef: initiative.id });
				expect(details.context.revision).toBe(1);

				const list = await store.listContexts();
				const found = list.contexts.find((item) => item.context.scopeEntityId === initiative.id);
				expect(found?.context.revision).toBe(1);

				const directory = await store.getContextDirectory();
				const initiative_context = directory.initiatives.find((ctx) => ctx.context.scopeEntityId === initiative.id);
				expect(initiative_context?.context.revision).toBe(1);
			} finally {
				await store.close();
			}
		});

		it("author and timestamp are recorded on the delta and the context head preserves ordering", async () => {
			const store = await openStore();

			try {
				const r1 = await store.upsertContext({ title: "v1", summary: "s1", author: "alice" });
				const r2 = await store.upsertContext({
					title: "v2",
					summary: "s2",
					author: "bob",
					expectedRevision: r1.context.revision,
					expectedContentHash: r1.context.contentHash
				});

				expect(r2.context.revision).toBe(2);
				expect(r2.context.updatedAt).not.toBeNull();
				expect(r2.context.updatedAt! >= r1.context.updatedAt!).toBe(true);
			} finally {
				await store.close();
			}
		});

		it("materializes context revisions without changing the current head", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.upsertContext({ title: "First", summary: "First summary.", author: "alice" });
				const users = await store.listUsers();
				const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
					?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
					?? users[0]?.id;
				const revision2 = await store.upsertContext({ title: "Second", summary: "Second summary.", author: "bob", expectedRevision: revision1.context.revision, expectedContentHash: revision1.context.contentHash });
				await store.upsertContext({ title: "Third", summary: "Third summary.", author: "carol", expectedRevision: revision2.context.revision, expectedContentHash: revision2.context.contentHash });

				await expect(store.materializeContextRevision({ revision: 2 })).resolves.toEqual(expect.objectContaining({ contextKey: revision1.context.key, targetRevision: 2, headRevision: 3, title: "Second", summary: "Second summary.", author: defaultUserId }));
				await expect(store.materializeContextRevision({ revision: 1 })).resolves.toEqual(expect.objectContaining({ targetRevision: 1, headRevision: 3, title: "First", summary: "First summary.", author: defaultUserId }));
				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ context: expect.objectContaining({ revision: 3, title: "Third" }) }));
			} finally {
				await store.close();
			}
		});

		it("materializes context terms before and at their tombstone", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.defineContextTerm({ term: "Order", definition: "First definition.", author: "alice" });
				const users = await store.listUsers();
				const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
					?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
					?? users[0]?.id;
				const revision2 = await store.defineContextTerm({ term: "Order", definition: "Second definition.", avoid: ["purchase"], author: "bob", expectedRevision: revision1.term.revision, expectedContentHash: revision1.term.contentHash });
				await store.forgetContextTerm({ term: "Order", author: "carol", expectedRevision: revision2.term.revision, expectedContentHash: revision2.term.contentHash });

				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ terms: [] }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 1 })).resolves.toEqual(expect.objectContaining({ targetRevision: 1, headRevision: 3, definition: "First definition.", avoid: [], tombstone: false, author: defaultUserId }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 2 })).resolves.toEqual(expect.objectContaining({ targetRevision: 2, headRevision: 3, definition: "Second definition.", avoid: ["purchase"], tombstone: false, author: defaultUserId }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 3 })).resolves.toEqual(expect.objectContaining({ targetRevision: 3, headRevision: 3, tombstone: true, author: defaultUserId }));
			} finally {
				await store.close();
			}
		});

		it("restores context revisions as new heads without replacing newer history", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.upsertContext({ title: "First", summary: "First summary.", author: "alice" });
				const revision2 = await store.upsertContext({ title: "Second", summary: "Second summary.", author: "bob", expectedRevision: revision1.context.revision, expectedContentHash: revision1.context.contentHash });
				const revision3 = await store.upsertContext({ title: "Third", summary: "Third summary.", author: "carol", expectedRevision: revision2.context.revision, expectedContentHash: revision2.context.contentHash });
				const users = await store.listUsers();
				const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
					?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
					?? users[0]?.id;

				const restored = await store.restoreContextRevision({ revision: 1, author: "restorer", expectedRevision: revision3.context.revision, expectedContentHash: revision3.context.contentHash });
				expect(restored).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, title: "First", summary: "First summary.", author: defaultUserId, restoredFromRevision: 1 }));
				await expect(store.materializeContextRevision({ revision: 3 })).resolves.toEqual(expect.objectContaining({ title: "Third", restoredFromRevision: null }));
				await expect(store.restoreContextRevision({ revision: 2, expectedRevision: 3, expectedContentHash: revision3.context.contentHash })).rejects.toMatchObject({ name: "ContextConflictError", currentRevision: 4 });
			} finally {
				await store.close();
			}
		});

		it("restores removed context terms on their existing revision chain", async () => {
			const store = await openStore();

			try {
				const revision1 = await store.defineContextTerm({ term: "Order", definition: "First definition.", author: "alice" });
				const revision2 = await store.defineContextTerm({ term: "Order", definition: "Second definition.", avoid: ["purchase"], author: "bob", expectedRevision: revision1.term.revision, expectedContentHash: revision1.term.contentHash });
				const removed = await store.forgetContextTerm({ term: "Order", author: "carol", expectedRevision: revision2.term.revision, expectedContentHash: revision2.term.contentHash });
				const users = await store.listUsers();
				const defaultUserId = users.find((user) => user.authenticationSubject.startsWith("local:"))?.id
					?? users.find((user) => user.authenticationSubject === "agent-issues:system")?.id
					?? users[0]?.id;

				const restored = await store.restoreContextTermRevision({ term: "Order", revision: 1, author: "restorer", expectedRevision: removed.currentRevision!, expectedContentHash: removed.currentContentHash! });
				expect(restored).toEqual(expect.objectContaining({ targetRevision: 4, headRevision: 4, definition: "First definition.", avoid: [], tombstone: false, author: defaultUserId, restoredFromRevision: 1 }));
				await expect(store.getContextDetails()).resolves.toEqual(expect.objectContaining({ terms: [expect.objectContaining({ term: "Order", revision: 4 })] }));
				await expect(store.materializeContextTermRevision({ term: "Order", revision: 3 })).resolves.toEqual(expect.objectContaining({ tombstone: true, restoredFromRevision: null }));
				await expect(store.restoreContextTermRevision({ term: "Order", revision: 2, expectedRevision: 3, expectedContentHash: removed.currentContentHash! })).rejects.toMatchObject({ name: "ContextTermConflictError", currentRevision: 4 });
			} finally {
				await store.close();
			}
		});

		it("returns typed errors for missing records and invalid context revisions", async () => {
			const store = await openStore();

			try {
				await expect(store.materializeContextRevision({ revision: 1 })).rejects.toBeInstanceOf(ContextRevisionError);
				await store.upsertContext({ title: "Only", summary: "Only revision." });
				await expect(store.materializeContextRevision({ revision: 2 })).rejects.toMatchObject({ name: "ContextRevisionError", reason: "revision-out-of-range", headRevision: 1 });
				await expect(store.materializeContextTermRevision({ term: "Missing", revision: 1 })).rejects.toMatchObject({ name: "ContextRevisionError", reason: "term-not-found" });
			} finally {
				await store.close();
			}
		});
	});

	describe(`storage-driver seam: issue comments (${label})`, () => {
		it("does not attach another project's conversation to an issue detail", async () => {
			const projectA = await openStoreForProject("comment-project-a");
			const projectB = await openStoreForProject("comment-project-b");

			try {
				const issue = await projectA.createEntity({ kind: "issue", title: "Project A issue" });
				await projectA.createIssueComment({ issueId: issue.id, body: "Project A comment." });

				await expect(projectB.getEntityDetails(issue.reference)).rejects.toThrow(`Entity not found in current project "comment-project-b"`);
			} finally {
				await projectA.close();
				await projectB.close();
			}
		});

		it("does not list or add comments on another project's issue", async () => {
			const projectA = await openStoreForProject("comment-project-a");
			const projectB = await openStoreForProject("comment-project-b");

			try {
				const issue = await projectA.createEntity({ kind: "issue", title: "Project A issue" });
				await projectA.createIssueComment({ issueId: issue.id, body: "Project A comment." });

				await expect(projectB.listIssueComments({ issueId: issue.id })).rejects.toThrow(`Entity not found: ${issue.id}`);
				await expect(projectB.createIssueComment({ issueId: issue.id, body: "Project B comment." })).rejects.toThrow(`Entity not found: ${issue.id}`);
			} finally {
				await projectA.close();
				await projectB.close();
			}
		});

		it("does not delete another project's comment by ID or canonical reference", async () => {
			const projectA = await openStoreForProject("comment-project-a");
			const projectB = await openStoreForProject("comment-project-b");

			try {
				const issue = await projectA.createEntity({ kind: "issue", title: "Project A issue" });
				const comment = await projectA.createIssueComment({ issueId: issue.id, body: "Project A comment." });

				await expect(projectB.deleteIssueComment({ commentId: comment.id, expectedRevision: comment.revision, expectedContentHash: comment.contentHash })).rejects.toThrow(`Issue comment not found: ${comment.id}`);
				await expect(projectB.deleteIssueComment({ commentId: comment.reference, expectedRevision: comment.revision, expectedContentHash: comment.contentHash })).rejects.toThrow(`Issue comment not found: ${comment.reference}`);
			} finally {
				await projectA.close();
				await projectB.close();
			}
		});

		it("does not update another project's comment by ID or canonical reference", async () => {
			const projectA = await openStoreForProject("comment-project-a");
			const projectB = await openStoreForProject("comment-project-b");

			try {
				const issue = await projectA.createEntity({ kind: "issue", title: "Project A issue" });
				const comment = await projectA.createIssueComment({ issueId: issue.id, body: "Project A comment." });

				await expect(projectB.updateIssueComment({ commentId: comment.id, body: "Changed by Project B.", expectedRevision: comment.revision, expectedContentHash: comment.contentHash })).rejects.toThrow(`Issue comment not found: ${comment.id}`);
				await expect(projectB.updateIssueComment({ commentId: comment.reference, body: "Changed by Project B.", expectedRevision: comment.revision, expectedContentHash: comment.contentHash })).rejects.toThrow(`Issue comment not found: ${comment.reference}`);
			} finally {
				await projectA.close();
				await projectB.close();
			}
		});

		it("does not return another project's comment history by ID or canonical reference", async () => {
			const projectA = await openStoreForProject("comment-project-a");
			const projectB = await openStoreForProject("comment-project-b");

			try {
				const issue = await projectA.createEntity({ kind: "issue", title: "Project A issue" });
				const comment = await projectA.createIssueComment({ issueId: issue.id, body: "Project A comment." });

				await expect(projectB.listIssueCommentHistory({ commentId: comment.id })).resolves.toEqual([]);
				await expect(projectB.listIssueCommentHistory({ commentId: comment.reference })).resolves.toEqual([]);
			} finally {
				await projectA.close();
				await projectB.close();
			}
		});

		it("creates a comment on an issue and returns it from the conversation", async () => {
			const store = await openStore();

			try {
				const actor = { userId: "entra:comment-author", tenantId: store.tenantId, displayName: "Comment Author" };
				const actorStore = store.withAuthenticatedIdentity(actor);
				const issue = await actorStore.createEntity({ kind: "issue", title: "Commented issue" });
				const comment = await actorStore.createIssueComment({ issueId: issue.id, body: "First comment." });
				expect(comment.shortReference).toMatch(/^COM_[0-9A-HJKMNP-TV-Z]{6}$/);
				expect(comment).not.toHaveProperty("body");

				expect(await store.listIssueComments({ issueId: issue.id })).toEqual(
					expect.objectContaining({
						comments: [expect.objectContaining({ id: comment.id, issueId: issue.id, body: "First comment.", shortReference: comment.shortReference })],
						users: [expect.objectContaining({ id: comment.createdBy, authenticationSubject: actor.userId, displayName: actor.displayName })],
						total: 1,
						nextBefore: null
					})
				);
			} finally {
				await store.close();
			}
		});

		it("edits a comment and atomically replaces its referenced issues", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
				const firstReference = await store.createEntity({ kind: "issue", title: "First reference" });
				const secondReference = await store.createEntity({ kind: "issue", title: "Second reference" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Initial comment.", referencedIssueIds: [firstReference.id] });
				const updated = await store.updateIssueComment({
					commentId: comment.reference,
					body: "Updated comment.",
					referencedIssueIds: [secondReference.id],
					expectedRevision: comment.revision,
					expectedContentHash: comment.contentHash
				});

				expect(updated).toMatchObject({
					id: comment.id,
					body: "Updated comment.",
					referencedIssueIds: [secondReference.id],
					revision: 2
				});
				expect((await store.listIssueComments({ issueId: issue.id })).comments).toEqual([
					expect.objectContaining({ id: comment.id, referencedIssueIds: [secondReference.id] })
				]);
			} finally {
				await store.close();
			}
		});

		it("tombstones a deleted comment and retains its conversation placeholder", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Disposable comment." });
				const deleted = await store.deleteIssueComment({
					commentId: comment.id,
					expectedRevision: comment.revision,
					expectedContentHash: comment.contentHash
				});

				expect(deleted).toMatchObject({ id: comment.id, tombstone: true, revision: 2 });
				expect(deleted.body).toBeUndefined();
				const [placeholder] = (await store.listIssueComments({ issueId: issue.id })).comments;
				expect(placeholder).toMatchObject({ id: comment.id, tombstone: true });
				expect(placeholder).not.toHaveProperty("body");
			} finally {
				await store.close();
			}
		});

		it("returns immutable prior comment text from comment history", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Initial comment." });
				await store.updateIssueComment({ commentId: comment.id, body: "Updated comment.", expectedRevision: comment.revision, expectedContentHash: comment.contentHash });

				expect(await store.listIssueCommentHistory({ commentId: comment.reference })).toEqual([
					expect.objectContaining({ targetRevision: 1, headRevision: 2, body: "Initial comment." }),
					expect.objectContaining({ targetRevision: 2, headRevision: 2, body: "Updated comment." })
				]);
			} finally {
				await store.close();
			}
		});

		it("includes the newest comment page in an issue detail read", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Visible in issue detail." });

				expect((await store.getEntityDetails(issue.reference)).comments).toEqual(
					expect.objectContaining({
						comments: [expect.objectContaining({ id: comment.id, body: "Visible in issue detail." })],
						total: 1,
						nextBefore: null
					})
				);
			} finally {
				await store.close();
			}
		});

		it("returns a bounded newest comment page with an older-page cursor", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Long conversation" });
				for (let index = 0; index < 51; index++) {
					await store.createIssueComment({ issueId: issue.id, body: `Comment ${index}.` });
				}

				const page = await store.listIssueComments({ issueId: issue.id });
				const detail = await store.getEntityDetails(issue.id);
				expect(page).toMatchObject({ total: 51, comments: expect.any(Array) });
				expect(page.comments).toHaveLength(50);
				expect(page.nextBefore).toEqual(expect.any(String));
				expect(detail.comments).toEqual(expect.objectContaining({ total: 51, comments: expect.any(Array), nextBefore: page.nextBefore }));
				expect(detail.comments?.comments).toHaveLength(50);

				const olderPage = await store.listIssueComments({ issueId: issue.id, before: page.nextBefore! });
				expect(olderPage).toMatchObject({ total: 51, nextBefore: null });
				expect(olderPage.comments).toHaveLength(1);
			} finally {
				await store.close();
			}
		});

		it("rejects a stale comment edit without overwriting the current comment", async () => {
			const store = await openStore();

			try {
				const issue = await store.createEntity({ kind: "issue", title: "Commented issue" });
				const comment = await store.createIssueComment({ issueId: issue.id, body: "Initial comment." });
				const updated = await store.updateIssueComment({ commentId: comment.id, body: "Current comment.", expectedRevision: comment.revision, expectedContentHash: comment.contentHash });

				await expect(store.updateIssueComment({
					commentId: comment.id,
					body: "Stale comment.",
					expectedRevision: comment.revision,
					expectedContentHash: comment.contentHash
				})).rejects.toThrow(IssueCommentConflictError);
				expect((await store.listIssueComments({ issueId: issue.id })).comments).toEqual([
					expect.objectContaining({ id: comment.id, body: "Current comment.", revision: updated.revision })
				]);
			} finally {
				await store.close();
			}
		});
	});
}