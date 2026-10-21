import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanMobileNavigationDrawerRenderServiceContext,
	type KanbanMobileNavigationDrawerState
} from "./kanban-mobile-navigation-drawer.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanMobileNavigationDrawer", () => {
	it("renders an open drawer from its typed render service", async () => {
		new ContextProvider(document.body, kanbanMobileNavigationDrawerRenderServiceContext, {
			close: () => undefined,
			mobileNavigationDrawer: signal<KanbanMobileNavigationDrawerState>({
				brandLabel: "agent-issues",
				groups: [{
					items: [{ current: true, id: "initiative-kanban", label: "Editable Kanban board", reference: "INIT-KANBAN" }],
					label: "Platform foundations"
				}],
				navigationLabel: "Project and initiative navigation",
				open: true,
				projectLabel: "Agent Issues"
			}),
			open: () => undefined,
			selectItem: () => undefined,
			selectProject: () => undefined
		});
		const drawer = document.createElement("kanban-mobile-navigation-drawer");
		document.body.append(drawer);
		await drawer.updateComplete;

		const navigation = drawer.shadowRoot?.querySelector<HTMLElement>("nav");
		expect(navigation?.getAttribute("aria-label")).toBe("Project and initiative navigation");
		expect(drawer.shadowRoot?.querySelector("aside")?.hasAttribute("inert")).toBe(false);
		expect(drawer.shadowRoot?.textContent).toContain("Editable Kanban board");
		expect(drawer.shadowRoot?.querySelector("button[aria-current=page]")?.textContent).toContain("INIT-KANBAN");
	});

	it("sends a close intent from the scrim and Escape key", async () => {
		const close = vi.fn();
		new ContextProvider(document.body, kanbanMobileNavigationDrawerRenderServiceContext, {
			close,
			mobileNavigationDrawer: signal<KanbanMobileNavigationDrawerState>({
				brandLabel: "agent-issues",
				groups: [],
				navigationLabel: "Project and initiative navigation",
				open: true,
				projectLabel: "Agent Issues"
			}),
			open: () => undefined,
			selectItem: () => undefined,
			selectProject: () => undefined
		});
		const drawer = document.createElement("kanban-mobile-navigation-drawer");
		const closeEvent = vi.fn();
		drawer.addEventListener("kanban-mobile-navigation-drawer-close", closeEvent);
		document.body.append(drawer);
		await drawer.updateComplete;

		drawer.shadowRoot?.querySelector<HTMLButtonElement>(".scrim")?.click();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

		expect(close).toHaveBeenCalledTimes(2);
		expect(closeEvent).toHaveBeenCalledTimes(2);
	});

	it("sends project and item selection through its render service and semantic events", async () => {
		const selectItem = vi.fn();
		const selectProject = vi.fn();
		new ContextProvider(document.body, kanbanMobileNavigationDrawerRenderServiceContext, {
			close: () => undefined,
			mobileNavigationDrawer: signal<KanbanMobileNavigationDrawerState>({
				brandLabel: "agent-issues",
				groups: [{
					items: [{ id: "initiative-kanban", label: "Editable Kanban board", reference: "INIT-KANBAN" }],
					label: "Platform foundations"
				}],
				navigationLabel: "Project and initiative navigation",
				open: true,
				projectLabel: "Agent Issues"
			}),
			open: () => undefined,
			selectItem,
			selectProject
		});
		const drawer = document.createElement("kanban-mobile-navigation-drawer");
		const itemEvent = vi.fn();
		const projectEvent = vi.fn();
		drawer.addEventListener("kanban-mobile-navigation-drawer-select-item", itemEvent);
		drawer.addEventListener("kanban-mobile-navigation-drawer-select-project", projectEvent);
		document.body.append(drawer);
		await drawer.updateComplete;

		drawer.shadowRoot?.querySelector<HTMLButtonElement>(".project button")?.click();
		drawer.shadowRoot?.querySelector<HTMLButtonElement>(".navigation-item")?.click();

		expect(selectProject).toHaveBeenCalledOnce();
		expect(projectEvent).toHaveBeenCalledOnce();
		expect(selectItem).toHaveBeenCalledWith("initiative-kanban");
		expect(itemEvent.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ detail: { itemId: "initiative-kanban" } })
		);
	});

	it("hides and inerts the drawer when its service closes it", async () => {
		const mobileNavigationDrawer = signal<KanbanMobileNavigationDrawerState>({
			brandLabel: "agent-issues",
			groups: [],
			navigationLabel: "Project and initiative navigation",
			open: true,
			projectLabel: "Agent Issues"
		});
		new ContextProvider(document.body, kanbanMobileNavigationDrawerRenderServiceContext, {
			close: () => undefined,
			mobileNavigationDrawer,
			open: () => undefined,
			selectItem: () => undefined,
			selectProject: () => undefined
		});
		const drawer = document.createElement("kanban-mobile-navigation-drawer");
		document.body.append(drawer);
		await drawer.updateComplete;

		mobileNavigationDrawer.set({ ...mobileNavigationDrawer.get(), open: false });
		await drawer.updateComplete;

		expect(drawer.shadowRoot?.querySelector("div")?.hidden).toBe(true);
		expect(drawer.shadowRoot?.querySelector("aside")?.hasAttribute("inert")).toBe(true);
	});

	it("does not intercept Escape while the drawer is closed", async () => {
		const close = vi.fn();
		new ContextProvider(document.body, kanbanMobileNavigationDrawerRenderServiceContext, {
			close,
			mobileNavigationDrawer: signal<KanbanMobileNavigationDrawerState>({
				brandLabel: "agent-issues",
				groups: [],
				navigationLabel: "Project and initiative navigation",
				open: false,
				projectLabel: "Agent Issues"
			}),
			open: () => undefined,
			selectItem: () => undefined,
			selectProject: () => undefined
		});
		const drawer = document.createElement("kanban-mobile-navigation-drawer");
		document.body.append(drawer);
		await drawer.updateComplete;

		const escape = new KeyboardEvent("keydown", { cancelable: true, key: "Escape" });
		document.dispatchEvent(escape);

		expect(escape.defaultPrevented).toBe(false);
		expect(close).not.toHaveBeenCalled();
	});
});
