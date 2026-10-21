import { signal } from "@lit-labs/signals";

import type { KanbanSelectMenuRenderService, KanbanSelectMenuState } from "../components/select-menu/kanban-select-menu.js";

const selectMenu: KanbanSelectMenuState = {
	disabled: false,
	label: "Status",
	name: "status",
	options: [
		{ label: "Todo", value: "Todo" },
		{ label: "In progress", value: "In progress" },
		{ label: "Blocked", value: "Blocked" },
		{ label: "Done", value: "Done" }
	],
	value: "Todo"
};

export class SelectMenuFixtureRenderService implements KanbanSelectMenuRenderService {
	public selectMenu = signal(selectMenu);

	public select(value: string) {
		this.selectMenu.set({
			...this.selectMenu.get(),
			value
		});
	}
}

export function createSelectMenuShowcaseFixture(): SelectMenuFixtureRenderService {
	return new SelectMenuFixtureRenderService();
}
