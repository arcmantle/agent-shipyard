import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanSidebarRenderServiceContext,
	type KanbanSidebarState
} from "./kanban-sidebar.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanSidebar", () => {
	it("updates when the service changes the collapsed signal", async () => {
		const sidebarState = signal<KanbanSidebarState>({
			brandLabel: "agent-issues",
			collapsed: false,
			navigationLabel: "Project and initiative navigation"
		});
		new ContextProvider(document.body, {
			context: kanbanSidebarRenderServiceContext,
			initialValue: {
				sidebar: sidebarState,
				setCollapsed: () => undefined
			}
		});
		const sidebar = document.createElement("kanban-sidebar");
		document.body.append(sidebar);
		await sidebar.updateComplete;

		sidebarState.set({ ...sidebarState.get(), collapsed: true });
		await sidebar.updateComplete;

		expect(sidebar.shadowRoot?.querySelector("aside")?.classList.contains("is-collapsed")).toBe(true);
		expect(sidebar.shadowRoot?.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label")).toBe("Expand sidebar");
		expect(sidebar.shadowRoot?.querySelector(".navigation-content")?.hasAttribute("hidden")).toBe(true);
	});

	it("renders the service-backed navigation state and sends a collapse intent", async () => {
		const sidebarState = signal<KanbanSidebarState>({
			brandLabel: "agent-issues",
			collapsed: false,
			navigationLabel: "Project and initiative navigation"
		});
		const collapsedValues: boolean[] = [];
		new ContextProvider(document.body, {
			context: kanbanSidebarRenderServiceContext,
			initialValue: {
				sidebar: sidebarState,
				setCollapsed: (collapsed) => {
					collapsedValues.push(collapsed);
				}
			}
		});
		const sidebar = document.createElement("kanban-sidebar");
		const events: Array<{ collapsed: boolean }> = [];
		sidebar.addEventListener("kanban-sidebar-collapse", (event) => {
			events.push(event.detail);
		});
		sidebar.innerHTML = "<nav>Current project</nav>";
		document.body.append(sidebar);
		await sidebar.updateComplete;

		expect(sidebar.shadowRoot?.querySelector("aside")?.getAttribute("aria-label")).toBe("Project and initiative navigation");
		expect(sidebar.shadowRoot?.textContent).toContain("agent-issues");
		expect(sidebar.shadowRoot?.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label")).toBe("Collapse sidebar");
		expect(sidebar.shadowRoot?.querySelector("slot")).not.toBeNull();

		sidebar.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();

		expect(collapsedValues).toEqual([true]);
		expect(events).toEqual([{ collapsed: true }]);
	});
});