export type KanbanOverviewFixture = {
	initiativeOverlayLabel: string;
	initiativeOverlayText: string;
	mainContent: string;
};

const overviewFixture: KanbanOverviewFixture = {
	initiativeOverlayLabel: "Initiative details",
	initiativeOverlayText: "Editable Kanban board",
	mainContent: "Plan content"
};

export function createOverviewShowcaseFixture(): KanbanOverviewFixture {
	return overviewFixture;
}