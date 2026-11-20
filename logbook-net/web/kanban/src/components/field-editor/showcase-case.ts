import { html } from "lit";

import "./kanban-field-editor.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanFieldEditorShowcaseCase: ShowcaseCase = {
	description: "A labelled native field control that forwards user changes through its render service.",
	id: "kanban-field-editor",
	label: "Kanban Field editor",
	render: () => html`<kanban-field-editor></kanban-field-editor>`,
	sectionLabel: "Kanban Field editor fixture"
};