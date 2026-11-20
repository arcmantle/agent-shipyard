import { html } from "lit";

import "./kanban-relationship-list.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanRelationshipListShowcaseCase: ShowcaseCase = {
	description: "An ordered set of records related to the active entity, with an empty state when no links exist.",
	id: "kanban-relationship-list",
	label: "Kanban Relationship list",
	render: () => html`<kanban-relationship-list></kanban-relationship-list>`,
	sectionLabel: "Kanban Relationship list fixture"
};