import { html } from "lit";

import "./kanban-button.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanButtonShowcaseCase: ShowcaseCase = {
	description: "Command controls for primary, secondary, quiet, destructive, and loading actions.",
	id: "kanban-button",
	label: "Kanban button",
	render: () => html`<kanban-button></kanban-button>`,
	sectionLabel: "Kanban button fixture"
};