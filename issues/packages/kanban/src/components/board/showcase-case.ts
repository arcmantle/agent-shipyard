import { html } from "lit";

import "./kanban-board-showcase.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanBoardShowcaseCase: ShowcaseCase = {
	description: "A horizontal board layout that composes labelled work columns and cards.",
	id: "kanban-board",
	label: "Kanban Board",
	render: () => html`<kanban-board-showcase></kanban-board-showcase>`,
	sectionLabel: "Kanban Board fixture"
};