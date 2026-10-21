import { html } from "lit";

import "./kanban-navigation-tree.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanNavigationTreeShowcaseCase: ShowcaseCase = {
	description: "Nested project, epic, initiative, and record navigation with service-owned expansion.",
	id: "kanban-navigation-tree",
	label: "Kanban Navigation tree",
	render: () => html`<kanban-navigation-tree></kanban-navigation-tree>`,
	sectionLabel: "Kanban Navigation tree fixture"
};