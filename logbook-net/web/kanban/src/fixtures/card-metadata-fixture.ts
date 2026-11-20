import { signal } from "@lit-labs/signals";

import type { KanbanCardMetadataRenderService, KanbanCardMetadataState } from "../components/card-metadata/kanban-card-metadata.js";

const cardMetadata: KanbanCardMetadataState = {
	blockerCount: 2,
	due: { label: "Overdue", overdue: true },
	owner: "R. Lee",
	priority: { label: "High", variant: "high" },
	reference: "ISS-322",
	relationshipCount: 1,
	status: { label: "Todo", variant: "default" }
};

export class CardMetadataFixtureRenderService implements KanbanCardMetadataRenderService {
	public cardMetadata = signal(cardMetadata);
}

export function createCardMetadataShowcaseFixture(): CardMetadataFixtureRenderService {
	return new CardMetadataFixtureRenderService();
}