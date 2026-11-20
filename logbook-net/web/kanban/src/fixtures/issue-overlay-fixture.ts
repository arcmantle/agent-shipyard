import { signal } from "@lit-labs/signals";

import type { KanbanIssueOverlayRenderService, KanbanIssueOverlayState } from "../components/issue-overlay/kanban-issue-overlay.js";

const issueOverlay: KanbanIssueOverlayState = {
	detail: "2 blockers",
	label: "Issue details",
	open: false,
	reference: "ISS-322",
	title: "Define the board-server write contract"
};

export class IssueOverlayFixtureRenderService implements KanbanIssueOverlayRenderService {
	public issueOverlay = signal(issueOverlay);

	public open() {
		this.issueOverlay.set({ ...this.issueOverlay.get(), open: true });
	}

	public close() {
		this.issueOverlay.set({ ...this.issueOverlay.get(), open: false });
	}
}

export function createIssueOverlayShowcaseFixture(): IssueOverlayFixtureRenderService {
	return new IssueOverlayFixtureRenderService();
}