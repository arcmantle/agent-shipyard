import { signal } from "@lit-labs/signals";

import type { KanbanBreadcrumbTrailRenderService, KanbanBreadcrumbTrailState } from "../components/breadcrumb-trail/kanban-breadcrumb-trail.js";

const breadcrumbTrail: KanbanBreadcrumbTrailState = {
	items: ["Workspace", "Initiative", "Portable Kanban design system"],
	label: "Record location"
};

export class BreadcrumbTrailFixtureRenderService implements KanbanBreadcrumbTrailRenderService {
	public breadcrumbTrail = signal(breadcrumbTrail);
}

export function createBreadcrumbTrailShowcaseFixture(): BreadcrumbTrailFixtureRenderService {
	return new BreadcrumbTrailFixtureRenderService();
}