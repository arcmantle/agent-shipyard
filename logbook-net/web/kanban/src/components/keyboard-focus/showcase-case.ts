import { html } from "lit";

import "./kanban-keyboard-focus.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanKeyboardFocusShowcaseCase: ShowcaseCase = {
	description: "A native keyboard-focus preview with enabled, linked, and disabled controls.",
	id: "kanban-keyboard-focus",
	label: "Kanban Keyboard focus",
	render: () => html`<kanban-keyboard-focus></kanban-keyboard-focus>`,
	sectionLabel: "Kanban Keyboard focus fixture"
};
