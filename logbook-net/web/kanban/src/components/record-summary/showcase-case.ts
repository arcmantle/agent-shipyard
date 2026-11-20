import { html } from "lit";

import "./kanban-record-summary.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanRecordSummaryShowcaseCase: ShowcaseCase = {
	description: "A record reference, title, metadata, and owner for entity detail views.",
	id: "kanban-record-summary",
	label: "Kanban Record summary",
	render: () => html`<kanban-record-summary></kanban-record-summary>`,
	sectionLabel: "Kanban Record summary fixture"
};