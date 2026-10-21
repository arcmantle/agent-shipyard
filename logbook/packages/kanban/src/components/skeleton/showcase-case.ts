import { html } from "lit";

import "./kanban-skeleton.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanSkeletonShowcaseCase: ShowcaseCase = {
	description: "Loading placeholders for card, table, and record-panel layouts.",
	id: "kanban-skeleton",
	label: "Kanban Skeleton",
	render: () => html`<kanban-skeleton></kanban-skeleton>`,
	sectionLabel: "Kanban Skeleton fixture"
};
