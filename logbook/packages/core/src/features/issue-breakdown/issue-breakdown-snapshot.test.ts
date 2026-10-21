import { describe, expect, it } from "vitest";

import { projectProposedIssueBreakdown } from "./issue-breakdown-snapshot.js";

describe("projectProposedIssueBreakdown", () => {
	it("projects the complete ordered issue graph with a deterministic snapshot digest", () => {
		const input = {
			targetId: "initiative-id",
			targetReference: "INIT_ABC123",
			issues: [
				{
					key: "parent",
					title: "Add draft storage",
					outcome: "Drafts persist for review.",
					scope: ["Add storage."],
					workMode: "AFK",
					acceptanceCriteria: ["A draft is retrievable."],
					planEntryIds: ["plan-entry-id"],
					relationReferences: [{ relationType: "fixes", targetId: "story-id", targetReference: "STORY_ABC123" }]
				},
				{
					key: "child",
					title: "Add snapshot projection",
					outcome: "Drafts have a digest.",
					scope: ["Add projection."],
					workMode: "HITL",
					acceptanceCriteria: ["The digest is stable."],
					parentKey: "parent",
					relationReferences: [{ relationType: "blocks", targetKey: "parent" }]
				}
			]
		};

		const first = projectProposedIssueBreakdown(input);
		const second = projectProposedIssueBreakdown(input);

		expect(first).toMatchObject({
			targetId: "initiative-id",
			targetReference: "INIT_ABC123",
			issues: [
					{ key: "parent", planEntryIds: ["plan-entry-id"], relationReferences: [{ relationType: "fixes", targetId: "story-id" }] },
				{ key: "child", parentKey: "parent", relationReferences: [{ relationType: "blocks", targetKey: "parent" }] }
			]
		});
		expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(second.snapshotDigest).toBe(first.snapshotDigest);
	});
});