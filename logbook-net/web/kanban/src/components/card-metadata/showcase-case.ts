import { html } from "lit";

import "./kanban-card-metadata.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanCardMetadataShowcaseCase: ShowcaseCase = {
	description: "A compact record metadata summary for a Kanban card, including status, priority, ownership, due state, blockers, and relationship count.",
	id: "kanban-card-metadata",
	label: "Kanban Card metadata",
	render: () => html`<kanban-card-metadata></kanban-card-metadata>`,
	sectionLabel: "Kanban Card metadata fixture"
};