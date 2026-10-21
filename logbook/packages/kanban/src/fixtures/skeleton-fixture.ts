import { signal } from "@lit-labs/signals";

import type { KanbanSkeletonRenderService, KanbanSkeletonState } from "../components/skeleton/kanban-skeleton.js";

const skeleton: KanbanSkeletonState = {
	layout: "card"
};

export class SkeletonFixtureRenderService implements KanbanSkeletonRenderService {
	public skeleton = signal(skeleton);
}

export function createSkeletonShowcaseFixture(): SkeletonFixtureRenderService {
	return new SkeletonFixtureRenderService();
}
