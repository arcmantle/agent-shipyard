import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanStatusBadgeRenderServiceContext,
	type KanbanStatusBadgeState
} from "./kanban-status-badge.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanStatusBadge", () => {
	it("renders an active status from its typed render service", async () => {
		new ContextProvider(document.body, kanbanStatusBadgeRenderServiceContext, {
			statusBadge: signal<KanbanStatusBadgeState>({ label: "In progress", variant: "active" })
		});
		const badge = document.createElement("kanban-status-badge");
		document.body.append(badge);
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.textContent).toContain("In progress");
		expect(status?.classList.contains("is-active")).toBe(true);
	});

	it("updates the accessible status when its service signal changes", async () => {
		const statusBadge = signal<KanbanStatusBadgeState>({ label: "Ready", variant: "default" });
		new ContextProvider(document.body, kanbanStatusBadgeRenderServiceContext, { statusBadge });
		const badge = document.createElement("kanban-status-badge");
		document.body.append(badge);
		await badge.updateComplete;

		statusBadge.set({ label: "Blocked", variant: "blocked" });
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.textContent).toContain("Blocked");
		expect(status?.classList.contains("is-blocked")).toBe(true);
	});

	it.each(["active", "blocked", "default", "muted"] as const)("renders the %s variant", async (variant) => {
		new ContextProvider(document.body, kanbanStatusBadgeRenderServiceContext, {
			statusBadge: signal<KanbanStatusBadgeState>({ label: `${variant} status`, variant })
		});
		const badge = document.createElement("kanban-status-badge");
		document.body.append(badge);
		await badge.updateComplete;

		const status = badge.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.classList.contains(`is-${variant}`)).toBe(true);
	});
});