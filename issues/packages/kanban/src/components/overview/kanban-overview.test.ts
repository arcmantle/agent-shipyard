import { afterEach, describe, expect, it, vi } from "vitest";

import "./kanban-overview.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanOverview", () => {
	it("projects its named composition slots", async () => {
		const element = document.createElement("kanban-overview");
		const mainView = document.createElement("section");
		mainView.slot = "main";
		mainView.textContent = "Issue board";
		const initiativeOverlay = document.createElement("aside");
		initiativeOverlay.slot = "initiative-overlay";
		initiativeOverlay.textContent = "Initiative details";
		const issueOverlay = document.createElement("aside");
		issueOverlay.slot = "issue-overlay";
		issueOverlay.textContent = "Issue details";
		element.append(mainView, initiativeOverlay, issueOverlay);
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=main]")?.assignedElements()).toEqual([mainView]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=initiative-overlay]")?.assignedElements()).toEqual([initiativeOverlay]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=issue-overlay]")?.assignedElements()).toEqual([issueOverlay]);
	});

	it.each([
		["kanban-app-shell-open-initiative", "kanban-overview-open-initiative", null],
		["kanban-app-shell-open-issue", "kanban-overview-open-issue", { reference: "ISS_001" }],
		["kanban-initiative-overlay-close", "kanban-overview-close-initiative", null],
		["kanban-issue-overlay-close", "kanban-overview-close-issue", null]
	])("forwards %s as %s", async (sourceEvent, overviewEvent, detail) => {
		const element = document.createElement("kanban-overview");
		const source = document.createElement("section");
		source.slot = "main";
		element.append(source);
		const forwardedIntent = vi.fn();
		element.addEventListener(overviewEvent, forwardedIntent);
		document.body.append(element);
		await element.updateComplete;

		source.dispatchEvent(new CustomEvent(sourceEvent, { bubbles: true, composed: true, detail }));

		expect(forwardedIntent).toHaveBeenCalledOnce();
		expect((forwardedIntent.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(detail);
	});
});