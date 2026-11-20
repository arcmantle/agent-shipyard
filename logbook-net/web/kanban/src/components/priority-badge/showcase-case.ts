import { html } from "lit";

import "./kanban-priority-badge.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanPriorityBadgeShowcaseCase: ShowcaseCase = {
	description: "A consistent priority label for cards, tables, and record detail.",
	id: "kanban-priority-badge",
	label: "Kanban Priority badge",
	render: () => html`<kanban-priority-badge></kanban-priority-badge>`,
	sectionLabel: "Kanban Priority badge fixture"
};
