import { html } from "lit";

import "./kanban-sidebar.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanSidebarShowcaseCase: ShowcaseCase = {
	description: "A collapsible layout shell for project and initiative navigation.",
	id: "kanban-sidebar",
	label: "Kanban Sidebar",
	render: () => html`
	<kanban-sidebar>
		<nav aria-label="Sidebar navigation">
			<strong>Portable Kanban design system</strong>
			<ul>
				<li>Component showcase</li>
				<li>Board read path</li>
			</ul>
		</nav>
	</kanban-sidebar>
	`,
	sectionLabel: "Kanban Sidebar fixture"
};