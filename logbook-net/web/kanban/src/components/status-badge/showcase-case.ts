import { html } from "lit";

import "./kanban-status-badge.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanStatusBadgeShowcaseCase: ShowcaseCase = {
	description: "Compact status labels for active, blocked, muted, and default work states.",
	id: "kanban-status-badge",
	label: "Kanban Status badge",
	render: () => html`<kanban-status-badge></kanban-status-badge>`,
	sectionLabel: "Kanban Status badge fixture"
};