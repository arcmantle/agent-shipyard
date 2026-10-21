import { html } from "lit";

import "./kanban-mobile-navigation-drawer.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanMobileNavigationDrawerShowcaseCase: ShowcaseCase = {
	description: "A service-driven small-screen navigation drawer with project and initiative choices.",
	id: "kanban-mobile-navigation-drawer",
	label: "Kanban Mobile navigation drawer",
	render: () => html`
	<button
		class="mobile-navigation-drawer-trigger"
		data-action="open-mobile-navigation-drawer"
		type="button"
	>
		Open navigation
	</button>
	<kanban-mobile-navigation-drawer></kanban-mobile-navigation-drawer>
	`,
	sectionLabel: "Kanban Mobile navigation drawer fixture"
};