import { html } from "lit";

import "./kanban-card.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanCardShowcaseCase: ShowcaseCase = {
	description: "An accessible card that shows the record state, metadata, and blocked work.",
	id: "kanban-card",
	label: "Kanban Card",
	render: () => html`<kanban-card></kanban-card>`,
	sectionLabel: "Kanban Card fixture"
};