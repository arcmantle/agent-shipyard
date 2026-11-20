import { signal } from "@lit-labs/signals";

import type { KanbanBoardRenderService, KanbanBoardState } from "../components/board/kanban-board.js";

const board: KanbanBoardState = {
	label: "Issue Kanban board"
};

export class BoardFixtureRenderService implements KanbanBoardRenderService {
	public board = signal(board);
	public openedCardIds: string[] = [];

	public openCard(cardId: string) {
		this.openedCardIds.push(cardId);
	}
}

export function createBoardShowcaseFixture(): BoardFixtureRenderService {
	return new BoardFixtureRenderService();
}