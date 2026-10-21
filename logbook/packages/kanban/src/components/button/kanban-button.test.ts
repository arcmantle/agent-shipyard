import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { kanbanButtonRenderServiceContext, type KanbanButtonState } from "./kanban-button.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanButton", () => {
	it("renders typed service data and sends an activation intent", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate,
			button: signal<KanbanButtonState>({ disabled: false, label: "Create issue", loading: false, variant: "primary" })
		});
		const button = document.createElement("kanban-button");
		document.body.append(button);
		await button.updateComplete;

		const nativeButton = button.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.textContent).toContain("Create issue");
		expect(nativeButton?.classList.contains("is-primary")).toBe(true);
		nativeButton?.click();

		expect(activate).toHaveBeenCalledOnce();
	});

	it("updates its label and variant when its service signal changes", async () => {
		const button = signal<KanbanButtonState>({
			disabled: false,
			label: "Create issue",
			loading: false,
			variant: "primary"
		});
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate: () => undefined,
			button
		});
		const element = document.createElement("kanban-button");
		document.body.append(element);
		await element.updateComplete;

		button.set({
			disabled: false,
			label: "Delete issue",
			loading: false,
			variant: "destructive"
		});
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.textContent).toContain("Delete issue");
		expect(nativeButton?.classList.contains("is-destructive")).toBe(true);
		expect(nativeButton?.classList.contains("is-primary")).toBe(false);
	});

	it("renders a loading button as busy and inert", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate,
			button: signal<KanbanButtonState>({
				disabled: false,
				label: "Saving",
				loading: true,
				variant: "primary"
			})
		});
		const element = document.createElement("kanban-button");
		document.body.append(element);
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.disabled).toBe(true);
		expect(nativeButton?.getAttribute("aria-busy")).toBe("true");
		expect(nativeButton?.querySelector(".spinner")).not.toBeNull();
		nativeButton?.click();
		expect(activate).not.toHaveBeenCalled();
	});

	it("renders a disabled button without sending an activation intent", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate,
			button: signal<KanbanButtonState>({
				disabled: true,
				label: "Create issue",
				loading: false,
				variant: "secondary"
			})
		});
		const element = document.createElement("kanban-button");
		document.body.append(element);
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.disabled).toBe(true);
		expect(nativeButton?.classList.contains("is-secondary")).toBe(true);
		nativeButton?.click();
		expect(activate).not.toHaveBeenCalled();
	});

	it("renders a quiet command button from its typed render service", async () => {
		new ContextProvider(document.body, kanbanButtonRenderServiceContext, {
			activate: () => undefined,
			button: signal<KanbanButtonState>({
				disabled: false,
				label: "Cancel",
				loading: false,
				variant: "quiet"
			})
		});
		const element = document.createElement("kanban-button");
		document.body.append(element);
		await element.updateComplete;

		const nativeButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button");
		expect(nativeButton?.textContent).toContain("Cancel");
		expect(nativeButton?.classList.contains("is-quiet")).toBe(true);
		expect(nativeButton?.disabled).toBe(false);
	});
});
