import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanEntityViewRenderServiceContext,
	type KanbanEntityViewState
} from "./kanban-entity-view.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanEntityView", () => {
	it("renders a labelled view shell from its typed render service", async () => {
		new ContextProvider(document.body, kanbanEntityViewRenderServiceContext, {
			activate: () => undefined,
			entityView: signal<KanbanEntityViewState>({
				actionLabel: "New plan",
				description: "Ordered work outlines for the initiative.",
				label: "Plans",
				title: "Delivery plans"
			})
		});
		const element = document.createElement("kanban-entity-view");
		element.innerHTML = "<p>Plan content</p>";
		document.body.append(element);
		await element.updateComplete;

		const view = element.shadowRoot?.querySelector<HTMLElement>("section");
		expect(view?.getAttribute("aria-label")).toBe("Plans view");
		expect(view?.querySelector("h2")?.textContent).toContain("Delivery plans");
		expect(view?.textContent).toContain("Ordered work outlines for the initiative.");
		expect(view?.querySelector("button")?.textContent).toContain("New plan");
		expect(element.textContent).toContain("Plan content");
	});

	it("sends an action intent from its typed render service", async () => {
		const activate = vi.fn();
		new ContextProvider(document.body, kanbanEntityViewRenderServiceContext, {
			activate,
			entityView: signal<KanbanEntityViewState>({
				actionLabel: "New plan",
				description: "Ordered work outlines for the initiative.",
				label: "Plans",
				title: "Delivery plans"
			})
		});
		const element = document.createElement("kanban-entity-view");
		const activateEvent = vi.fn();
		element.addEventListener("kanban-entity-view-activate", activateEvent);
		document.body.append(element);
		await element.updateComplete;

		element.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();

		expect(activate).toHaveBeenCalledOnce();
		expect(activateEvent).toHaveBeenCalledOnce();
	});

	it("updates its view heading when its service signal changes", async () => {
		const entityView = signal<KanbanEntityViewState>({
			actionLabel: "New plan",
			description: "Ordered work outlines for the initiative.",
			label: "Plans",
			title: "Delivery plans"
		});
		new ContextProvider(document.body, kanbanEntityViewRenderServiceContext, {
			activate: () => undefined,
			entityView
		});
		const element = document.createElement("kanban-entity-view");
		document.body.append(element);
		await element.updateComplete;

		entityView.set({
			actionLabel: "Focus graph",
			description: "The delivery chain from requirement to plan, issue, and decision.",
			label: "Graph",
			title: "Initiative relationships"
		});
		await element.updateComplete;

		const view = element.shadowRoot?.querySelector<HTMLElement>("section");
		expect(view?.getAttribute("aria-label")).toBe("Graph view");
		expect(view?.querySelector("h2")?.textContent).toContain("Initiative relationships");
		expect(view?.querySelector("button")?.textContent).toContain("Focus graph");
	});
});