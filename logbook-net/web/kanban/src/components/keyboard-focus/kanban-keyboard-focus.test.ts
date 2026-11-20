import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanKeyboardFocusRenderServiceContext,
	type KanbanKeyboardFocusState
} from "./kanban-keyboard-focus.js";

afterEach(() => {
	document.body.replaceChildren();
});

function createKeyboardFocusState(
	overrides: Partial<KanbanKeyboardFocusState> = {}
): KanbanKeyboardFocusState {
	return {
		controls: [
			{ disabled: false, id: "save", kind: "button", label: "Save changes" },
			{ disabled: false, href: "#record-details", id: "details", kind: "link", label: "View details" },
			{
				disabled: false,
				id: "status",
				kind: "select",
				label: "Status",
				options: [ "Todo", "In progress", "Done" ],
				value: "Todo"
			},
			{ disabled: true, id: "archive", kind: "button", label: "Archive issue" }
		],
		description: "Use Tab and Shift+Tab to move through the enabled controls.",
		title: "Record actions",
		typeLabel: "Keyboard navigation",
		...overrides
	};
}

describe("KanbanKeyboardFocus", () => {
	it("renders typed service controls as native focusable actions", async () => {
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate: () => undefined,
			change: () => undefined,
			keyboardFocus: signal(createKeyboardFocusState())
		});
		const element = document.createElement("kanban-keyboard-focus");
		document.body.append(element);
		await element.updateComplete;

		const root = element.shadowRoot;
		expect(root?.querySelector("h2")?.textContent).toBe("Record actions");
		expect(root?.querySelector("p")?.textContent).toContain("Tab and Shift+Tab");
		expect(root?.querySelector("button:not([disabled])")?.textContent).toContain("Save changes");
		expect(root?.querySelector("a")?.getAttribute("href")).toBe("#record-details");
		expect(root?.querySelector("select")?.value).toBe("Todo");
		expect(root?.querySelector("button[disabled]")?.textContent).toContain("Archive issue");
	});

	it("updates its title and selected value when its service signal changes", async () => {
		const keyboardFocus = signal(createKeyboardFocusState());
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate: () => undefined,
			change: () => undefined,
			keyboardFocus
		});
		const element = document.createElement("kanban-keyboard-focus");
		document.body.append(element);
		await element.updateComplete;

		keyboardFocus.set(createKeyboardFocusState({
			controls: [
				{ disabled: false, id: "save", kind: "button", label: "Save changes" },
				{ disabled: false, href: "#record-details", id: "details", kind: "link", label: "View details" },
				{
					disabled: false,
					id: "status",
					kind: "select",
					label: "Status",
					options: [ "Todo", "In progress", "Done" ],
					value: "Done"
				},
				{ disabled: true, id: "archive", kind: "button", label: "Archive issue" }
			],
			title: "Issue actions"
		}));
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("h2")?.textContent).toBe("Issue actions");
		expect(element.shadowRoot?.querySelector("select")?.value).toBe("Done");
	});

	it("sends an activation intent from an enabled control", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate,
			change: () => undefined,
			keyboardFocus: signal(createKeyboardFocusState())
		});
		const element = document.createElement("kanban-keyboard-focus");
		const intent = vi.fn();
		element.addEventListener("kanban-keyboard-focus-activate", intent);
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLButtonElement>("button:not([disabled])")?.click();

		expect(activate).toHaveBeenCalledWith("save");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]?.detail).toEqual({ controlId: "save" });
	});

	it("does not send an activation intent from a disabled control", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate,
			change: () => undefined,
			keyboardFocus: signal(createKeyboardFocusState())
		});
		const element = document.createElement("kanban-keyboard-focus");
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLButtonElement>("button[disabled]")?.click();
		expect(activate).not.toHaveBeenCalled();
	});

	it("sends an activation intent from a link control", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate,
			change: () => undefined,
			keyboardFocus: signal(createKeyboardFocusState())
		});
		const element = document.createElement("kanban-keyboard-focus");
		const intent = vi.fn();
		element.addEventListener("kanban-keyboard-focus-activate", intent);
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLAnchorElement>("a")?.click();

		expect(activate).toHaveBeenCalledWith("details");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]?.detail).toEqual({ controlId: "details" });
	});

	it("does not send an activation intent from a disabled link", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate,
			change: () => undefined,
			keyboardFocus: signal(createKeyboardFocusState({
				controls: [
					{ disabled: true, href: "#record-details", id: "details", kind: "link", label: "View details" }
				]
			}))
		});
		const element = document.createElement("kanban-keyboard-focus");
		document.body.append(element);
		await element.updateComplete;

		const link = element.shadowRoot?.querySelector<HTMLAnchorElement>("a");
		expect(link?.getAttribute("aria-disabled")).toBe("true");
		expect(link?.hasAttribute("href")).toBe(false);
		link?.click();
		expect(activate).not.toHaveBeenCalled();
	});

	it("sends a change intent from a select control", async () => {
		const change = vi.fn();
		new ContextProvider(document.body, kanbanKeyboardFocusRenderServiceContext, {
			activate: () => undefined,
			change,
			keyboardFocus: signal(createKeyboardFocusState())
		});
		const element = document.createElement("kanban-keyboard-focus");
		const intent = vi.fn();
		element.addEventListener("kanban-keyboard-focus-change", intent);
		document.body.append(element);
		await element.updateComplete;

		const select = element.shadowRoot?.querySelector<HTMLSelectElement>("select");
		expect(select).not.toBeNull();
		if (select) {
			select.value = "In progress";
			select.dispatchEvent(new Event("change"));
		}

		expect(change).toHaveBeenCalledWith("status", "In progress");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]?.detail).toEqual({ controlId: "status", value: "In progress" });
	});
});

