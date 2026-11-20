import { signal } from "@lit-labs/signals";

import type { KanbanButtonRenderService, KanbanButtonState } from "../components/button/kanban-button.js";

const button: KanbanButtonState = {
	disabled: false,
	label: "Create issue",
	loading: false,
	variant: "primary"
};

export class ButtonFixtureRenderService implements KanbanButtonRenderService {
	public activationCount = 0;
	public button = signal(button);

	public activate() {
		this.activationCount += 1;
	}
}

export function createButtonShowcaseFixture(): ButtonFixtureRenderService {
	return new ButtonFixtureRenderService();
}