import { html } from "lit";

import "../entity-view/kanban-entity-view.js";
import "../issue-overlay/kanban-issue-overlay.js";
import "./kanban-overview.js";
import { createOverviewShowcaseFixture } from "../../fixtures/overview-fixture.js";
import type { ShowcaseCase } from "../../showcase-case.js";

const overviewFixture = createOverviewShowcaseFixture();

export const kanbanOverviewShowcaseCase: ShowcaseCase = {
	description: "A slot-based shell that coordinates the main view with initiative and issue overlays.",
	id: "kanban-overview",
	label: "Kanban Overview",
	render: () => html`
	<kanban-overview>
		<kanban-entity-view slot="main">
			<div>${overviewFixture.mainContent}</div>
		</kanban-entity-view>
		<aside
			aria-label=${overviewFixture.initiativeOverlayLabel}
			slot="initiative-overlay"
		>
			${overviewFixture.initiativeOverlayText}
		</aside>
		<kanban-issue-overlay slot="issue-overlay"></kanban-issue-overlay>
	</kanban-overview>
	`,
	sectionLabel: "Kanban Overview fixture"
};