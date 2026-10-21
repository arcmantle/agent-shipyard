import { describe, expect, it, vi } from "vitest";

import { projectChangeEventForWrite } from "./change-events.js";

describe("projectChangeEventForWrite", () => {
	it.each([
		{ expectedInitiativeIds: ["INIT1"], fromId: "EPIC1", fromKind: "epic", method: "linkEntities", toId: "INIT1", toKind: "initiative" },
		{ expectedInitiativeIds: ["INIT1"], fromId: "EPIC1", fromKind: "epic", method: "unlinkEntities", toId: "INIT1", toKind: "initiative" },
		{ expectedInitiativeIds: [], fromId: "PROJ1", fromKind: "project", method: "linkEntities", toId: "EPIC1", toKind: "epic" },
		{ expectedInitiativeIds: [], fromId: "PROJ1", fromKind: "project", method: "unlinkEntities", toId: "EPIC1", toKind: "epic" }
	])("marks a $fromKind-to-$toKind contains $method write as a Project Summary change", async ({ expectedInitiativeIds, fromId, fromKind, method, toId, toKind }) => {
		const getEntityDetails = vi.fn(async (entityId: string) => ({
			entity: {
				body: "",
				createdAt: "2026-01-01T00:00:00.000Z",
				id: entityId,
				kind: entityId === fromId ? fromKind : toKind,
				status: "active",
				title: entityId,
				updatedAt: "2026-01-01T00:00:00.000Z"
			},
			incoming: [],
			outgoing: [],
			planEntries: []
		}));
		const store = { getEntityDetails } as never;

		const event = await projectChangeEventForWrite(
			store,
			method,
			"PROJ1",
			{ fromId, relationType: "contains", toId },
			undefined
		);

		expect(event).toMatchObject({
			affectedEntityIds: [fromId, toId],
			affectedInitiativeIds: expectedInitiativeIds,
			affectsProjectSummary: true,
			category: "relation",
			projectId: "PROJ1"
		});
	});
});