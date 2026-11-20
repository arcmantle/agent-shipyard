import { signal } from "@lit-labs/signals";

import type { KanbanUnsavedChangesRenderService, KanbanUnsavedChangesState } from "../components/unsaved-changes/kanban-unsaved-changes.js";

const unsavedChanges: KanbanUnsavedChangesState = {
	pending: true
};

export class UnsavedChangesFixtureRenderService implements KanbanUnsavedChangesRenderService {
	public unsavedChanges = signal(unsavedChanges);
}

export function createUnsavedChangesShowcaseFixture(): UnsavedChangesFixtureRenderService {
	return new UnsavedChangesFixtureRenderService();
}