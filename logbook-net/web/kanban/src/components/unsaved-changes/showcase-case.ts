import { html } from "lit";

import "./kanban-unsaved-changes.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanUnsavedChangesShowcaseCase: ShowcaseCase = {
	description: "Polite feedback that shows when a record has pending local changes.",
	id: "kanban-unsaved-changes",
	label: "Kanban Unsaved changes",
	render: () => html`<kanban-unsaved-changes></kanban-unsaved-changes>`,
	sectionLabel: "Kanban Unsaved changes fixture"
};