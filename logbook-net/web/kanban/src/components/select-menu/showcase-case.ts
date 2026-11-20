import { html } from "lit";

import "./kanban-select-menu.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanSelectMenuShowcaseCase: ShowcaseCase = {
	description: "A labeled status selector with an anchored Popover listbox and keyboard behavior.",
	id: "kanban-select-menu",
	label: "Kanban select menu",
	render: () => html`<kanban-select-menu></kanban-select-menu>`,
	sectionLabel: "Kanban select menu fixture"
};
