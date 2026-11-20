import { html } from "lit";

import "./kanban-activity-timeline.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanActivityTimelineShowcaseCase: ShowcaseCase = {
	description: "A chronological activity sequence with normal and warning record changes.",
	id: "kanban-activity-timeline",
	label: "Kanban Activity timeline",
	render: () => html`<kanban-activity-timeline></kanban-activity-timeline>`,
	sectionLabel: "Kanban Activity timeline fixture"
};