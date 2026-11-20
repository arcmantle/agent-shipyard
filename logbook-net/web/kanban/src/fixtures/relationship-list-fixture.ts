import { signal } from "@lit-labs/signals";

import type {
	KanbanRelationshipListRenderService,
	KanbanRelationshipListState
} from "../components/relationship-list/kanban-relationship-list.js";

const relationshipList: KanbanRelationshipListState = {
	label: "Issue relationships",
	relationships: [
		{
			id: "relationship-1",
			kind: "Initiative",
			relation: "Parent",
			title: "Editable Kanban board"
		},
		{
			id: "relationship-2",
			kind: "Issue",
			relation: "Blocks",
			title: "Start detached Kanban server"
		},
		{
			id: "relationship-3",
			kind: "PRD",
			relation: "Context",
			title: "Independent Kanban application"
		}
	]
};

export class RelationshipListFixtureRenderService implements KanbanRelationshipListRenderService {
	public relationshipList = signal(relationshipList);
}

export function createRelationshipListShowcaseFixture(): RelationshipListFixtureRenderService {
	return new RelationshipListFixtureRenderService();
}