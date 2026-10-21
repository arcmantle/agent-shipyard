import { html } from "lit";

import "./kanban-issue-overlay.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanIssueOverlayShowcaseCase: ShowcaseCase = {
	description: "A right-side issue-detail dialog with service-backed visibility, a metadata slot, and a composable content slot.",
	id: "kanban-issue-overlay",
	label: "Kanban Issue overlay",
	render: () => html`
	<button
		class="issue-overlay-trigger"
		data-action="open-issue-overlay"
		type="button"
	>
		Open issue details
	</button>
	<kanban-issue-overlay>
		<span slot="metadata">High priority</span>
		<section aria-labelledby="issue-overlay-relationships">
			<h3 id="issue-overlay-relationships">Relationships</h3>
			<p>Editable Kanban board blocks Start detached Kanban server.</p>
		</section>
	</kanban-issue-overlay>
	`,
	sectionLabel: "Kanban Issue overlay fixture"
};