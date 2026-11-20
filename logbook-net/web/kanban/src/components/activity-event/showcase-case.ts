import { html } from "lit";

import "./kanban-activity-event.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanActivityEventShowcaseCase: ShowcaseCase = {
	description: "A timestamped record change for use in an activity timeline.",
	id: "kanban-activity-event",
	label: "Kanban Activity event",
	render: () => html`<kanban-activity-event></kanban-activity-event>`,
	sectionLabel: "Kanban Activity event fixture"
};