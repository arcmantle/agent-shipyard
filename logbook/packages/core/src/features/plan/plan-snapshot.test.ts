import { describe, expect, it } from "vitest";

import type { EntityRecord } from "../entity-store/domain.js";
import type { PlanEntryRecord } from "../plan-entry/plan-entry-types.js";
import { projectProposedPlan } from "./plan-snapshot.js";

function plan(overrides: Partial<EntityRecord> = {}): EntityRecord {
	return {
		id: "plan-id",
		reference: "PLAN_123",
		shortReference: "PLAN_123",
		createdBy: "user-id",
		updatedBy: "user-id",
		kind: "plan",
		title: "Plan Preview",
		status: "in-progress",
		body: "## Goal\n\nReview the Plan.\n\n## Context\n\nUse an MCP App.",
		bodySource: "authored",
		category: null,
		priority: null,
		type: null,
		revision: 3,
		contentHash: "plan-content-hash",
		createdAt: "2026-09-04T10:00:00.000Z",
		updatedAt: "2026-09-04T10:00:00.000Z",
		...overrides
	};
}

function entry(overrides: Partial<PlanEntryRecord> = {}): PlanEntryRecord {
	return {
		id: "entry-id",
		reference: "PLAN_ENTRY_123",
		shortReference: "PLAN_ENTRY_123",
		planId: "plan-id",
		createdBy: "user-id",
		updatedBy: "user-id",
		role: "decision",
		body: "Use the MCP Apps contract.",
		scopeDirection: null,
		referencedEntityIds: [],
		supersededEntryIds: [],
		tombstone: false,
		revision: 2,
		contentHash: "entry-content-hash",
		createdAt: "2026-09-04T10:01:00.000Z",
		updatedAt: "2026-09-04T10:01:00.000Z",
		...overrides
	};
}

describe("Proposed Plan projection", () => {
	it("projects the displayed Plan content and deterministic snapshot digest", () => {
		const proposedPlan = projectProposedPlan(plan(), [entry()]);

		expect(proposedPlan).toMatchObject({
			reference: "PLAN_123",
			title: "Plan Preview",
			goal: "Review the Plan.",
			context: "Use an MCP App.",
			current: [{ key: "decisions", entries: [{ reference: "PLAN_ENTRY_123", body: "Use the MCP Apps contract." }] }]
		});
		expect(proposedPlan.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("keeps the digest stable when status and metadata change", () => {
		const initial = projectProposedPlan(plan(), [entry()]);
		const changedMetadata = projectProposedPlan(
			{ ...plan(), status: "ready", revision: 4, updatedAt: "2026-09-04T11:00:00.000Z" },
			[{ ...entry(), revision: 3, updatedAt: "2026-09-04T11:00:00.000Z" }]
		);

		expect(changedMetadata.snapshotDigest).toBe(initial.snapshotDigest);
	});

	it("changes the digest when displayed Plan content changes", () => {
		const initial = projectProposedPlan(plan(), [entry({ role: "scope", scopeDirection: "included" })]);
		const changedPlans = [
			projectProposedPlan(plan({ reference: "PLAN_456" }), [entry({ role: "scope", scopeDirection: "included" })]),
			projectProposedPlan(plan({ title: "Changed title" }), [entry({ role: "scope", scopeDirection: "included" })]),
			projectProposedPlan(plan({ body: "## Goal\n\nChanged goal.\n\n## Context\n\nUse an MCP App." }), [entry({ role: "scope", scopeDirection: "included" })]),
			projectProposedPlan(plan({ body: "## Goal\n\nReview the Plan.\n\n## Context\n\nChanged context." }), [entry({ role: "scope", scopeDirection: "included" })]),
			projectProposedPlan(plan(), [entry({ role: "decision" })]),
			projectProposedPlan(plan(), [entry({ role: "scope", scopeDirection: "excluded" })]),
			projectProposedPlan(plan(), [entry({ role: "scope", scopeDirection: "included", body: "Changed entry." })])
		];

		for (const changedPlan of changedPlans) {
			expect(changedPlan.snapshotDigest).not.toBe(initial.snapshotDigest);
		}
	});

	it("projects ordered active entries and identifies active questions", () => {
		const question = entry({ id: "question", reference: "PLAN_ENTRY_QUESTION", role: "question", body: "Which host?", createdAt: "2026-09-04T10:02:00.000Z" });
		const proposedPlan = projectProposedPlan(plan(), [
			entry({ id: "later", reference: "PLAN_ENTRY_LATER", body: "Later decision.", createdAt: "2026-09-04T10:04:00.000Z" }),
			entry({ id: "replacement", reference: "PLAN_ENTRY_REPLACEMENT", body: "Replacement decision.", supersededEntryIds: [question.id], createdAt: "2026-09-04T10:03:00.000Z" }),
			entry({ id: "deleted", reference: "PLAN_ENTRY_DELETED", role: "question", body: "Deleted question.", tombstone: true, createdAt: "2026-09-04T10:01:00.000Z" }),
			question,
			entry({ id: "active-question", reference: "PLAN_ENTRY_ACTIVE_QUESTION", role: "question", body: "Open question.", createdAt: "2026-09-04T10:00:00.000Z" })
		]);

		expect(proposedPlan.current.map((group) => [group.key, group.entries.map((item) => item.id)])).toEqual([
			["questions", ["active-question"]],
			["decisions", ["replacement", "later"]]
		]);
		expect(proposedPlan.hasActiveQuestions).toBe(true);
	});

	it("changes the digest when active entry order changes", () => {
		const first = entry({ id: "first", reference: "PLAN_ENTRY_A", body: "First entry.", createdAt: "2026-09-04T10:00:00.000Z" });
		const second = entry({ id: "second", reference: "PLAN_ENTRY_B", body: "Second entry.", createdAt: "2026-09-04T10:00:00.000Z" });
		const initial = projectProposedPlan(plan(), [first, second]);
		const reordered = projectProposedPlan(plan(), [
			{ ...first, reference: "PLAN_ENTRY_B" },
			{ ...second, reference: "PLAN_ENTRY_A" }
		]);

		expect(reordered.current[0]?.entries.map((item) => item.body)).toEqual(["Second entry.", "First entry."]);
		expect(reordered.snapshotDigest).not.toBe(initial.snapshotDigest);
	});

	it("uses empty values when the Plan body has no Goal or Context section", () => {
		const proposedPlan = projectProposedPlan(plan({ body: "## Notes\n\nNo standard sections yet." }), []);

		expect(proposedPlan).toMatchObject({ goal: "", context: "", current: [], hasActiveQuestions: false });
	});
});