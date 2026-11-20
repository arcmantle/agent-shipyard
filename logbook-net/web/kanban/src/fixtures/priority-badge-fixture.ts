import { signal } from "@lit-labs/signals";

import type { KanbanPriorityBadgeRenderService, KanbanPriorityBadgeState } from "../components/priority-badge/kanban-priority-badge.js";

const priorityBadge: KanbanPriorityBadgeState = {
	label: "High",
	variant: "high"
};

export class PriorityBadgeFixtureRenderService implements KanbanPriorityBadgeRenderService {
	public priorityBadge = signal(priorityBadge);
}

export function createPriorityBadgeShowcaseFixture(): PriorityBadgeFixtureRenderService {
	return new PriorityBadgeFixtureRenderService();
}
