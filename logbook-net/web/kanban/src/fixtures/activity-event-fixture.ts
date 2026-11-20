import { signal } from "@lit-labs/signals";

import type { KanbanActivityEventRenderService, KanbanActivityEventState } from "../components/activity-event/kanban-activity-event.js";

const activityEvent: KanbanActivityEventState = {
	detail: "Keep pending edits stable through snapshot refresh",
	summary: "R. Lee moved ISS-318 to In progress",
	time: "2026-08-26T10:24:00Z",
	timeLabel: "Today, 10:24",
	tone: "accent"
};

export class ActivityEventFixtureRenderService implements KanbanActivityEventRenderService {
	public activityEvent = signal(activityEvent);
}

export function createActivityEventShowcaseFixture(): ActivityEventFixtureRenderService {
	return new ActivityEventFixtureRenderService();
}