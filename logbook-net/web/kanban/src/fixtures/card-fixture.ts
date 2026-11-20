import { signal } from "@lit-labs/signals";

import type { KanbanCardRenderService, KanbanCardState } from "../components/card/kanban-card.js";

const card: KanbanCardState = {
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
};

export class CardFixtureRenderService implements KanbanCardRenderService {
	public card = signal(card);
	public openedCardIds: string[] = [];

	public openCard(cardId: string) {
		this.openedCardIds.push(cardId);
	}
}

export function createCardShowcaseFixture(): CardFixtureRenderService {
	return new CardFixtureRenderService();
}