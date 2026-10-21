import type { EntityDetails, EntityRecord } from "@agent-issues/core";
import { describe, expect, it } from "vitest";

import { toCompactEntity, toCompactEntityDetails, toCompactEntityList } from "./entity-projection.js";

const entity: EntityRecord = {
	id: "ISS_01",
	reference: "ISS1",
	shortReference: "ISS1",
	createdBy: "user-1",
	updatedBy: "user-1",
	kind: "issue",
	title: "Define compact projections",
	status: "in-progress",
	body: "Verbose body",
	bodySource: "authored",
	category: null,
	priority: null,
	type: null,
	revision: 3,
	contentHash: "content-hash",
	createdAt: "2026-07-24T10:00:00.000Z",
	updatedAt: "2026-07-24T11:00:00.000Z"
};

const planEntry = {
	id: "PLAN_ENTRY_01",
	reference: "PLAN_ENTRY1",
	shortReference: "PLAN_ENTRY1",
	planId: "PLAN_01",
	createdBy: "user-1",
	updatedBy: "user-1",
	role: "decision" as const,
	body: "Use compact issue details.",
	scopeDirection: null,
	referencedEntityIds: [entity.id],
	supersededEntryIds: [],
	tombstone: false,
	revision: 1,
	contentHash: "plan-entry-hash",
	createdAt: "2026-07-24T10:00:00.000Z",
	updatedAt: "2026-07-24T10:00:00.000Z"
};

describe("compact CLI entity projections", () => {
	it("projects an entity record to exactly its compact fields", () => {
		const compact = toCompactEntity(entity);

		expect(compact).toEqual({
			id: "ISS_01",
			reference: "ISS1",
			kind: "issue",
			status: "in-progress",
			title: "Define compact projections"
		});
		expect(compact).not.toHaveProperty("body");
		expect(compact).not.toHaveProperty("contentHash");
		expect(compact).not.toHaveProperty("revision");
		expect(compact).not.toHaveProperty("createdAt");
		expect(compact).not.toHaveProperty("updatedAt");
	});

	it("projects every details relation to its type and compact neighboring entity", () => {
		const incomingEntity: EntityRecord = {
			...entity,
			id: "ISS_02",
			title: "Incoming issue"
		};
		const outgoingEntity: EntityRecord = {
			...entity,
			id: "US_01",
			kind: "userStory",
			status: "ready",
			title: "Outgoing story"
		};
		const details: EntityDetails = {
			entity,
			incoming: [{ relationType: "blocks", entity: incomingEntity }],
			outgoing: [{ relationType: "fixes", entity: outgoingEntity }],
			planEntries: [planEntry],
			completionObservations: [],
			currentCompletionObservation: null,
			versionCoverage: []
		};

		const compact = toCompactEntityDetails(details);

		expect(compact).toEqual({
			entity: {
				id: "ISS_01",
				reference: "ISS1",
				kind: "issue",
				status: "in-progress",
				title: "Define compact projections"
			},
			incoming: [{
				type: "blocks",
				entity: {
					id: "ISS_02",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Incoming issue"
				}
			}],
			outgoing: [{
				type: "fixes",
				entity: {
					id: "US_01",
					reference: "ISS1",
					kind: "userStory",
					status: "ready",
					title: "Outgoing story"
				}
			}],
			planEntries: [planEntry]
		});
		expect(compact.incoming[0]).not.toHaveProperty("relationType");
		expect(compact.incoming[0]?.entity).not.toHaveProperty("body");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("contentHash");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("revision");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("createdAt");
		expect(compact.outgoing[0]?.entity).not.toHaveProperty("updatedAt");
	});

	it("projects an entity list to exactly compact items and total", () => {
		const secondEntity: EntityRecord = {
			...entity,
			id: "ISS_02",
			title: "Use compact projections"
		};

		const compact = toCompactEntityList([entity, secondEntity]);

		expect(compact).toEqual({
			items: [
				{
					id: "ISS_01",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Define compact projections"
				},
				{
					id: "ISS_02",
					reference: "ISS1",
					kind: "issue",
					status: "in-progress",
					title: "Use compact projections"
				}
			],
			total: 2
		});
		expect(Object.keys(compact)).toEqual(["items", "total"]);
		expect(compact.items[0]).not.toHaveProperty("body");
		expect(compact.items[0]).not.toHaveProperty("contentHash");
		expect(compact.items[0]).not.toHaveProperty("revision");
		expect(compact.items[0]).not.toHaveProperty("createdAt");
		expect(compact.items[0]).not.toHaveProperty("updatedAt");
	});

});