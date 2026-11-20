import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanActivityEventRenderServiceContext,
	type KanbanActivityEventState
} from "./kanban-activity-event.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanActivityEvent", () => {
	it("renders a timestamped activity row from its typed render service", async () => {
		new ContextProvider(document.body, kanbanActivityEventRenderServiceContext, {
			activityEvent: signal<KanbanActivityEventState>({
				detail: "Keep pending edits stable through snapshot refresh",
				time: "2026-08-26T10:24:00Z",
				timeLabel: "Today, 10:24",
				summary: "R. Lee moved ISS-318 to In progress",
				tone: "accent"
			})
		});
		const element = document.createElement("kanban-activity-event");
		document.body.append(element);
		await element.updateComplete;

		const activityEvent = element.shadowRoot?.querySelector<HTMLElement>("article");
		expect(activityEvent?.textContent).toContain("R. Lee moved ISS-318 to In progress");
		expect(activityEvent?.textContent).toContain("Keep pending edits stable through snapshot refresh");
		expect(element.shadowRoot?.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-26T10:24:00Z");
		expect(element.shadowRoot?.querySelector(".is-accent")).not.toBeNull();
	});

	it("updates its accessible activity content when the service signal changes", async () => {
		const activityEvent = signal<KanbanActivityEventState>({
			detail: "Keep pending edits stable through snapshot refresh",
			summary: "R. Lee moved ISS-318 to In progress",
			time: "2026-08-26T10:24:00Z",
			timeLabel: "Today, 10:24",
			tone: "accent"
		});
		new ContextProvider(document.body, kanbanActivityEventRenderServiceContext, { activityEvent });
		const element = document.createElement("kanban-activity-event");
		document.body.append(element);
		await element.updateComplete;

		activityEvent.set({
			detail: "Waiting on the local server lifecycle decision",
			summary: "ISS-319 was marked blocked",
			time: "2026-08-25T16:12:00Z",
			timeLabel: "Yesterday, 16:12",
			tone: "warning"
		});
		await element.updateComplete;

		expect(element.shadowRoot?.textContent).toContain("ISS-319 was marked blocked");
		expect(element.shadowRoot?.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-25T16:12:00Z");
		expect(element.shadowRoot?.querySelector(".is-warning")).not.toBeNull();
	});
});