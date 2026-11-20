import { html } from "lit";

import "./kanban-app-shell.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanAppShellShowcaseCase: ShowcaseCase = {
	description: "A responsive composition shell for navigation, record controls, content, and mobile navigation.",
	id: "kanban-app-shell",
	label: "Kanban App shell",
	render: () => html`
	<kanban-app-shell>
		<aside
			aria-label="Project and initiative navigation"
			slot="sidebar"
		>
			Navigation
		</aside>
		<header slot="header">Editable Kanban board</header>
		<nav
			aria-label="Entity views"
			slot="tabs"
		>
			Issues
		</nav>
		<section slot="content">Board content</section>
		<aside
			aria-label="Mobile navigation"
			slot="mobile-navigation-drawer"
		>
			Navigation
		</aside>
	</kanban-app-shell>
	`,
	sectionLabel: "Kanban App shell fixture"
};