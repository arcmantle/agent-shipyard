import { html } from "lit";

import "./kanban-tabs.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanTabsShowcaseCase: ShowcaseCase = {
	description: "Entity view selection with an active tab state and horizontal narrow-screen overflow.",
	id: "kanban-tabs",
	label: "Kanban Tabs",
	render: () => html`<kanban-tabs></kanban-tabs>`,
	sectionLabel: "Kanban Tabs fixture"
};