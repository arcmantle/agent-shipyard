import { signal } from "@lit-labs/signals";

import type { KanbanTabsRenderService, KanbanTabsState } from "../components/tabs/kanban-tabs.js";

const tabs: KanbanTabsState = {
	activeTabId: "issues",
	tabs: [
		{ id: "issues", label: "Issues" },
		{ id: "plans", label: "Plans" },
		{ id: "prds", label: "PRDs" },
		{ id: "adrs", label: "ADRs" },
		{ id: "debt", label: "Debt" },
		{ id: "graph", label: "Graph" },
		{ id: "activity", label: "Activity" }
	]
};

export class TabsFixtureRenderService implements KanbanTabsRenderService {
	public selectedTabIds: string[] = [];
	public tabs = signal(tabs);

	public selectTab(tabId: string) {
		this.selectedTabIds.push(tabId);
		this.tabs.set({ ...this.tabs.get(), activeTabId: tabId });
	}
}

export function createTabsShowcaseFixture(): TabsFixtureRenderService {
	return new TabsFixtureRenderService();
}