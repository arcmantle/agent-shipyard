import { html } from "lit";

import "./kanban-shortcut-hint.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanShortcutHintShowcaseCase: ShowcaseCase = {
	description: "A compact native keyboard shortcut label.",
	id: "kanban-shortcut-hint",
	label: "Kanban Shortcut hint",
	render: () => html`<kanban-shortcut-hint></kanban-shortcut-hint>`,
	sectionLabel: "Kanban Shortcut hint fixture"
};