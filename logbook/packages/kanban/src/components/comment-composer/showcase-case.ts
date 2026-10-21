import { html } from "lit";

import "./kanban-comment-composer.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanCommentComposerShowcaseCase: ShowcaseCase = {
	description: "A message composer with clear posting state and project visibility guidance.",
	id: "kanban-comment-composer",
	label: "Kanban Comment composer",
	render: () => html`<kanban-comment-composer></kanban-comment-composer>`,
	sectionLabel: "Kanban Comment composer fixture"
};