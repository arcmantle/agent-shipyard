import { signal } from "@lit-labs/signals";

import type { KanbanEntityTableRenderService, KanbanEntityTableState } from "../components/entity-table/kanban-entity-table.js";

const entityTable: KanbanEntityTableState = {
	caption: "Plans",
	columns: [
		{ id: "reference", label: "Record" },
		{ id: "summary", label: "Summary" },
		{ id: "scope", label: "Scope" },
		{ id: "status", label: "Status" }
	],
	rows: [
		{
			description: "Local server boundary, mutation handling, and browser recovery.",
			reference: "PLAN-014",
			scope: "4 issues",
			status: "In progress",
			title: "Kanban runtime delivery"
		},
		{
			description: "Column behavior, record overlays, and saved view state.",
			reference: "PLAN-015",
			scope: "3 issues",
			status: "Ready",
			title: "Board interaction polish"
		}
	]
};

export class EntityTableFixtureRenderService implements KanbanEntityTableRenderService {
	public entityTable = signal(entityTable);
	public openedEntityReferences: string[] = [];

	public openEntity(reference: string) {
		this.openedEntityReferences.push(reference);
	}
}

export function createEntityTableShowcaseFixture(): EntityTableFixtureRenderService {
	return new EntityTableFixtureRenderService();
}