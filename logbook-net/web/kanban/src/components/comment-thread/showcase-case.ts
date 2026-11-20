import { html } from "lit";

import "./kanban-comment-thread.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanCommentThreadShowcaseCase: ShowcaseCase = {
	description: "An ordered record discussion that shows existing comments or an empty state.",
	id: "kanban-comment-thread",
	label: "Kanban Comment thread",
	render: () => html`<kanban-comment-thread></kanban-comment-thread>`,
	sectionLabel: "Kanban Comment thread fixture"
};
