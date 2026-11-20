import { signal } from "@lit-labs/signals";

import type { KanbanShortcutHintRenderService, KanbanShortcutHintState } from "../components/shortcut-hint/kanban-shortcut-hint.js";

const shortcutHint: KanbanShortcutHintState = {
	keys: ["Cmd", "K"]
};

export class ShortcutHintFixtureRenderService implements KanbanShortcutHintRenderService {
	public shortcutHint = signal(shortcutHint);
}

export function createShortcutHintShowcaseFixture(): ShortcutHintFixtureRenderService {
	return new ShortcutHintFixtureRenderService();
}