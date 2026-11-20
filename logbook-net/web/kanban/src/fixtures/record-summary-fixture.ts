import { signal } from "@lit-labs/signals";

import type { KanbanRecordSummaryRenderService, KanbanRecordSummaryState } from "../components/record-summary/kanban-record-summary.js";

const recordSummary: KanbanRecordSummaryState = {
	metadata: "Issue",
	owner: "R. Lee",
	reference: "ISS-322",
	title: "Define the board-server write contract"
};

export class RecordSummaryFixtureRenderService implements KanbanRecordSummaryRenderService {
	public recordSummary = signal(recordSummary);
}

export function createRecordSummaryShowcaseFixture(): RecordSummaryFixtureRenderService {
	return new RecordSummaryFixtureRenderService();
}