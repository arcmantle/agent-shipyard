import { html } from "lit";

import "./kanban-entity-table.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanEntityTableShowcaseCase: ShowcaseCase = {
	description: "A record table with summaries, scope, status, and explicit open actions.",
	id: "kanban-entity-table",
	label: "Kanban Entity table",
	render: () => html`<kanban-entity-table></kanban-entity-table>`,
	sectionLabel: "Kanban Entity table fixture"
};