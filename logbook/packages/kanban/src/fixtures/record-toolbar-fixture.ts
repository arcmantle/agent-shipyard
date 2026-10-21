import { signal } from "@lit-labs/signals";

import type {
	KanbanRecordToolbarRenderService,
	KanbanRecordToolbarState,
	KanbanRecordToolbarView
} from "../components/record-toolbar/kanban-record-toolbar.js";

const recordToolbar: KanbanRecordToolbarState = {
	actions: [
		{ id: "details", label: "Record details" },
		{ id: "create", label: "Create issue" }
	],
	filter: "all",
	filterOptions: [
		{ label: "All issues", value: "all" },
		{ label: "Todo", value: "todo" },
		{ label: "In progress", value: "in-progress" },
		{ label: "Blocked", value: "blocked" }
	],
	query: "",
	reference: "INIT-05",
	title: "Editable Kanban board",
	view: "board"
};

export class RecordToolbarFixtureRenderService implements KanbanRecordToolbarRenderService {
	public actionIds: string[] = [];
	public filterValues: string[] = [];
	public queryValues: string[] = [];
	public recordToolbar = signal(recordToolbar);
	public viewValues: KanbanRecordToolbarView[] = [];

	public performAction(actionId: string) {
		this.actionIds.push(actionId);
	}

	public setFilter(filter: string) {
		this.filterValues.push(filter);
	}

	public setQuery(query: string) {
		this.queryValues.push(query);
	}

	public setView(view: KanbanRecordToolbarView) {
		this.viewValues.push(view);
	}
}

export function createRecordToolbarShowcaseFixture(): RecordToolbarFixtureRenderService {
	return new RecordToolbarFixtureRenderService();
}