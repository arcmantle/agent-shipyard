import { describe, expect, it } from "vitest";

import { projectPlanEntries, type PlanEntryRecord, type PlanEntryRole } from "./plan-entry-types.js";

function entry(input: {
	id: string;
	role: PlanEntryRole;
	createdAt: string;
	scopeDirection?: "included" | "excluded" | null;
	supersededEntryIds?: string[];
	tombstone?: boolean;
}): PlanEntryRecord {
	return {
		id: input.id,
		reference: `PLAN_ENTRY_${input.id}`,
		shortReference: `PLAN_ENTRY_${input.id}`,
		planId: "plan-id",
		createdBy: "user-id",
		updatedBy: "user-id",
		role: input.role,
		body: input.id,
		scopeDirection: input.scopeDirection ?? null,
		referencedEntityIds: [],
		supersededEntryIds: input.supersededEntryIds ?? [],
		tombstone: input.tombstone ?? false,
		revision: 1,
		contentHash: "content-hash",
		createdAt: input.createdAt,
		updatedAt: input.createdAt
	};
}

describe("Plan entry projection", () => {
	it("groups active entries in the approved order and retains chronological history", () => {
		const question = entry({ id: "question", role: "question", createdAt: "2026-08-16T10:00:00.000Z" });
		const projection = projectPlanEntries([
			entry({ id: "consideration", role: "consideration", createdAt: "2026-08-16T17:00:00.000Z" }),
			entry({ id: "excluded", role: "scope", scopeDirection: "excluded", createdAt: "2026-08-16T14:00:00.000Z" }),
			entry({ id: "decision", role: "decision", supersededEntryIds: [question.id], createdAt: "2026-08-16T11:00:00.000Z" }),
			entry({ id: "preference", role: "preference", createdAt: "2026-08-16T16:00:00.000Z" }),
			entry({ id: "constraint", role: "constraint", createdAt: "2026-08-16T15:00:00.000Z" }),
			question,
			entry({ id: "included", role: "scope", scopeDirection: "included", createdAt: "2026-08-16T13:00:00.000Z" }),
			entry({ id: "deleted", role: "question", tombstone: true, createdAt: "2026-08-16T12:00:00.000Z" })
		]);

		expect(projection.current.map((group) => [group.key, group.entries.map((item) => item.id)])).toEqual([
			["questions", []],
			["decisions", ["decision"]],
			["includedScope", ["included"]],
			["excludedScope", ["excluded"]],
			["constraints", ["constraint"]],
			["preferences", ["preference"]],
			["considerations", ["consideration"]]
		]);
		expect(projection.history.map((item) => item.id)).toEqual([
			"question",
			"decision",
			"deleted",
			"included",
			"excluded",
			"constraint",
			"preference",
			"consideration"
		]);
	});
});