import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanBoardRenderServiceContext,
	type KanbanBoardState
} from "./kanban-board.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanBoard", () => {
	it("renders a labelled board from its typed render service and projects columns", async () => {
		new ContextProvider(document.body, kanbanBoardRenderServiceContext, {
			board: signal<KanbanBoardState>({ label: "Issue Kanban board" }),
			openCard: () => undefined
		});
		const element = document.createElement("kanban-board");
		const column = document.createElement("kanban-column");
		element.append(column);
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Issue Kanban board");
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot")?.assignedElements()).toEqual([column]);
	});

	it("forwards a column card-open intent through its render service and semantic event", async () => {
		const openedCardIds: string[] = [];
		new ContextProvider(document.body, kanbanBoardRenderServiceContext, {
			board: signal<KanbanBoardState>({ label: "Issue Kanban board" }),
			openCard: (cardId: string) => openedCardIds.push(cardId)
		});
		const element = document.createElement("kanban-board");
		const events: Array<{ cardId: string; columnId: string }> = [];
		element.addEventListener("kanban-board-open-card", (event) => {
			events.push(event.detail);
		});
		document.body.append(element);
		await element.updateComplete;

		element.dispatchEvent(new CustomEvent("kanban-column-open-card", {
			bubbles: true,
			composed: true,
			detail: { cardId: "issue-322", columnId: "todo" }
		}));

		expect(openedCardIds).toEqual(["issue-322"]);
		expect(events).toEqual([{ cardId: "issue-322", columnId: "todo" }]);
	});

	it("updates its accessible label when the service signal changes", async () => {
		const board = signal<KanbanBoardState>({ label: "Issue Kanban board" });
		new ContextProvider(document.body, kanbanBoardRenderServiceContext, {
			board,
			openCard: () => undefined
		});
		const element = document.createElement("kanban-board");
		document.body.append(element);
		await element.updateComplete;

		board.set({ label: "Project issue board" });
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Project issue board");
	});
});