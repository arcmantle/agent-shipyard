import { describe, expect, it } from "vitest";

import { computeContextTermContentHash } from "../context/context-types.js";
import { computeIssueCommentContentHash } from "../issue-comment/issue-comment-types.js";
import { computePlanEntryContentHash } from "../plan-entry/plan-entry-types.js";
import { computeEntityContentHash } from "../entity-store/domain.js";
import { encodeCanonicalReference } from "../entity-store/canonical-reference.js";
import { deriveUserIdentity } from "../user-directory/user-directory.js";
import { CONTEXT_TERM_REVERSE_PATCH_REGISTRY, createReverseFieldPatch, ENTITY_REVERSE_PATCH_REGISTRY, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, PLAN_ENTRY_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";
import { mergeCanonicalChainBundles, SynchronizeConflictError, type CanonicalChainBundle, type CanonicalContextChain, type CanonicalContextTermChain, type CanonicalEntityChain, type CanonicalIssueCommentChain, type CanonicalPlanEntryChain } from "./canonical-chain.js";

const emptyBundle = (): CanonicalChainBundle => ({ entities: [], contexts: [], contextTerms: [], issueComments: [], planEntries: [], users: [] });
const ENTITY_STABLE_ID = "00000000-0000-4000-8000-000000000001";
const ENTITY_REFERENCE = encodeCanonicalReference("issue", ENTITY_STABLE_ID);
const ISSUE_COMMENT_STABLE_ID = "00000000-0000-4000-8000-000000000002";
const PLAN_STABLE_ID = "00000000-0000-4000-8000-000000000003";
const PLAN_ENTRY_STABLE_ID = "00000000-0000-4000-8000-000000000004";
const INITIATIVE_STABLE_ID = "00000000-0000-4000-8000-000000000005";

function entityChain(title: string, revision: number, predecessorTitles: string[] = []): CanonicalEntityChain {
	const titles = [...predecessorTitles, title];
	const state = (stateTitle: string) => ({ title: stateTitle, body: "body", bodySource: "authored" as const, category: null, priority: null, type: null, status: "todo", parentId: null, tombstone: false });
	const deltas = predecessorTitles.map((predecessorTitle, index) => {
		const deltaRevision = index + 2;
		return {
			id: `delta-${deltaRevision}-${predecessorTitle}`,
			revision: deltaRevision,
			author: "author",
			createdAt: `2026-01-0${deltaRevision}T00:00:00.000Z`,
			...createReverseFieldPatch(state(titles[index + 1]), state(predecessorTitle), ENTITY_REVERSE_PATCH_REGISTRY)
		};
	});
	return {
		head: {
			id: ENTITY_STABLE_ID,
			reference: ENTITY_REFERENCE,
			createdBy: "user",
			updatedBy: "user",
			kind: "issue",
			title,
			body: "body",
			bodySource: "authored",
			category: null,
			priority: null,
			type: null,
			status: "todo",
			parentId: null,
			tombstone: false,
			revision,
			contentHash: computeEntityContentHash(title, "body"),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas
	};
}

function initiativeChain(): CanonicalEntityChain {
	const initiative = entityChain("Initiative", 1);
	initiative.head.id = INITIATIVE_STABLE_ID;
	initiative.head.reference = encodeCanonicalReference("initiative", INITIATIVE_STABLE_ID);
	initiative.head.kind = "initiative";
	return initiative;
}

function contextTermChain(term: string, revision: number, predecessorTerm?: string): CanonicalContextTermChain {
	const stableId = "018f0000-0000-4000-8000-000000000001";
	const state = (stateTerm: string) => ({ term: stateTerm, definition: "A confirmed purchase.", avoid: ["request"], tombstone: false });
	return {
		head: {
			id: stableId,
			reference: encodeCanonicalReference("contextTerm", stableId),
			createdBy: "user",
			updatedBy: "user",
			contextKey: "default",
			...state(term),
			revision,
			contentHash: computeContextTermContentHash(term, "A confirmed purchase.", ["request"], false),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas: predecessorTerm === undefined ? [] : [{
			id: "rename-delta",
			revision,
			author: "alice",
			createdAt: `2026-01-0${revision}T00:00:00.000Z`,
			...createReverseFieldPatch(state(term), state(predecessorTerm), CONTEXT_TERM_REVERSE_PATCH_REGISTRY)
		}]
	};
}

function contextChain(key: string, stableId = "00000000-0000-4000-8000-000000000010"): CanonicalContextChain {
	return {
		head: {
			id: stableId,
			reference: encodeCanonicalReference("context", stableId),
			createdBy: "user",
			updatedBy: "user",
			key,
			scopeEntityId: null,
			title: "Context",
			summary: "Summary",
			revision: 1,
			contentHash: "hash",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z"
		},
		deltas: []
	};
}

function issueCommentChain(body: string, referencedIssueIds: string[], revision: number, predecessor?: { body: string; referencedIssueIds: string[]; tombstone: boolean }): CanonicalIssueCommentChain {
	const state = { body, referencedIssueIds, tombstone: false };
	return {
		head: {
			id: ISSUE_COMMENT_STABLE_ID,
			reference: encodeCanonicalReference("issueComment", ISSUE_COMMENT_STABLE_ID),
			issueId: ENTITY_STABLE_ID,
			createdBy: "user",
			updatedBy: "user",
			...state,
			revision,
			contentHash: computeIssueCommentContentHash(body, referencedIssueIds, false),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas: predecessor === undefined ? [] : [{
			id: `issue-comment-delta-${revision}`,
			revision,
			author: "user",
			createdAt: `2026-01-0${revision}T00:00:00.000Z`,
			...createReverseFieldPatch(state, predecessor, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY)
		}]
	};
}

function planEntryChain(body: string, referencedEntityIds: string[], revision: number, predecessor?: { body: string; referencedEntityIds: string[] }): CanonicalPlanEntryChain {
	const state = { role: "question" as const, body, scopeDirection: null, referencedEntityIds, supersededEntryIds: [], tombstone: false };
	return {
		head: {
			id: PLAN_ENTRY_STABLE_ID,
			reference: encodeCanonicalReference("planEntry", PLAN_ENTRY_STABLE_ID),
			planId: PLAN_STABLE_ID,
			createdBy: "user",
			updatedBy: "user",
			...state,
			revision,
			contentHash: computePlanEntryContentHash(state),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: `2026-01-0${revision}T00:00:00.000Z`
		},
		deltas: predecessor === undefined ? [] : [{
			id: `plan-entry-delta-${revision}`,
			revision,
			author: "user",
			createdAt: `2026-01-0${revision}T00:00:00.000Z`,
			...createReverseFieldPatch(state, { ...state, ...predecessor }, PLAN_ENTRY_REVERSE_PATCH_REGISTRY)
		}]
	};
}

describe("mergeCanonicalChainBundles", () => {
	it("rejects a Pioneer ticket without a Pioneer map parent", () => {
		const ticket = entityChain("Ticket", 1);
		ticket.head.type = "pioneer-ticket";

		expect(() => mergeCanonicalChainBundles(emptyBundle(), { ...emptyBundle(), entities: [ticket] })).toThrow("pioneer-ticket");
	});

	it("preserves a parentless legacy Plan", () => {
		const plan = entityChain("Plan", 1);
		plan.head.id = PLAN_STABLE_ID;
		plan.head.reference = encodeCanonicalReference("plan", PLAN_STABLE_ID);
		plan.head.kind = "plan";

		expect(mergeCanonicalChainBundles(emptyBundle(), { ...emptyBundle(), entities: [plan] }).entities).toEqual([plan]);
	});

	it("rejects a Plan under a non-Initiative parent", () => {
		const plan = entityChain("Plan", 1);
		plan.head.id = PLAN_STABLE_ID;
		plan.head.reference = encodeCanonicalReference("plan", PLAN_STABLE_ID);
		plan.head.kind = "plan";
		plan.head.parentId = ENTITY_STABLE_ID;

		expect(() => mergeCanonicalChainBundles(emptyBundle(), { ...emptyBundle(), entities: [entityChain("Issue parent", 1), plan] })).toThrow("initiative parent");
	});

	it("merges user directories by newest non-empty display name", () => {
		const identity = deriveUserIdentity("entra:alice");
		const original = { ...identity, displayName: "Alice", updatedAt: "2026-08-07T10:00:00.000Z" };
		const renamed = { ...identity, displayName: "Alicia", updatedAt: "2026-08-07T11:00:00.000Z" };

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), users: [original] },
			{ ...emptyBundle(), users: [renamed] }
		).users).toEqual([renamed]);
	});

	it("merges a renamed context term as one stable-ID chain", () => {
		const original = contextTermChain("Order", 1);
		const renamed = contextTermChain("Purchase", 2, "Order");

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), contextTerms: [original] },
			{ ...emptyBundle(), contextTerms: [renamed] }
		).contextTerms).toEqual([renamed]);
	});

	it("merges a comment body and referenced issue IDs as one compatible extension", () => {
		const issue = entityChain("Issue", 1);
		const original = issueCommentChain("Initial", [], 1);
		const updated = issueCommentChain("Updated", [ENTITY_STABLE_ID], 2, { body: "Initial", referencedIssueIds: [], tombstone: false });

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [issue], issueComments: [original] },
			{ ...emptyBundle(), entities: [issue], issueComments: [updated] }
		).issueComments).toEqual([updated]);
	});

	it("merges a Plan entry body and ordered entity references as one compatible extension", () => {
		const initiative = initiativeChain();
		const plan = entityChain("Plan", 1);
		plan.head.id = PLAN_STABLE_ID;
		plan.head.reference = encodeCanonicalReference("plan", PLAN_STABLE_ID);
		plan.head.kind = "plan";
		plan.head.parentId = initiative.head.id;
		const referencedEntity = entityChain("Referenced entity", 1);
		const original = planEntryChain("Initial question", [], 1);
		const updated = planEntryChain("Updated question", [ENTITY_STABLE_ID], 2, { body: "Initial question", referencedEntityIds: [] });

		expect(mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [initiative, plan, referencedEntity], planEntries: [original] },
			{ ...emptyBundle(), entities: [initiative, plan, referencedEntity], planEntries: [updated] }
		).planEntries).toEqual([updated]);
	});

	it("accepts a decision that supersedes a prior decision", () => {
		const initiative = initiativeChain();
		const plan = entityChain("Plan", 1);
		plan.head.id = PLAN_STABLE_ID;
		plan.head.reference = encodeCanonicalReference("plan", PLAN_STABLE_ID);
		plan.head.kind = "plan";
		plan.head.parentId = initiative.head.id;
		const initialDecision = planEntryChain("Initial decision", [], 1);
		initialDecision.head.role = "decision";
		initialDecision.head.contentHash = computePlanEntryContentHash({
			role: initialDecision.head.role,
			body: initialDecision.head.body,
			scopeDirection: initialDecision.head.scopeDirection,
			referencedEntityIds: initialDecision.head.referencedEntityIds,
			supersededEntryIds: initialDecision.head.supersededEntryIds,
			tombstone: initialDecision.head.tombstone
		});
		const replacement = planEntryChain("Replacement decision", [], 1);
		replacement.head.id = "00000000-0000-4000-8000-000000000006";
		replacement.head.reference = encodeCanonicalReference("planEntry", replacement.head.id);
		replacement.head.role = "decision";
		replacement.head.supersededEntryIds = [initialDecision.head.id];
		replacement.head.contentHash = computePlanEntryContentHash({
			role: replacement.head.role,
			body: replacement.head.body,
			scopeDirection: replacement.head.scopeDirection,
			referencedEntityIds: replacement.head.referencedEntityIds,
			supersededEntryIds: replacement.head.supersededEntryIds,
			tombstone: replacement.head.tombstone
		});

		expect(mergeCanonicalChainBundles(
			emptyBundle(),
			{ ...emptyBundle(), entities: [initiative, plan], planEntries: [initialDecision, replacement] }
		).planEntries).toEqual([initialDecision, replacement]);
	});

	it("rejects divergent Plan entry heads with Plan-entry conflict metadata", () => {
		const initiative = initiativeChain();
		const plan = entityChain("Plan", 1);
		plan.head.id = PLAN_STABLE_ID;
		plan.head.reference = encodeCanonicalReference("plan", PLAN_STABLE_ID);
		plan.head.kind = "plan";
		plan.head.parentId = initiative.head.id;
		const local = planEntryChain("Local answer", [], 2, { body: "Initial question", referencedEntityIds: [] });
		const cloud = planEntryChain("Cloud answer", [], 2, { body: "Initial question", referencedEntityIds: [] });

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [initiative, plan], planEntries: [local] },
			{ ...emptyBundle(), entities: [initiative, plan], planEntries: [cloud] }
		)).toThrow(SynchronizeConflictError);
		try {
			mergeCanonicalChainBundles(
				{ ...emptyBundle(), entities: [initiative, plan], planEntries: [local] },
				{ ...emptyBundle(), entities: [initiative, plan], planEntries: [cloud] }
			);
		} catch (error) {
			expect(error).toMatchObject({ recordKind: "plan-entry", recordId: PLAN_ENTRY_STABLE_ID, currentRevision: 2, currentContentHash: local.head.contentHash });
		}
	});

	it("keeps identical heads as a no-op", () => {
		const chain = entityChain("Initial", 1);
		const left = { ...emptyBundle(), entities: [chain] };
		const baselineState = { title: chain.head.title, body: chain.head.body, bodySource: chain.head.bodySource, category: chain.head.category, priority: chain.head.priority, type: chain.head.type, status: chain.head.status, parentId: chain.head.parentId, tombstone: chain.head.tombstone };
		const right = { ...emptyBundle(), entities: [{ ...chain, deltas: [{ id: "different-baseline", revision: 1, author: "other", createdAt: chain.head.createdAt, ...createReverseFieldPatch(baselineState, baselineState, ENTITY_REVERSE_PATCH_REGISTRY) }] }] };

		expect(mergeCanonicalChainBundles(left, right)).toEqual(left);
	});

	it("rejects a completion observation ID with different immutable facts", () => {
		const issue = entityChain("Observed issue", 1);
		const observation = {
			id: "00000000-0000-4000-8000-000000000006",
			issueId: issue.head.id,
			completionOrdinal: 1,
			repositoryIdentity: "a".repeat(64),
			commitSha: "b".repeat(40),
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersionState: "available" as const,
			calculatedVersion: "1.2.3",
			diagnostics: []
		};

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [issue], completionObservations: [observation] },
			{ ...emptyBundle(), entities: [issue], completionObservations: [{ ...observation, branch: "release" }] }
		)).toThrow(expect.objectContaining({ name: "CompletionObservationConflictError", observationId: observation.id }));
	});

	it("deduplicates identical observations and retains later completion ordinals", () => {
		const issue = entityChain("Re-completed issue", 1);
		const firstObservation = {
			id: "00000000-0000-4000-8000-000000000006",
			issueId: issue.head.id,
			completionOrdinal: 1,
			repositoryIdentity: null,
			commitSha: null,
			branch: null,
			dirty: null,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersionState: "unknown" as const,
			calculatedVersion: null,
			diagnostics: [{ code: "workspace-observation-failed", message: "No repository is available." }]
		};
		const secondObservation = { ...firstObservation, id: "00000000-0000-4000-8000-000000000007", completionOrdinal: 2 };

		const merged = mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [issue], completionObservations: [firstObservation] },
			{ ...emptyBundle(), entities: [issue], completionObservations: [secondObservation, firstObservation] }
		);

		expect(merged.completionObservations).toEqual([firstObservation, secondObservation]);
	});

	it("classifies duplicate canonical references before mutation", () => {
		const left = entityChain("Local", 1);
		const right = entityChain("Cloud", 1);
		right.head.id = "00000000-0000-4000-8000-000000000002";

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), entities: [left] },
			{ ...emptyBundle(), entities: [right] }
		)).toThrow(`Synchronization preflight canonical-reference collision: ${ENTITY_REFERENCE}.`);
	});

	it("classifies duplicate context keys before mutation", () => {
		const left = contextChain("default");
		const right = contextChain("default", "00000000-0000-4000-8000-000000000011");

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), contexts: [left] },
			{ ...emptyBundle(), contexts: [right] }
		)).toThrow("Synchronization preflight context-key collision: default.");
	});

	it("classifies duplicate term names before mutation", () => {
		const left = contextTermChain("Order", 1);
		const right = contextTermChain("order", 1);
		right.head.id = "018f0000-0000-4000-8000-000000000002";
		right.head.reference = encodeCanonicalReference("contextTerm", right.head.id);

		expect(() => mergeCanonicalChainBundles(
			{ ...emptyBundle(), contextTerms: [left] },
			{ ...emptyBundle(), contextTerms: [right] }
		)).toThrow(/Synchronization preflight term-name collision/);
	});

	it("selects a strict compatible extension regardless of source direction", () => {
		const revision1 = entityChain("Initial", 1);
		const revision2 = entityChain("Updated", 2, ["Initial"]);

		expect(mergeCanonicalChainBundles({ ...emptyBundle(), entities: [revision1] }, { ...emptyBundle(), entities: [revision2] }).entities).toEqual([revision2]);
		expect(mergeCanonicalChainBundles({ ...emptyBundle(), entities: [revision2] }, { ...emptyBundle(), entities: [revision1] }).entities).toEqual([revision2]);
	});

	it("rejects divergent heads with current revision metadata", () => {
		const left = entityChain("Local", 2, ["Initial"]);
		const right = entityChain("Cloud", 2, ["Initial"]);

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] })).toThrow(SynchronizeConflictError);
		try {
			mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] });
		} catch (error) {
			expect(error).toMatchObject({ recordKind: "entity", recordId: ENTITY_STABLE_ID, currentRevision: 2, currentContentHash: left.head.contentHash });
		}
	});

	it("rejects equal revision and content hash when lifecycle facts diverge", () => {
		const left = entityChain("Same content", 1);
		const right = { ...entityChain("Same content", 1), head: { ...entityChain("Same content", 1).head, status: "in-progress" } };

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [left] }, { ...emptyBundle(), entities: [right] })).toThrow(SynchronizeConflictError);
	});

	it("rejects a higher revision that does not descend from the lower head", () => {
		const lower = entityChain("Expected ancestor", 1);
		const incompatibleHigher = entityChain("Current", 2, ["Different ancestor"]);

		expect(() => mergeCanonicalChainBundles({ ...emptyBundle(), entities: [lower] }, { ...emptyBundle(), entities: [incompatibleHigher] })).toThrow(SynchronizeConflictError);
	});
});