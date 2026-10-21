import { html } from "lit";

import "./kanban-icon-button.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanIconButtonShowcaseCase: ShowcaseCase = {
	description: "Compact icon controls for create, close, collapse, overflow, disabled, and loading actions.",
	id: "kanban-icon-button",
	label: "Kanban Icon button",
	render: () => html`<kanban-icon-button></kanban-icon-button>`,
	sectionLabel: "Kanban Icon button fixture"
};
