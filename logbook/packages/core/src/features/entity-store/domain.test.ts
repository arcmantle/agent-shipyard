import { describe, expect, it } from "vitest";

import { deriveEntityStatuses, derivePrdStatus, deriveUserStoryStatus, getAllowedRelationTypes, getInitialStatus, ID_PREFIX, isAllowedRelation, isEntityType, isInitiativeActive, isInitiativeComplete, isValidStatus } from "./domain.js";

describe("deferred issues", () => {
	it("allows deferral only for issues", () => {
		expect(isValidStatus("issue", "deferred")).toBe(true);
		for (const kind of ["initiative", "prd", "userStory", "debt"] as const) {
			expect(isValidStatus(kind, "deferred")).toBe(false);
		}
	});

	it("excludes deferred work from derived completion without treating it as started work", () => {
		expect(deriveUserStoryStatus("ready", ["done", "deferred"])).toBe("done");
		expect(deriveUserStoryStatus("ready", ["deferred"])).toBe("done");
		expect(deriveUserStoryStatus("ready", ["todo", "deferred"])).toBe("ready");
		expect(isInitiativeComplete(["done", "deferred"], ["approved"])).toBe(true);
		expect(isInitiativeComplete(["deferred"], [])).toBe(true);
		expect(isInitiativeComplete(["todo", "deferred"], [])).toBe(false);
		expect(isInitiativeComplete(["deferred"], ["draft"])).toBe(false);
		expect(isInitiativeActive(["todo", "deferred"], ["draft"])).toBe(false);
	});
});

describe("Plans", () => {
	it("has a draft lifecycle, a PLAN reference, initiative ownership, and PRD provenance", () => {
		expect(getInitialStatus("plan")).toBe("draft");
		expect(isValidStatus("plan", "ready")).toBe(true);
		expect(ID_PREFIX.plan).toBe("PLAN");
		expect(isAllowedRelation("initiative", "plan", "owns")).toBe(true);
		expect(isAllowedRelation("plan", "prd", "informs")).toBe(true);
		expect(getAllowedRelationTypes("initiative", "issue")).toEqual(["tracks"]);
	});
});

describe("kind-specific entity types", () => {
	it("allows only declared specialized types for an entity kind", () => {
		expect(isEntityType("issue", "pioneer-map")).toBe(true);
		expect(isEntityType("issue", "pioneer-ticket")).toBe(true);
		expect(isEntityType("issue", "unknown")).toBe(false);
		expect(isEntityType("initiative", "pioneer-map")).toBe(false);
	});
});

describe("superseded planning records", () => {
	it("allows ADRs to be recorded by projects, epics, and initiatives", () => {
		expect(isAllowedRelation("project", "adr", "records")).toBe(true);
		expect(isAllowedRelation("epic", "adr", "records")).toBe(true);
		expect(isAllowedRelation("initiative", "adr", "records")).toBe(true);
	});

	it("allows superseded as a derived PRD and user-story status", () => {
		expect(isValidStatus("prd", "superseded")).toBe(true);
		expect(isValidStatus("userStory", "superseded")).toBe(true);
		expect(isAllowedRelation("prd", "prd", "supersedes")).toBe(true);
		expect(isAllowedRelation("userStory", "userStory", "supersedes")).toBe(true);
	});

	it("derives superseded only from an incoming supersedes relation", () => {
		const entities = [
			{ id: "PRD1", reference: "PRD1", shortReference: "PRD1", createdBy: "user", updatedBy: "user", kind: "prd" as const, title: "Old", status: "draft", body: "", bodySource: "authored" as const, category: null, priority: null, type: null, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "PRD2", reference: "PRD2", shortReference: "PRD2", createdBy: "user", updatedBy: "user", kind: "prd" as const, title: "New", status: "draft", body: "", bodySource: "authored" as const, category: null, priority: null, type: null, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "US1", reference: "US1", shortReference: "US1", createdBy: "user", updatedBy: "user", kind: "userStory" as const, title: "Old", status: "draft", body: "", bodySource: "authored" as const, category: null, priority: null, type: null, revision: 1, contentHash: "", createdAt: "", updatedAt: "" },
			{ id: "US2", reference: "US2", shortReference: "US2", createdBy: "user", updatedBy: "user", kind: "userStory" as const, title: "New", status: "draft", body: "", bodySource: "authored" as const, category: null, priority: null, type: null, revision: 1, contentHash: "", createdAt: "", updatedAt: "" }
		];
		const relations = [
			{ fromId: "PRD2", toId: "PRD1", type: "supersedes" as const, createdBy: "user", createdAt: "" },
			{ fromId: "US2", toId: "US1", type: "supersedes" as const, createdBy: "user", createdAt: "" }
		];

		const statuses = new Map(deriveEntityStatuses(entities, relations).map((entity) => [entity.id, entity.status]));
		expect(statuses.get("PRD1")).toBe("superseded");
		expect(statuses.get("US1")).toBe("superseded");
		expect(statuses.get("PRD2")).toBe("draft");
		expect(statuses.get("US2")).toBe("draft");
	});

	it("treats superseded planning children as terminal", () => {
		expect(derivePrdStatus("draft", ["done", "superseded"])).toBe("approved");
		expect(derivePrdStatus("draft", ["superseded", "superseded"])).toBe("approved");
		expect(isInitiativeComplete(["done"], ["approved", "superseded"])).toBe(true);
	});
});