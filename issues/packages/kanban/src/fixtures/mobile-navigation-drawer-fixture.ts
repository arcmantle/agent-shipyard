import { signal } from "@lit-labs/signals";

import type {
	KanbanMobileNavigationDrawerRenderService,
	KanbanMobileNavigationDrawerState
} from "../components/mobile-navigation-drawer/kanban-mobile-navigation-drawer.js";

const mobileNavigationDrawer: KanbanMobileNavigationDrawerState = {
	brandLabel: "agent-issues",
	groups: [
		{
			items: [
				{ current: true, id: "initiative-editable-kanban-board", label: "Editable Kanban board", reference: "INIT-KANBAN" },
				{ id: "initiative-local-daemon", label: "Local daemon", reference: "INIT-DAEMON" }
			],
			label: "Platform foundations"
		},
		{
			items: [
				{ id: "initiative-planning-models", label: "Planning models", reference: "INIT-PLANS" },
				{ id: "initiative-review-history", label: "Review history", reference: "INIT-HISTORY" }
			],
			label: "Workflow intelligence"
		}
	],
	navigationLabel: "Project and initiative navigation",
	open: true,
	projectLabel: "Agent Issues"
};

export class MobileNavigationDrawerFixtureRenderService implements KanbanMobileNavigationDrawerRenderService {
	public closeCount = 0;
	public mobileNavigationDrawer = signal(mobileNavigationDrawer);
	public openCount = 0;
	public selectedItemIds: string[] = [];
	public projectSelectionCount = 0;

	public close() {
		this.closeCount += 1;
		this.mobileNavigationDrawer.set({ ...this.mobileNavigationDrawer.get(), open: false });
	}

	public open() {
		this.openCount += 1;
		this.mobileNavigationDrawer.set({ ...this.mobileNavigationDrawer.get(), open: true });
	}

	public selectItem(itemId: string) {
		this.selectedItemIds.push(itemId);
	}

	public selectProject() {
		this.projectSelectionCount += 1;
	}
}

export function createMobileNavigationDrawerShowcaseFixture(): MobileNavigationDrawerFixtureRenderService {
	return new MobileNavigationDrawerFixtureRenderService();
}