import { signal } from "@lit-labs/signals";

import type { KanbanStatusBadgeRenderService, KanbanStatusBadgeState } from "../components/status-badge/kanban-status-badge.js";

const statusBadge: KanbanStatusBadgeState = {
	label: "In progress",
	variant: "active"
};

export class StatusBadgeFixtureRenderService implements KanbanStatusBadgeRenderService {
	public statusBadge = signal(statusBadge);
}

export function createStatusBadgeShowcaseFixture(): StatusBadgeFixtureRenderService {
	return new StatusBadgeFixtureRenderService();
}