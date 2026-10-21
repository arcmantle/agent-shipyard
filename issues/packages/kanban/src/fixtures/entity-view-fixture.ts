import { signal } from "@lit-labs/signals";

import type { KanbanEntityViewRenderService, KanbanEntityViewState } from "../components/entity-view/kanban-entity-view.js";

const entityView: KanbanEntityViewState = {
	actionLabel: "New plan",
	description: "Ordered work outlines for the initiative.",
	label: "Plans",
	title: "Delivery plans"
};

export class EntityViewFixtureRenderService implements KanbanEntityViewRenderService {
	public activationCount = 0;
	public entityView = signal(entityView);

	public activate() {
		this.activationCount += 1;
	}
}

export function createEntityViewShowcaseFixture(): EntityViewFixtureRenderService {
	return new EntityViewFixtureRenderService();
}