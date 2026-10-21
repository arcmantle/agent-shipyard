import { ContextProvider } from "@lit/context";
import { afterEach, describe, expect, it } from "vitest";

import { kanbanCommentRenderServiceContext } from "./kanban-comment-item.js";
import { createCommentShowcaseFixture } from "../../fixtures/comment-fixture.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanCommentItem", () => {
	it("renders fixture-backed comment content with accessible metadata", async () => {
		new ContextProvider(document.body, {
			context: kanbanCommentRenderServiceContext,
			initialValue: createCommentShowcaseFixture()
		});
		const comment = document.createElement("kanban-comment-item");
		document.body.append(comment);
		await comment.updateComplete;

		expect(comment.shadowRoot?.querySelector("article")).not.toBeNull();
		expect(comment.shadowRoot?.textContent).toContain("R. Lee");
		expect(comment.shadowRoot?.textContent).toContain("Keep server behavior identical for local and cloud workspaces.");
		expect(comment.shadowRoot?.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-26T09:30:00Z");
	});

	it("sends an edit intent through the render service and semantic event", async () => {
		const service = createCommentShowcaseFixture();
		new ContextProvider(document.body, {
			context: kanbanCommentRenderServiceContext,
			initialValue: service
		});
		const comment = document.createElement("kanban-comment-item");
		const events: Array<{ commentId: string; message: string }> = [];
		comment.addEventListener("kanban-comment-edit", (event) => {
			events.push(event.detail);
		});
		document.body.append(comment);
		await comment.updateComplete;

		comment.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
		await comment.updateComplete;
		const editor = comment.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
		if (editor === null || editor === undefined) {
			throw new Error("The Comment item edit form did not render.");
		}
		editor.value = "Document the storage contract.";
		comment.shadowRoot?.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await comment.updateComplete;

		expect(service.editedComments).toEqual([{ commentId: "comment-1", message: "Document the storage contract." }]);
		expect(events).toEqual([{ commentId: "comment-1", message: "Document the storage contract." }]);
	});

	it("moves focus to the edit field when editing begins", async () => {
		new ContextProvider(document.body, {
			context: kanbanCommentRenderServiceContext,
			initialValue: createCommentShowcaseFixture()
		});
		const comment = document.createElement("kanban-comment-item");
		document.body.append(comment);
		await comment.updateComplete;

		comment.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
		await comment.updateComplete;

		expect(comment.shadowRoot?.activeElement).toBe(comment.shadowRoot?.querySelector("textarea"));
	});
});