import { describe, expect, it } from "vitest";

import { createEntityDetailRenderer, type EntityDetailRendererHost } from "./entity-detail-renderers.js";
import type { Entity } from "../models.js";
import { AgentIssuesStore } from "../services/agent-issues-store.js";

function makeEntity(kind: string): Entity {
	return {
		body: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		id: `${kind}-1`,
		kind,
		status: "active",
		title: `${kind} record`,
		updatedAt: "2026-01-01T00:00:00.000Z"
	};
}

const host = {} as EntityDetailRendererHost;

describe("entity detail renderer factory", () => {
	it.each([
		["issue", "Issue"],
		["adr", "ADR"],
		["prd", "PRD"],
		["userStory", "User story"],
		["plan", "Plan"],
		["debt", "Debt"],
		["handoff", "Handoff"]
	])("uses a tabbed renderer for %s", (kind, label) => {
		const renderer = createEntityDetailRenderer(new AgentIssuesStore(), makeEntity(kind), host);

		expect(renderer.label).toBe(label);
		expect(renderer.usesTabs()).toBe(true);
	});

	it("uses the generic non-tabbed renderer for entity kinds without a detail surface", () => {
		const renderer = createEntityDetailRenderer(new AgentIssuesStore(), makeEntity("epic"), host);

		expect(renderer.label).toBe("Record");
		expect(renderer.usesTabs()).toBe(false);
	});
});
