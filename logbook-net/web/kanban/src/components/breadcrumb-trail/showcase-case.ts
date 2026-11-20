import { html } from "lit";

import "./kanban-breadcrumb-trail.js";
import type { ShowcaseCase } from "../../showcase-case.js";

export const kanbanBreadcrumbTrailShowcaseCase: ShowcaseCase = {
	description: "Record location trail with an identified current record and narrow-screen overflow behavior.",
	id: "kanban-breadcrumb-trail",
	label: "Kanban Breadcrumb trail",
	render: () => html`<kanban-breadcrumb-trail></kanban-breadcrumb-trail>`,
	sectionLabel: "Kanban Breadcrumb trail fixture"
};