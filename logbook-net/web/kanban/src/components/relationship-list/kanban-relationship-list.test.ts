import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanRelationshipListRenderServiceContext,
	type KanbanRelationshipListState
} from "./kanban-relationship-list.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanRelationshipList", () => {
	it("renders a labeled live relationship list from its typed render service", async () => {
		new ContextProvider(document.body, kanbanRelationshipListRenderServiceContext, {
			relationshipList: signal<KanbanRelationshipListState>({
				label: "Issue relationships",
				relationships: [
					{
						id: "relationship-1",
						kind: "Initiative",
						relation: "Parent",
						title: "Editable Kanban board"
					},
					{
						id: "relationship-2",
						kind: "Issue",
						relation: "Blocks",
						title: "Start detached Kanban server"
					}
				]
			})
		});
		const element = document.createElement("kanban-relationship-list");
		document.body.append(element);
		await element.updateComplete;

		const relationshipList = element.shadowRoot?.querySelector<HTMLOListElement>("ol");
		expect(relationshipList?.getAttribute("aria-label")).toBe("Issue relationships");
		expect(relationshipList?.getAttribute("aria-live")).toBe("polite");
		expect(relationshipList?.querySelectorAll("li")).toHaveLength(2);
		expect(relationshipList?.textContent).toContain("Editable Kanban board");
		expect(relationshipList?.textContent).toContain("Blocks");
	});

	it("renders the empty relationship state from its typed render service", async () => {
		new ContextProvider(document.body, kanbanRelationshipListRenderServiceContext, {
			relationshipList: signal<KanbanRelationshipListState>({
				label: "Issue relationships",
				relationships: []
			})
		});
		const element = document.createElement("kanban-relationship-list");
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("ol")).toBeNull();
		expect(element.shadowRoot?.textContent).toContain("No related records yet.");
	});

	it("updates when its relationship service signal changes", async () => {
		const relationshipList = signal<KanbanRelationshipListState>({
			label: "Issue relationships",
			relationships: []
		});
		new ContextProvider(document.body, kanbanRelationshipListRenderServiceContext, { relationshipList });
		const element = document.createElement("kanban-relationship-list");
		document.body.append(element);
		await element.updateComplete;

		relationshipList.set({
			label: "Initiative relationships",
			relationships: [
				{
					id: "relationship-1",
					kind: "PRD",
					relation: "Context",
					title: "Independent Kanban application"
				}
			]
		});
		await element.updateComplete;

		const relationships = element.shadowRoot?.querySelector("ol");
		expect(relationships?.getAttribute("aria-label")).toBe("Initiative relationships");
		expect(relationships?.textContent).toContain("Independent Kanban application");
	});
});