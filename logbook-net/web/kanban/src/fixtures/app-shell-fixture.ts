import { signal } from "@lit-labs/signals";

import type { KanbanAppShellRenderService, KanbanAppShellState } from "../components/app-shell/kanban-app-shell.js";

const appShell: KanbanAppShellState = {
	mainLabel: "Kanban workspace",
	sidebarCollapsed: false
};

export class AppShellFixtureRenderService implements KanbanAppShellRenderService {
	public appShell = signal(appShell);

	public openMobileNavigation() {}

	public setSidebarCollapsed(collapsed: boolean) {
		this.appShell.set({ ...this.appShell.get(), sidebarCollapsed: collapsed });
	}
}

export function createAppShellShowcaseFixture(): AppShellFixtureRenderService {
	return new AppShellFixtureRenderService();
}