import { signal } from "@lit-labs/signals";

import type { KanbanPopoverMenuRenderService, KanbanPopoverMenuState } from "../components/popover-menu/kanban-popover-menu.js";

const menu: KanbanPopoverMenuState = {
	actions: [
		{ id: "edit", label: "Edit issue" },
		{ id: "duplicate", label: "Duplicate issue" },
		{ id: "archive", label: "Archive issue", tone: "danger" }
	],
	label: "Issue actions"
};

export class PopoverMenuFixtureRenderService implements KanbanPopoverMenuRenderService {
	public menu = signal(menu);
	public performedActionIds: string[] = [];

	public performAction(actionId: string) {
		this.performedActionIds.push(actionId);
	}
}

export function createPopoverMenuShowcaseFixture(): PopoverMenuFixtureRenderService {
	return new PopoverMenuFixtureRenderService();
}