import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanCommentComposerRenderServiceContext,
	type KanbanCommentComposerState
} from "./kanban-comment-composer.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanCommentComposer", () => {
	it("renders an accessible empty composer from its typed render service", async () => {
		new ContextProvider(document.body, kanbanCommentComposerRenderServiceContext, {
			commentComposer: signal<KanbanCommentComposerState>({
				isPosting: false,
				message: "",
				placeholder: "Write a comment",
				postLabel: "Post comment"
			}),
			postComment: () => undefined,
			setMessage: () => undefined
		});
		const composer = document.createElement("kanban-comment-composer");
		document.body.append(composer);
		await composer.updateComplete;

		const textarea = composer.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
		const postButton = composer.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]");
		expect(composer.shadowRoot?.querySelector("label")?.textContent).toContain("New comment");
		expect(textarea?.placeholder).toBe("Write a comment");
		expect(postButton?.textContent).toContain("Post comment");
		expect(postButton?.disabled).toBe(true);
	});

	it("updates post availability when its service signal changes", async () => {
		const commentComposer = signal<KanbanCommentComposerState>({
			isPosting: false,
			message: "",
			placeholder: "Write a comment",
			postLabel: "Post comment"
		});
		new ContextProvider(document.body, kanbanCommentComposerRenderServiceContext, {
			commentComposer,
			postComment: () => undefined,
			setMessage: () => undefined
		});
		const composer = document.createElement("kanban-comment-composer");
		document.body.append(composer);
		await composer.updateComplete;

		commentComposer.set({
			...commentComposer.get(),
			message: "Document the storage contract."
		});
		await composer.updateComplete;

		expect(composer.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Document the storage contract.");
		expect(composer.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
	});

	it("sends a message-change intent through its render service", async () => {
		const messages: string[] = [];
		new ContextProvider(document.body, kanbanCommentComposerRenderServiceContext, {
			commentComposer: signal<KanbanCommentComposerState>({
				isPosting: false,
				message: "",
				placeholder: "Write a comment",
				postLabel: "Post comment"
			}),
			postComment: () => undefined,
			setMessage: (message) => messages.push(message)
		});
		const composer = document.createElement("kanban-comment-composer");
		const events: Array<{ message: string }> = [];
		composer.addEventListener("kanban-comment-message-change", (event) => events.push(event.detail));
		document.body.append(composer);
		await composer.updateComplete;

		const textarea = composer.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
		if (textarea === null || textarea === undefined) {
			throw new Error("The Comment composer input did not render.");
		}

		textarea.value = "Document the storage contract.";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		expect(messages).toEqual(["Document the storage contract."]);
		expect(events).toEqual([{ message: "Document the storage contract." }]);
	});

	it("sends a trimmed post intent through its render service", async () => {
		const postedMessages: string[] = [];
		new ContextProvider(document.body, kanbanCommentComposerRenderServiceContext, {
			commentComposer: signal<KanbanCommentComposerState>({
				isPosting: false,
				message: "  Document the storage contract.  ",
				placeholder: "Write a comment",
				postLabel: "Post comment"
			}),
			postComment: (message) => postedMessages.push(message),
			setMessage: () => undefined
		});
		const composer = document.createElement("kanban-comment-composer");
		const events: Array<{ message: string }> = [];
		composer.addEventListener("kanban-comment-post", (event) => events.push(event.detail));
		document.body.append(composer);
		await composer.updateComplete;

		composer.shadowRoot?.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

		expect(postedMessages).toEqual(["Document the storage contract."]);
		expect(events).toEqual([{ message: "Document the storage contract." }]);
	});

	it("renders a posting composer as busy and inactive", async () => {
		const postedMessages: string[] = [];
		new ContextProvider(document.body, kanbanCommentComposerRenderServiceContext, {
			commentComposer: signal<KanbanCommentComposerState>({
				isPosting: true,
				message: "Document the storage contract.",
				placeholder: "Write a comment",
				postLabel: "Posting comment"
			}),
			postComment: (message) => postedMessages.push(message),
			setMessage: () => undefined
		});
		const composer = document.createElement("kanban-comment-composer");
		document.body.append(composer);
		await composer.updateComplete;

		const form = composer.shadowRoot?.querySelector<HTMLFormElement>("form");
		expect(form?.getAttribute("aria-busy")).toBe("true");
		expect(composer.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
		expect(composer.shadowRoot?.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
		form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		expect(postedMessages).toEqual([]);
	});
});
