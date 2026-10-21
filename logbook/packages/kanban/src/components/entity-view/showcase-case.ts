import { html } from "lit";

import "./kanban-entity-view.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanEntityViewShowcaseCase: ShowcaseCase = {
	description: "A view shell with context, a clear command, and composed entity content.",
	id: "kanban-entity-view",
	label: "Kanban Entity view",
	render: () => html`
	<kanban-entity-view>
		<div>Plan content</div>
	</kanban-entity-view>
	`,
	sectionLabel: "Kanban Entity view fixture"
};