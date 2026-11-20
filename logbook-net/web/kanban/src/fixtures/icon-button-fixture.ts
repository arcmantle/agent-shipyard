import { signal } from "@lit-labs/signals";

import type { KanbanIconButtonRenderService, KanbanIconButtonState } from "../components/icon-button/kanban-icon-button.js";

const iconButton: KanbanIconButtonState = {
	action: "create",
	disabled: false,
	label: "Create",
	loading: false
};

export class IconButtonFixtureRenderService implements KanbanIconButtonRenderService {
	public activationCount = 0;
	public iconButton = signal(iconButton);

	public activate() {
		this.activationCount += 1;
	}
}

export function createIconButtonShowcaseFixture(): IconButtonFixtureRenderService {
	return new IconButtonFixtureRenderService();
}
