import { signal } from "@lit-labs/signals";

import type { KanbanSidebarRenderService, KanbanSidebarState } from "../components/sidebar/kanban-sidebar.js";

const sidebar: KanbanSidebarState = {
	brandLabel: "agent-issues",
	collapsed: false,
	navigationLabel: "Project and initiative navigation"
};

export class SidebarFixtureRenderService implements KanbanSidebarRenderService {
	public collapsedStates: boolean[] = [];
	public sidebar = signal(sidebar);

	public setCollapsed(collapsed: boolean) {
		this.collapsedStates.push(collapsed);
		this.sidebar.set({ ...this.sidebar.get(), collapsed });
	}
}

export function createSidebarShowcaseFixture(): SidebarFixtureRenderService {
	return new SidebarFixtureRenderService();
}