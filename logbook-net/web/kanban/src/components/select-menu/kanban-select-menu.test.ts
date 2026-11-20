import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanSelectMenuRenderServiceContext,
	type KanbanSelectMenuState
} from "./kanban-select-menu.js";

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
		hidePopover: {
			value: () => dispatchToggle("closed")
		},
		showPopover: {
			value: () => dispatchToggle("open")
		}
	});
}

describe("KanbanSelectMenu", () => {
	it("renders a labeled Popover listbox from its typed render service", async () => {
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" },
					{ label: "Blocked", value: "Blocked" },
					{ label: "Done", value: "Done" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		const label = element.shadowRoot?.querySelector("label");
		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const listbox = element.shadowRoot?.querySelector<HTMLElement>("[role=listbox]");
		expect(label?.textContent).toContain("Status");
		expect(trigger?.textContent).toContain("Todo");
		expect(trigger?.getAttribute("aria-controls")).toBe(listbox?.id);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(listbox?.getAttribute("popover")).toBe("auto");
		expect([ ...(listbox?.querySelectorAll<HTMLElement>("[role=option]") ?? []) ].map((option) => option.textContent?.trim())).toEqual([
			"Todo",
			"In progress",
			"Blocked",
			"Done"
		]);
	});

	it("sends a select intent when a listbox option is chosen", async () => {
		const select = vi.fn();
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		const intent = vi.fn();
		element.addEventListener("kanban-select-menu-change", intent);
		document.body.append(element);
		await element.updateComplete;

		const option = element.shadowRoot?.querySelector<HTMLElement>("[data-value='In progress']");
		if (option === undefined || option === null) {
			throw new Error("expected an In progress option");
		}

		option.click();
		await element.updateComplete;

		expect(select).toHaveBeenCalledWith("In progress");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				detail: { name: "status", value: "In progress" }
			})
		);
	});

	it("updates the selected option when its service signal changes", async () => {
		const selectMenu = signal<KanbanSelectMenuState>({
			disabled: false,
			label: "Status",
			name: "status",
			options: [
				{ label: "Todo", value: "Todo" },
				{ label: "Done", value: "Done" }
			],
			value: "Todo"
		});
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		selectMenu.set({
			disabled: false,
			label: "Workflow status",
			name: "status",
			options: [
				{ label: "Todo", value: "Todo" },
				{ label: "Done", value: "Done" }
			],
			value: "Done"
		});
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const selectedOption = element.shadowRoot?.querySelector<HTMLElement>("[data-value=Done]");
		expect(element.shadowRoot?.querySelector("label")?.textContent).toContain("Workflow status");
		expect(trigger?.textContent).toContain("Done");
		expect(selectedOption?.getAttribute("aria-selected")).toBe("true");
	});

	it("renders a disabled trigger without sending a select intent", async () => {
		const select = vi.fn();
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: true,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "Done", value: "Done" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		const intent = vi.fn();
		element.addEventListener("kanban-select-menu-change", intent);
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const option = element.shadowRoot?.querySelector<HTMLElement>("[data-value=Done]");
		expect(trigger?.disabled).toBe(true);
		trigger?.click();
		option?.click();
		expect(select).not.toHaveBeenCalled();
		expect(intent).not.toHaveBeenCalled();
	});

	it("opens, moves through, and selects a listbox option with the keyboard", async () => {
		const select = vi.fn();
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const todoOption = element.shadowRoot?.querySelector<HTMLElement>("[data-value=Todo]");
		const inProgressOption = element.shadowRoot?.querySelector<HTMLElement>("[data-value='In progress']");
		const listbox = element.shadowRoot?.querySelector<HTMLElement>("[role=listbox]");
		if (listbox === undefined || listbox === null) {
			throw new Error("expected a listbox");
		}

		installPopoverApi(listbox);
		trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
		await element.updateComplete;

		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(element.shadowRoot?.activeElement).toBe(todoOption);
		todoOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
		expect(element.shadowRoot?.activeElement).toBe(inProgressOption);
		inProgressOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
		await element.updateComplete;

		expect(select).toHaveBeenCalledWith("In progress");
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
	});

	it("opens with focus on the final option when ArrowUp is pressed", async () => {
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "In progress", value: "In progress" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const inProgressOption = element.shadowRoot?.querySelector<HTMLElement>("[data-value='In progress']");
		const listbox = element.shadowRoot?.querySelector<HTMLElement>("[role=listbox]");
		if (listbox === undefined || listbox === null) {
			throw new Error("expected a listbox");
		}

		installPopoverApi(listbox);
		trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
		await element.updateComplete;

		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(element.shadowRoot?.activeElement).toBe(inProgressOption);
	});

	it("dismisses the listbox and restores trigger focus when Escape is pressed", async () => {
		new ContextProvider(document.body, kanbanSelectMenuRenderServiceContext, {
			select: () => undefined,
			selectMenu: signal<KanbanSelectMenuState>({
				disabled: false,
				label: "Status",
				name: "status",
				options: [
					{ label: "Todo", value: "Todo" },
					{ label: "Done", value: "Done" }
				],
				value: "Todo"
			})
		});
		const element = document.createElement("kanban-select-menu");
		document.body.append(element);
		await element.updateComplete;

		const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		const option = element.shadowRoot?.querySelector<HTMLElement>("[data-value=Todo]");
		const listbox = element.shadowRoot?.querySelector<HTMLElement>("[role=listbox]");
		if (listbox === undefined || listbox === null) {
			throw new Error("expected a listbox");
		}

		installPopoverApi(listbox);
		trigger?.click();
		await element.updateComplete;
		option?.focus();
		option?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
		await element.updateComplete;

		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(element.shadowRoot?.activeElement).toBe(trigger);
	});
});
