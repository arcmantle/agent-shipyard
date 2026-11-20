import { signal } from "@lit-labs/signals";

import type { KanbanFieldDisplayRenderService, KanbanFieldDisplayState } from "../components/field-display/kanban-field-display.js";

const fieldDisplay: KanbanFieldDisplayState = {
	label: "Title",
	multiline: false,
	value: "Define the board-server write contract"
};

export class FieldDisplayFixtureRenderService implements KanbanFieldDisplayRenderService {
	public fieldDisplay = signal(fieldDisplay);
}

export function createFieldDisplayShowcaseFixture(): FieldDisplayFixtureRenderService {
	return new FieldDisplayFixtureRenderService();
}