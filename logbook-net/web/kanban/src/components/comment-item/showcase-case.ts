import { html } from "lit";

import "./kanban-comment-item.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanCommentItemShowcaseCase: ShowcaseCase = {
	description: "A timestamped author message for use in an issue discussion.",
	id: "kanban-comment-item",
	label: "Kanban Comment item",
	render: () => html`<kanban-comment-item></kanban-comment-item>`,
	sectionLabel: "Kanban Comment item fixture"
};