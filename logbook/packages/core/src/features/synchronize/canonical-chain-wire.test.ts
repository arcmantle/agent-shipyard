import { describe, expect, it } from "vitest";

import { computeEntityContentHash } from "../entity-store/domain.js";
import {
	decodeCanonicalChainBundle,
	encodeCanonicalChainBundle,
	type CanonicalChainBundle,
	type CanonicalEntityChain,
	type CanonicalIssueCommentChain,
	type CanonicalPlanEntryChain
} from "./canonical-chain.js";
import { encodeCanonicalReference } from "../entity-store/canonical-reference.js";
import { computeIssueCommentContentHash } from "../issue-comment/issue-comment-types.js";
import { computePlanEntryContentHash } from "../plan-entry/plan-entry-types.js";
import { createReverseFieldPatch, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, PLAN_ENTRY_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";

const ISSUE_ID = "00000000-0000-4000-8000-000000000001";
const ISSUE_COMMENT_ID = "00000000-0000-4000-8000-000000000002";
const PLAN_ID = "00000000-0000-4000-8000-000000000003";
const PLAN_ENTRY_ID = "00000000-0000-4000-8000-000000000004";
const INITIATIVE_ID = "00000000-0000-4000-8000-000000000005";

function issueChain(): CanonicalEntityChain {
	return {
		head: {
			id: ISSUE_ID,
			reference: encodeCanonicalReference("issue", ISSUE_ID),
			createdBy: "user",
			updatedBy: "user",
			kind: "issue",
			title: "Issue",
			body: "Body",
			bodySource: "authored",
			category: null,
			priority: null,
			type: null,
			status: "todo",
			parentId: null,
			tombstone: false,
			revision: 1,
			contentHash: computeEntityContentHash("Issue", "Body"),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z"
		},
		deltas: []
	};
}

function issueCommentChain(): CanonicalIssueCommentChain {
	const predecessor = { body: "Initial comment.", referencedIssueIds: [], tombstone: false };
	const state = { body: "Updated comment.", referencedIssueIds: [ISSUE_ID], tombstone: false };
	return {
		head: {
			id: ISSUE_COMMENT_ID,
			reference: encodeCanonicalReference("issueComment", ISSUE_COMMENT_ID),
			issueId: ISSUE_ID,
			createdBy: "user",
			updatedBy: "user",
			...state,
			revision: 2,
			contentHash: computeIssueCommentContentHash(state.body, state.referencedIssueIds, state.tombstone),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z"
		},
		deltas: [{
			id: "issue-comment-delta-2",
			revision: 2,
			author: "user",
			createdAt: "2026-01-02T00:00:00.000Z",
			...createReverseFieldPatch(state, predecessor, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY)
		}]
	};
}

function planChain(): CanonicalEntityChain {
	return {
		head: {
			id: PLAN_ID,
			reference: encodeCanonicalReference("plan", PLAN_ID),
			createdBy: "user",
			updatedBy: "user",
			kind: "plan",
			title: "Plan",
			body: "Goal and Context",
			bodySource: "authored",
			category: null,
			priority: null,
			type: null,
			status: "in-progress",
			parentId: INITIATIVE_ID,
			tombstone: false,
			revision: 1,
			contentHash: computeEntityContentHash("Plan", "Goal and Context"),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z"
		},
		deltas: []
	};
}

function initiativeChain(): CanonicalEntityChain {
	const initiative = issueChain();
	return {
		...initiative,
		head: {
			...initiative.head,
			id: INITIATIVE_ID,
			reference: encodeCanonicalReference("initiative", INITIATIVE_ID),
			kind: "initiative",
			title: "Initiative",
			contentHash: computeEntityContentHash("Initiative", "Body")
		}
	};
}

function planEntryChain(): CanonicalPlanEntryChain {
	const predecessor = { role: "question" as const, body: "Initial question.", scopeDirection: null, referencedEntityIds: [], supersededEntryIds: [], tombstone: false };
	const state = { ...predecessor, body: "Updated question.", referencedEntityIds: [ISSUE_ID] };
	return {
		head: {
			id: PLAN_ENTRY_ID,
			reference: encodeCanonicalReference("planEntry", PLAN_ENTRY_ID),
			planId: PLAN_ID,
			createdBy: "user",
			updatedBy: "user",
			...state,
			revision: 2,
			contentHash: computePlanEntryContentHash(state),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z"
		},
		deltas: [{
			id: "plan-entry-delta-2",
			revision: 2,
			author: "user",
			createdAt: "2026-01-02T00:00:00.000Z",
			...createReverseFieldPatch(state, predecessor, PLAN_ENTRY_REVERSE_PATCH_REGISTRY)
		}]
	};
}

function bundleWithIssue(): CanonicalChainBundle {
	return { entities: [initiativeChain(), issueChain(), planChain()], contexts: [], contextTerms: [], issueComments: [], planEntries: [], users: [] };
}

describe("canonical chain wire encoding", () => {
	it("round-trips reverse patches through explicit base64 strings", () => {
		const bundle = {
			...bundleWithIssue(),
			entities: [{ ...issueChain(), deltas: [{ id: "entity-delta-1", revision: 1, author: "user", createdAt: "2026-01-01T00:00:00.000Z", patchFormat: 1, reversePatch: Uint8Array.from([0, 127, 128, 255]), sourceHash: "01".repeat(32), targetHash: "fe".repeat(32) }]}]
		};

		const encoded = encodeCanonicalChainBundle(bundle);

		expect(encoded.entities[0]?.deltas[0]?.reversePatch).toBe("AH+A/w==");
		expect(encoded.entities[0]?.deltas[0]?.sourceHash).toBe("01".repeat(32));
		expect(encoded.entities[0]?.deltas[0]?.targetHash).toBe("fe".repeat(32));
		expect(JSON.stringify(encoded)).not.toContain('"0":');
		const decoded = decodeCanonicalChainBundle(encoded).entities[0]?.deltas[0];
		expect(decoded?.reversePatch).toEqual(Uint8Array.from([0, 127, 128, 255]));
		expect(decoded?.sourceHash).toBe("01".repeat(32));
		expect(decoded?.targetHash).toBe("fe".repeat(32));
	});

	it("round-trips issue comment reverse patches through base64 strings", () => {
		const bundle = { ...bundleWithIssue(), issueComments: [issueCommentChain()] };

		const encoded = encodeCanonicalChainBundle(bundle);
		const sourcePatch = bundle.issueComments[0]!.deltas[0]!.reversePatch;
		const encodedPatch = encoded.issueComments[0]!.deltas[0]!.reversePatch;
		const decodedPatch = decodeCanonicalChainBundle(encoded).issueComments[0]!.deltas[0]!.reversePatch;

		expect(encodedPatch).toBe(Buffer.from(sourcePatch).toString("base64"));
		expect(decodedPatch).toEqual(sourcePatch);
	});

	it("round-trips Plan entry reverse patches through base64 strings", () => {
		const bundle = { ...bundleWithIssue(), planEntries: [planEntryChain()] };

		const encoded = encodeCanonicalChainBundle(bundle);
		const sourcePatch = bundle.planEntries[0]!.deltas[0]!.reversePatch;
		const encodedPatch = encoded.planEntries[0]!.deltas[0]!.reversePatch;
		const decodedPatch = decodeCanonicalChainBundle(encoded).planEntries[0]!.deltas[0]!.reversePatch;

		expect(encodedPatch).toBe(Buffer.from(sourcePatch).toString("base64"));
		expect(decodedPatch).toEqual(sourcePatch);
	});

	it("round-trips completion observations", () => {
		const completionObservations = [{
			id: "00000000-0000-4000-8000-000000000006",
			issueId: ISSUE_ID,
			completionOrdinal: 1,
			repositoryIdentity: "a".repeat(64),
			commitSha: "b".repeat(40),
			branch: "main",
			dirty: false,
			capturedAt: "2026-01-02T00:00:00.000Z",
			calculatedVersionState: "available" as const,
			calculatedVersion: "1.2.3",
			diagnostics: []
		}];

		const decoded = decodeCanonicalChainBundle(encodeCanonicalChainBundle({ ...bundleWithIssue(), completionObservations }));

		expect(decoded.completionObservations).toEqual(completionObservations);
	});

	it("decodes a wire bundle with a parentless legacy Plan", () => {
		const plan = planChain();
		plan.head.parentId = null;
		const bundle = encodeCanonicalChainBundle({ ...bundleWithIssue(), entities: [plan] });

		expect(decodeCanonicalChainBundle(bundle).entities).toEqual([plan]);
	});

	it("rejects a wire bundle with an issue-owned Plan", () => {
		const plan = planChain();
		plan.head.parentId = ISSUE_ID;
		const bundle = encodeCanonicalChainBundle({ ...bundleWithIssue(), entities: [issueChain(), plan] });

		expect(() => decodeCanonicalChainBundle(bundle)).toThrow("initiative parent");
	});

	it("rejects a canonical reference that does not encode id", () => {
		const bundle = encodeCanonicalChainBundle({
			...bundleWithIssue(),
			entities: [{ ...issueChain(), head: { ...issueChain().head, id: ISSUE_COMMENT_ID } }]
		});

		expect(() => decodeCanonicalChainBundle(bundle)).toThrow(/does not match issue Stable identity/);
	});
});