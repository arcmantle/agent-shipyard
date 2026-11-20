import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanPriorityBadgeRenderServiceContext,
	type KanbanPriorityBadgeState
} from "./kanban-priority-badge.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanPriorityBadge", () => {
	it("renders a high priority from its typed render service", async () => {
		new ContextProvider(document.body, kanbanPriorityBadgeRenderServiceContext, {
			priorityBadge: signal<KanbanPriorityBadgeState>({ label: "High", variant: "high" })
		});
		const badge = document.createElement("kanban-priority-badge");
		document.body.append(badge);
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.textContent).toContain("High");
		expect(status?.classList.contains("is-high")).toBe(true);
	});

	it("updates the accessible priority when its service signal changes", async () => {
		const priorityBadge = signal<KanbanPriorityBadgeState>({ label: "Medium", variant: "medium" });
		new ContextProvider(document.body, kanbanPriorityBadgeRenderServiceContext, { priorityBadge });
		const badge = document.createElement("kanban-priority-badge");
		document.body.append(badge);
		await badge.updateComplete;

		priorityBadge.set({ label: "Low", variant: "low" });
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.textContent).toContain("Low");
		expect(status?.classList.contains("is-low")).toBe(true);
	});

	it.each(["high", "medium", "low"] as const)("renders the %s variant", async (variant) => {
		new ContextProvider(document.body, kanbanPriorityBadgeRenderServiceContext, {
			priorityBadge: signal<KanbanPriorityBadgeState>({ label: `${variant} priority`, variant })
		});
		const badge = document.createElement("kanban-priority-badge");
		document.body.append(badge);
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.classList.contains(`is-${variant}`)).toBe(true);
	});
});
