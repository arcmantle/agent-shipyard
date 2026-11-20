import { html } from "lit";

import "./kanban-popover-menu.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanPopoverMenuShowcaseCase: ShowcaseCase = {
	description: "An anchored action menu for issue commands.",
	id: "kanban-popover-menu",
	label: "Kanban Popover menu",
	render: () => html`<kanban-popover-menu></kanban-popover-menu>`,
	sectionLabel: "Kanban Popover menu fixture"
};