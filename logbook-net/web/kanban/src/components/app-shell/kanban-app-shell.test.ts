import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanAppShellRenderServiceContext,
	type KanbanAppShellState
} from "./kanban-app-shell.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanAppShell", () => {
	it("projects its layout slots from its typed render service", async () => {
		new ContextProvider(document.body, kanbanAppShellRenderServiceContext, {
			appShell: signal<KanbanAppShellState>({
				mainLabel: "Kanban workspace",
				sidebarCollapsed: false
			}),
			openMobileNavigation: () => undefined,
			setSidebarCollapsed: () => undefined
		});
		const element = document.createElement("kanban-app-shell");
		const sidebar = document.createElement("aside");
		sidebar.slot = "sidebar";
		const header = document.createElement("header");
		header.slot = "header";
		const tabs = document.createElement("nav");
		tabs.slot = "tabs";
		const content = document.createElement("section");
		content.slot = "content";
		const drawer = document.createElement("aside");
		drawer.slot = "mobile-navigation-drawer";
		element.append(sidebar, header, tabs, content, drawer);
		document.body.append(element);
		await element.updateComplete;

		const shell = element.shadowRoot?.querySelector<HTMLElement>(".app-shell");
		expect(shell?.classList.contains("is-sidebar-collapsed")).toBe(false);
		expect(element.shadowRoot?.querySelector("main")?.getAttribute("aria-label")).toBe("Kanban workspace");
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=sidebar]")?.assignedElements()).toEqual([sidebar]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=header]")?.assignedElements()).toEqual([header]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=tabs]")?.assignedElements()).toEqual([tabs]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=content]")?.assignedElements()).toEqual([content]);
		expect(element.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=mobile-navigation-drawer]")?.assignedElements()).toEqual([drawer]);
	});

	it("coordinates sidebar collapse through its render service", async () => {
		const appShell = signal<KanbanAppShellState>({
			mainLabel: "Kanban workspace",
			sidebarCollapsed: false
		});
		const setSidebarCollapsed = (collapsed: boolean) => {
			appShell.set({ ...appShell.get(), sidebarCollapsed: collapsed });
		};
		new ContextProvider(document.body, kanbanAppShellRenderServiceContext, {
			appShell,
			openMobileNavigation: () => undefined,
			setSidebarCollapsed
		});
		const element = document.createElement("kanban-app-shell");
		const sidebar = document.createElement("aside");
		sidebar.slot = "sidebar";
		element.append(sidebar);
		document.body.append(element);
		await element.updateComplete;

		sidebar.dispatchEvent(new CustomEvent("kanban-sidebar-collapse", {
			bubbles: true,
			composed: true,
			detail: { collapsed: true }
		}));
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector(".app-shell")?.classList.contains("is-sidebar-collapsed")).toBe(true);
	});

	it.each([
		["kanban-header-open-initiative", "kanban-app-shell-open-initiative", { reference: "INIT_001" }],
		["kanban-entity-view-open-issue", "kanban-app-shell-open-issue", { reference: "ISS_001" }]
	])("forwards %s as %s", async (sourceEvent, shellEvent, detail) => {
		new ContextProvider(document.body, kanbanAppShellRenderServiceContext, {
			appShell: signal<KanbanAppShellState>({
				mainLabel: "Kanban workspace",
				sidebarCollapsed: false
			}),
			openMobileNavigation: () => undefined,
			setSidebarCollapsed: () => undefined
		});
		const element = document.createElement("kanban-app-shell");
		const content = document.createElement("section");
		content.slot = "content";
		element.append(content);
		const forwardedIntent = vi.fn();
		element.addEventListener(shellEvent, forwardedIntent);
		document.body.append(element);
		await element.updateComplete;

		content.dispatchEvent(new CustomEvent(sourceEvent, { bubbles: true, composed: true, detail }));

		expect(forwardedIntent).toHaveBeenCalledOnce();
		expect((forwardedIntent.mock.calls[0]?.[0] as CustomEvent).detail).toEqual(detail);
	});

	it("opens mobile navigation through its render service and semantic event", async () => {
		const openMobileNavigation = vi.fn();
		new ContextProvider(document.body, kanbanAppShellRenderServiceContext, {
			appShell: signal<KanbanAppShellState>({
				mainLabel: "Kanban workspace",
				sidebarCollapsed: false
			}),
			openMobileNavigation,
			setSidebarCollapsed: () => undefined
		});
		const element = document.createElement("kanban-app-shell");
		const header = document.createElement("header");
		header.slot = "header";
		element.append(header);
		const openIntent = vi.fn();
		element.addEventListener("kanban-app-shell-open-mobile-navigation", openIntent);
		document.body.append(element);
		await element.updateComplete;

		header.dispatchEvent(new CustomEvent("kanban-header-open-mobile-navigation", { bubbles: true, composed: true }));

		expect(openMobileNavigation).toHaveBeenCalledOnce();
		expect(openIntent).toHaveBeenCalledOnce();
	});
});