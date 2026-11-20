import { html } from "lit";

import "../card/kanban-card.js";
import "./kanban-column.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanColumnShowcaseCase: ShowcaseCase = {
	description: "A labelled Kanban work column that composes accessible cards.",
	id: "kanban-column",
	label: "Kanban Column",
	render: () => html`
	<kanban-column>
		<kanban-card></kanban-card>
		<kanban-card></kanban-card>
	</kanban-column>
	`,
	sectionLabel: "Kanban Column fixture"
};