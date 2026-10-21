import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import { kanbanTabsRenderServiceContext, type KanbanTabsState } from "./kanban-tabs.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanTabs", () => {
	it("renders the active tab and sends a selection intent", async () => {
		const tabsState = signal<KanbanTabsState>({
			activeTabId: "issues",
			tabs: [
				{ id: "issues", label: "Issues" },
				{ id: "plans", label: "Plans" }
			]
		});
		const selectTab = vi.fn((tabId: string) => {
			tabsState.set({ ...tabsState.get(), activeTabId: tabId });
		});
		new ContextProvider(document.body, {
			context: kanbanTabsRenderServiceContext,
			initialValue: {
				selectTab,
				tabs: tabsState
			}
		});
		const tabs = document.createElement("kanban-tabs");
		const events: Array<{ tabId: string }> = [];
		tabs.addEventListener("kanban-tabs-select", (event) => {
			events.push(event.detail);
		});
		document.body.append(tabs);
		await tabs.updateComplete;

		const issueTab = tabs.shadowRoot?.querySelector<HTMLButtonElement>("[data-tab-id=issues][aria-current=page]");
		expect(issueTab?.textContent).toContain("Issues");
		tabs.shadowRoot?.querySelector<HTMLButtonElement>("[data-tab-id=plans]")?.click();
		await tabs.updateComplete;

		expect(selectTab).toHaveBeenCalledWith("plans");
		expect(events).toEqual([{ tabId: "plans" }]);
		expect(tabs.shadowRoot?.querySelector("[data-tab-id=issues]")?.getAttribute("aria-current")).toBe("false");
		expect(tabs.shadowRoot?.querySelector("[data-tab-id=plans]")?.getAttribute("aria-current")).toBe("page");
	});
});