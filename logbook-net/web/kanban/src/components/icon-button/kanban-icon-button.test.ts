import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanIconButtonRenderServiceContext,
	type KanbanIconButtonState
} from "./kanban-icon-button.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanIconButton", () => {
	it("renders typed service data and sends an activation intent", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanIconButtonRenderServiceContext, {
			activate,
			iconButton: signal<KanbanIconButtonState>({
				action: "create",
				disabled: false,
				label: "Create",
				loading: false
			})
		});
		const iconButton = document.createElement("kanban-icon-button");
		document.body.append(iconButton);
		await iconButton.updateComplete;

		const nativeButton = iconButton.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.getAttribute("aria-label")).toBe("Create");
		expect(nativeButton?.getAttribute("title")).toBe("Create");
		expect(nativeButton?.textContent).toContain("+");
		nativeButton?.click();

		expect(activate).toHaveBeenCalledOnce();
	});

	it("updates its accessible label and glyph when its service signal changes", async () => {
		const iconButton = signal<KanbanIconButtonState>({
			action: "create",
			disabled: false,
			label: "Create",
			loading: false
		});
		new ContextProvider(document.body, kanbanIconButtonRenderServiceContext, {
			activate: () => undefined,
			iconButton
		});
		const element = document.createElement("kanban-icon-button");
		document.body.append(element);
		await element.updateComplete;

		iconButton.set({
			action: "close",
			disabled: false,
			label: "Close",
			loading: false
		});
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.getAttribute("aria-label")).toBe("Close");
		expect(nativeButton?.textContent).toContain("×");
	});

	it("renders a loading icon button as busy and inert", async () => {
		new ContextProvider(document.body, kanbanIconButtonRenderServiceContext, {
			activate: () => undefined,
			iconButton: signal<KanbanIconButtonState>({
				action: "overflow",
				disabled: false,
				label: "More actions",
				loading: true
			})
		});
		const element = document.createElement("kanban-icon-button");
		document.body.append(element);
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.disabled).toBe(true);
		expect(nativeButton?.getAttribute("aria-busy")).toBe("true");
		expect(nativeButton?.classList.contains("is-loading")).toBe(true);
	});

	it("renders a disabled icon button without sending an activation intent", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanIconButtonRenderServiceContext, {
			activate,
			iconButton: signal<KanbanIconButtonState>({
				action: "collapse",
				disabled: true,
				label: "Collapse",
				loading: false
			})
		});
		const element = document.createElement("kanban-icon-button");
		document.body.append(element);
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.disabled).toBe(true);
		expect(nativeButton?.textContent).toContain("‹");
		nativeButton?.click();
		expect(activate).not.toHaveBeenCalled();
	});
});
