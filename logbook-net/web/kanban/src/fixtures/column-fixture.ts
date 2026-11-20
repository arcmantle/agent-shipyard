import { signal } from "@lit-labs/signals";

import type { KanbanColumnRenderService, KanbanColumnState } from "../components/column/kanban-column.js";

const column: KanbanColumnState = {
	cardCount: 2,
	id: "todo",
	title: "Todo"
};

export class ColumnFixtureRenderService implements KanbanColumnRenderService {
	public column = signal(column);
}

export function createColumnShowcaseFixture(): ColumnFixtureRenderService {
	return new ColumnFixtureRenderService();
}