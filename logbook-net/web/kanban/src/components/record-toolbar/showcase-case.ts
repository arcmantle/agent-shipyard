import { html } from "lit";

import "./kanban-record-toolbar.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanRecordToolbarShowcaseCase: ShowcaseCase = {
	description: "A record title, commands, search, filtering, and Board or Table view selection.",
	id: "kanban-record-toolbar",
	label: "Kanban Record toolbar",
	render: () => html`<kanban-record-toolbar></kanban-record-toolbar>`,
	sectionLabel: "Kanban Record toolbar fixture"
};