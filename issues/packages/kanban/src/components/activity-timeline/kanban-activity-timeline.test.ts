import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanActivityTimelineRenderServiceContext,
	type KanbanActivityTimelineState
} from "./kanban-activity-timeline.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanActivityTimeline", () => {
	it("renders a labeled sequence of activity entries from its typed render service", async () => {
		new ContextProvider(document.body, kanbanActivityTimelineRenderServiceContext, {
			activityTimeline: signal<KanbanActivityTimelineState>({
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
					}
				],
				label: "Initiative activity"
			})
		});
		const element = document.createElement("kanban-activity-timeline");
		document.body.append(element);
		await element.updateComplete;

		const timeline = element.shadowRoot?.querySelector<HTMLElement>("ol");
		expect(timeline?.getAttribute("aria-label")).toBe("Initiative activity");
		expect(timeline?.querySelectorAll("li")).toHaveLength(2);
		expect(timeline?.textContent).toContain("R. Lee moved ISS-318 to In progress");
		expect(timeline?.textContent).toContain("ADR-014 was accepted");
		expect(element.shadowRoot?.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-26T10:24:00Z");
	});

	it("renders its empty activity state from the typed render service", async () => {
		new ContextProvider(document.body, kanbanActivityTimelineRenderServiceContext, {
			activityTimeline: signal<KanbanActivityTimelineState>({
				entries: [],
				label: "Initiative activity"
			})
		});
		const element = document.createElement("kanban-activity-timeline");
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("ol")).toBeNull();
		expect(element.shadowRoot?.textContent).toContain("No activity has been recorded for this initiative.");
	});

	it("updates its activity sequence when the service signal changes", async () => {
		const activityTimeline = signal<KanbanActivityTimelineState>({
			entries: [],
			label: "Initiative activity"
		});
		new ContextProvider(document.body, kanbanActivityTimelineRenderServiceContext, { activityTimeline });
		const element = document.createElement("kanban-activity-timeline");
		document.body.append(element);
		await element.updateComplete;

		activityTimeline.set({
			entries: [
				{
					detail: "Waiting on the local server lifecycle decision",
					id: "activity-3",
					summary: "ISS-319 was marked blocked",
					time: "2026-08-25T16:12:00Z",
					timeLabel: "Yesterday, 16:12",
					tone: "warning"
				}
			],
			label: "Issue activity"
		});
		await element.updateComplete;

		const timeline = element.shadowRoot?.querySelector<HTMLElement>("ol");
		expect(timeline?.getAttribute("aria-label")).toBe("Issue activity");
		expect(timeline?.textContent).toContain("ISS-319 was marked blocked");
		expect(timeline?.querySelector(".is-warning")).not.toBeNull();
	});
});