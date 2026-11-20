import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanIssueOverlayRenderServiceContext,
	type KanbanIssueOverlayState
} from "./kanban-issue-overlay.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanIssueOverlay", () => {
	it("renders an open issue-detail dialog from its typed render service", async () => {
		new ContextProvider(document.body, kanbanIssueOverlayRenderServiceContext, {
			close: () => undefined,
			issueOverlay: signal<KanbanIssueOverlayState>({
				detail: "2 blockers",
				label: "Issue details",
				open: true,
				reference: "ISS-322",
				title: "Define the board-server write contract"
			})
		});
		const element = document.createElement("kanban-issue-overlay");
		document.body.append(element);
		await element.updateComplete;

		const dialog = element.shadowRoot?.querySelector<HTMLElement>("[role=dialog]");
		expect(dialog?.getAttribute("aria-label")).toBe("Issue details");
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
		expect(dialog?.textContent).toContain("Define the board-server write contract");
		expect(dialog?.textContent).toContain("ISS-322");
		expect(dialog?.textContent).toContain("2 blockers");
	});

	it.each([
		["close button", (element: HTMLElement) => element.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click()],
		["scrim", (element: HTMLElement) => element.shadowRoot?.querySelector<HTMLElement>(".scrim")?.click()],
		["Escape", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))]
	])("sends a close intent when the user uses %s", async (_control, dismiss) => {
		const close = vi.fn();
		new ContextProvider(document.body, kanbanIssueOverlayRenderServiceContext, {
			close,
			issueOverlay: signal<KanbanIssueOverlayState>({
				detail: "2 blockers",
				label: "Issue details",
				open: true,
				reference: "ISS-322",
				title: "Define the board-server write contract"
			})
		});
		const element = document.createElement("kanban-issue-overlay");
		const closeEvent = vi.fn();
		element.addEventListener("kanban-issue-overlay-close", closeEvent);
		document.body.append(element);
		await element.updateComplete;

		dismiss(element);

		expect(close).toHaveBeenCalledOnce();
		expect(closeEvent).toHaveBeenCalledOnce();
	});

	it("updates visibility and projects metadata and content from its service state", async () => {
		const issueOverlay = signal<KanbanIssueOverlayState>({
			detail: "2 blockers",
			label: "Issue details",
			open: false,
			reference: "ISS-322",
			title: "Define the board-server write contract"
		});
		new ContextProvider(document.body, kanbanIssueOverlayRenderServiceContext, {
			close: () => undefined,
			issueOverlay
		});
		const element = document.createElement("kanban-issue-overlay");
		element.innerHTML = `
			<span slot="metadata">High priority</span>
			<section>Editable issue content</section>
		`;
		document.body.append(element);
		await element.updateComplete;

		const overlayShell = element.shadowRoot?.querySelector<HTMLElement>(".overlay-shell");
		expect(overlayShell?.hidden).toBe(true);
		expect(element.textContent).toContain("High priority");
		expect(element.textContent).toContain("Editable issue content");

		issueOverlay.set({ ...issueOverlay.get(), open: true, title: "Review the write contract" });
		await element.updateComplete;

		expect(overlayShell?.hidden).toBe(false);
		expect(element.shadowRoot?.querySelector("h2")?.textContent).toContain("Review the write contract");
	});
});