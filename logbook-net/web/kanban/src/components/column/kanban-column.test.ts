import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanColumnRenderServiceContext,
	type KanbanColumnState
} from "./kanban-column.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanColumn", () => {
	it("renders a labelled column from its typed render service and projects cards", async () => {
		new ContextProvider(document.body, kanbanColumnRenderServiceContext, {
			column: signal<KanbanColumnState>({
				cardCount: 2,
				id: "todo",
				title: "Todo"
			})
		});
		const element = document.createElement("kanban-column");
		const card = document.createElement("kanban-card");
		element.append(card);
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Todo issues");
		expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("Todo");
		expect(element.shadowRoot?.textContent).toContain("2 issues");
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot")?.assignedElements()).toEqual([card]);
	});

	it("forwards a card-open intent with its column identity", async () => {
		new ContextProvider(document.body, kanbanColumnRenderServiceContext, {
			column: signal<KanbanColumnState>({
				cardCount: 1,
				id: "todo",
				title: "Todo"
			})
		});
		const element = document.createElement("kanban-column");
		const events: Array<{ cardId: string; columnId: string }> = [];
		element.addEventListener("kanban-column-open-card", (event) => {
			events.push(event.detail);
		});
		document.body.append(element);
		await element.updateComplete;

		element.dispatchEvent(new CustomEvent("kanban-card-open", {
			bubbles: true,
			composed: true,
			detail: { cardId: "issue-322" }
		}));

		expect(events).toEqual([{ cardId: "issue-322", columnId: "todo" }]);
	});

	it("updates the title and count when the service signal changes", async () => {
		const column = signal<KanbanColumnState>({
			cardCount: 2,
			id: "todo",
			title: "Todo"
		});
		new ContextProvider(document.body, kanbanColumnRenderServiceContext, { column });
		const element = document.createElement("kanban-column");
		document.body.append(element);
		await element.updateComplete;

		column.set({
			cardCount: 1,
			id: "in-progress",
			title: "In progress"
		});
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("In progress issues");
		expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("In progress");
		expect(element.shadowRoot?.textContent).toContain("1 issue");
	});
});