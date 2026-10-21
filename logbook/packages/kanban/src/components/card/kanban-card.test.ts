import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { kanbanCardRenderServiceContext, type KanbanCardState } from "./kanban-card.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanCard", () => {
	it("renders an accessible blocked card from its typed render service", async () => {
		new ContextProvider(document.body, kanbanCardRenderServiceContext, {
			card: signal<KanbanCardState>({
				blockerCount: 1,
				due: { label: "Today", overdue: false },
				id: "issue-322",
				isBlocked: true,
				owner: "R. Lee",
				priority: { label: "High", variant: "high" },
				reference: "ISS-322",
				relationshipCount: 2,
				status: { label: "Todo", variant: "default" },
				title: "Define the board-server write contract"
			}),
			openCard: () => undefined
		});
		const element = document.createElement("kanban-card");
		document.body.append(element);
		await element.updateComplete;

		const card = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(card?.getAttribute("aria-label")).toBe("Open ISS-322: Define the board-server write contract");
		expect(element.shadowRoot?.textContent).toContain("Waiting on daemon");
		expect(element.shadowRoot?.textContent).toContain("Todo");
		expect(element.shadowRoot?.textContent).toContain("High");
		expect(element.shadowRoot?.textContent).toContain("R. Lee");
		expect(element.shadowRoot?.textContent).toContain("Today");
		expect(element.shadowRoot?.textContent).toContain("1 blocker");
		expect(element.shadowRoot?.textContent).toContain("2 relationships");
	});

	it("sends an open intent through its render service and semantic event", async () => {
		const openedCardIds: string[] = [];
		new ContextProvider(document.body, kanbanCardRenderServiceContext, {
			card: signal<KanbanCardState>({
				blockerCount: 0,
				due: { label: "Today", overdue: false },
				id: "issue-322",
				isBlocked: false,
				owner: "R. Lee",
				priority: { label: "High", variant: "high" },
				reference: "ISS-322",
				relationshipCount: 0,
				status: { label: "Todo", variant: "default" },
				title: "Define the board-server write contract"
			}),
			openCard: (cardId: string) => openedCardIds.push(cardId)
		});
		const element = document.createElement("kanban-card");
		const events: Array<{ cardId: string }> = [];
		element.addEventListener("kanban-card-open", (event) => {
			events.push(event.detail);
		});
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();

		expect(openedCardIds).toEqual(["issue-322"]);
		expect(events).toEqual([{ cardId: "issue-322" }]);
	});

	it("updates its rendered state when the service signal changes", async () => {
		const card = signal<KanbanCardState>({
			blockerCount: 0,
			due: { label: "Today", overdue: false },
			id: "issue-322",
			isBlocked: false,
			owner: "Unassigned",
			priority: { label: "Low", variant: "low" },
			reference: "ISS-322",
			relationshipCount: 0,
			status: { label: "Todo", variant: "default" },
			title: "Define the board-server write contract"
		});
		new ContextProvider(document.body, kanbanCardRenderServiceContext, {
			card,
			openCard: () => undefined
		});
		const element = document.createElement("kanban-card");
		document.body.append(element);
		await element.updateComplete;

		card.set({
			blockerCount: 1,
			due: { label: "Overdue", overdue: true },
			id: "issue-322",
			isBlocked: true,
			owner: "R. Lee",
			priority: { label: "High", variant: "high" },
			reference: "ISS-322",
			relationshipCount: 2,
			status: { label: "Blocked", variant: "blocked" },
			title: "Define the board-server write contract"
		});
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("button")?.classList.contains("is-blocked")).toBe(true);
		expect(element.shadowRoot?.textContent).toContain("Blocked");
		expect(element.shadowRoot?.textContent).toContain("R. Lee");
		expect(element.shadowRoot?.textContent).toContain("Overdue");
		expect(element.shadowRoot?.textContent).toContain("1 blocker");
		expect(element.shadowRoot?.textContent).toContain("2 relationships");
	});
});