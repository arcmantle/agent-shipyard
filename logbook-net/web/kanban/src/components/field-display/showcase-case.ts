import { html } from "lit";

import "./kanban-field-display.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanFieldDisplayShowcaseCase: ShowcaseCase = {
	description: "A read-only record field for compact values and longer descriptions.",
	id: "kanban-field-display",
	label: "Kanban Field display",
	render: () => html`<kanban-field-display></kanban-field-display>`,
	sectionLabel: "Kanban Field display fixture"
};