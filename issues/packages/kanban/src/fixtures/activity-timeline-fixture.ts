import { signal } from "@lit-labs/signals";

import type { KanbanActivityTimelineRenderService, KanbanActivityTimelineState } from "../components/activity-timeline/kanban-activity-timeline.js";

const activityTimeline: KanbanActivityTimelineState = {
	entries: [
		{
			detail: "Keep pending edits stable through snapshot refresh",
			id: "activity-1",
			summary: "R. Lee moved ISS-318 to In progress",
			time: "2026-08-26T10:24:00Z",
			timeLabel: "Today, 10:24",
			tone: "accent"
		},
		{
			detail: "Serve the board through a detached local runtime",
			id: "activity-2",
			summary: "ADR-014 was accepted",
			time: "2026-08-26T09:46:00Z",
			timeLabel: "Today, 09:46",
			tone: "default"
		},
		{
			detail: "Waiting on the local server lifecycle decision",
			id: "activity-3",
			summary: "ISS-319 was marked blocked",
			time: "2026-08-25T16:12:00Z",
			timeLabel: "Yesterday, 16:12",
			tone: "warning"
		}
	],
	label: "Initiative activity"
};

export class ActivityTimelineFixtureRenderService implements KanbanActivityTimelineRenderService {
	public activityTimeline = signal(activityTimeline);
}

export function createActivityTimelineShowcaseFixture(): ActivityTimelineFixtureRenderService {
	return new ActivityTimelineFixtureRenderService();
}