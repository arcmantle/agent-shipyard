import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanPopoverMenuRenderServiceContext,
	type KanbanPopoverMenuState
} from "./kanban-popover-menu.js";

afterEach(() => {
	document.body.replaceChildren();
});

function installPopoverApi(element: HTMLElement) {
	function dispatchToggle(newState: "closed" | "open") {
		const event = new Event("toggle") as ToggleEvent;
		Object.defineProperty(event, "newState", { value: newState });
		element.dispatchEvent(event);
	}

	Object.defineProperties(element, {
		hidePopover: { value: () => dispatchToggle("closed") },
		showPopover: { value: () => dispatchToggle("open") }
	});
}

describe("KanbanPopoverMenu", () => {
	it("renders a labelled Popover menu from its typed render service", async () => {
		new ContextProvider(document.body, kanbanPopoverMenuRenderServiceContext, {
			menu: signal<KanbanPopoverMenuState>({
				actions: [
					{ id: "edit", label: "Edit issue" },
					{ id: "duplicate", label: "Duplicate issue" },
					{ id: "archive", label: "Archive issue", tone: "danger" }
				],
				label: "Issue actions"
			}),
			performAction: () => undefined
		});
		const element = document.createElement("kanban-popover-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const menu = element.shadowRoot?.querySelector<HTMLElement>("[role=menu]");
		expect(trigger?.textContent).toContain("Issue actions");
		expect(trigger?.getAttribute("aria-controls")).toBe(menu?.id);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		expect(menu?.getAttribute("aria-label")).toBe("Issue actions");
		expect(menu?.getAttribute("popover")).toBe("auto");
		expect([ ...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []) ].map((item) => item.textContent?.trim())).toEqual([
			"Edit issue",
			"Duplicate issue",
			"Archive issue"
		]);
	});

	it("sends an action intent through the render service and semantic event", async () => {
		const performAction = vi.fn();
		new ContextProvider(document.body, kanbanPopoverMenuRenderServiceContext, {
			menu: signal<KanbanPopoverMenuState>({
				actions: [{ id: "archive", label: "Archive issue", tone: "danger" }],
				label: "Issue actions"
			}),
			performAction
		});
		const element = document.createElement("kanban-popover-menu");
		const intent = vi.fn();
		element.addEventListener("kanban-popover-action", intent);
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action-id=archive]")?.click();
		await element.updateComplete;

		expect(performAction).toHaveBeenCalledWith("archive");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ detail: { actionId: "archive" } }));
	});

	it("closes the Popover and restores trigger focus after an action", async () => {
		new ContextProvider(document.body, kanbanPopoverMenuRenderServiceContext, {
			menu: signal<KanbanPopoverMenuState>({
				actions: [{ id: "archive", label: "Archive issue", tone: "danger" }],
				label: "Issue actions"
			}),
			performAction: () => undefined
		});
		const element = document.createElement("kanban-popover-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>(".popover-menu > button");
		const menu = element.shadowRoot?.querySelector<HTMLElement>("[role=menu]");
		if (menu === undefined || menu === null) {
			throw new Error("expected a menu");
		}

		installPopoverApi(menu);
		trigger?.click();
		await element.updateComplete;
		element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action-id=archive]")?.click();
		await element.updateComplete;

		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(element.shadowRoot?.activeElement).toBe(trigger);
	});

	it("updates its actions when the render service signal changes", async () => {
		const menuState = signal<KanbanPopoverMenuState>({
			actions: [{ id: "edit", label: "Edit issue" }],
			label: "Issue actions"
		});
		new ContextProvider(document.body, kanbanPopoverMenuRenderServiceContext, {
			menu: menuState,
			performAction: () => undefined
		});
		const element = document.createElement("kanban-popover-menu");
		document.body.append(element);
		await element.updateComplete;

		menuState.set({
			actions: [{ id: "archive", label: "Archive issue", tone: "danger" }],
			label: "Project actions"
		});
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector(".popover-menu > button")?.textContent).toContain("Project actions");
		expect(element.shadowRoot?.querySelector("[data-action-id=archive]")?.textContent).toContain("Archive issue");
	});

	it("opens the Popover and restores trigger focus after Escape", async () => {
		new ContextProvider(document.body, kanbanPopoverMenuRenderServiceContext, {
			menu: signal<KanbanPopoverMenuState>({
				actions: [{ id: "edit", label: "Edit issue" }],
				label: "Issue actions"
			}),
			performAction: () => undefined
		});
		const element = document.createElement("kanban-popover-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>(".popover-menu > button");
		const menu = element.shadowRoot?.querySelector<HTMLElement>("[role=menu]");
		if (menu === undefined || menu === null) {
			throw new Error("expected a menu");
		}

		installPopoverApi(menu);
		trigger?.click();
		await element.updateComplete;
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");

		menu.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
		await element.updateComplete;
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(element.shadowRoot?.activeElement).toBe(trigger);
	});
});