import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanCommentThreadRenderServiceContext,
	type KanbanCommentThreadState
} from "./kanban-comment-thread.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanCommentThread", () => {
	it("renders a labeled ordered discussion from its typed render service", async () => {
		new ContextProvider(document.body, kanbanCommentThreadRenderServiceContext, {
			commentThread: signal<KanbanCommentThreadState>({
				comments: [
					{
						author: "You",
						id: "comment-1",
						message: "Keep server behavior identical for local and cloud workspaces.",
						publishedAt: "2026-08-26T10:24:00Z",
						publishedLabel: "Today, 10:24"
					},
					{
						author: "R. Lee",
						id: "comment-2",
						message: "Document the storage contract before the migration.",
						publishedAt: "2026-08-26T10:28:00Z",
						publishedLabel: "Today, 10:28"
					}
				],
				label: "Issue comments"
			})
		});
		const element = document.createElement("kanban-comment-thread");
		document.body.append(element);
		await element.updateComplete;

		const discussion = element.shadowRoot?.querySelector<HTMLOListElement>("ol");
		expect(discussion?.getAttribute("aria-label")).toBe("Issue comments");
		expect(discussion?.querySelectorAll("li")).toHaveLength(2);
		expect(discussion?.textContent).toContain("Keep server behavior identical for local and cloud workspaces.");
		expect(discussion?.textContent).toContain("Document the storage contract before the migration.");
		expect(discussion?.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-26T10:24:00Z");
	});

	it("renders the empty discussion state from its typed render service", async () => {
		new ContextProvider(document.body, kanbanCommentThreadRenderServiceContext, {
			commentThread: signal<KanbanCommentThreadState>({
				comments: [],
				label: "Issue comments"
			})
		});
		const element = document.createElement("kanban-comment-thread");
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("ol")).toBeNull();
		expect(element.shadowRoot?.textContent).toContain("No comments yet. Start the discussion for this record.");
	});

	it("updates its discussion when its service signal changes", async () => {
		const commentThread = signal<KanbanCommentThreadState>({
			comments: [],
			label: "Issue comments"
		});
		new ContextProvider(document.body, kanbanCommentThreadRenderServiceContext, { commentThread });
		const element = document.createElement("kanban-comment-thread");
		document.body.append(element);
		await element.updateComplete;

		commentThread.set({
			comments: [
				{
					author: "You",
					id: "comment-1",
					message: "Document the storage contract before the migration.",
					publishedAt: "2026-08-26T10:28:00Z",
					publishedLabel: "Today, 10:28"
				}
			],
			label: "Initiative comments"
		});
		await element.updateComplete;

		const discussion = element.shadowRoot?.querySelector<HTMLOListElement>("ol");
		expect(discussion?.getAttribute("aria-label")).toBe("Initiative comments");
		expect(discussion?.textContent).toContain("Document the storage contract before the migration.");
	});
});
