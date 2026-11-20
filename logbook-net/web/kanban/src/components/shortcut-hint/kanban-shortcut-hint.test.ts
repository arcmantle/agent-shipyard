import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanShortcutHintRenderServiceContext,
	type KanbanShortcutHintState
} from "./kanban-shortcut-hint.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanShortcutHint", () => {
	it("renders shortcut keys from its typed render service", async () => {
		new ContextProvider(document.body, kanbanShortcutHintRenderServiceContext, {
			shortcutHint: signal<KanbanShortcutHintState>({ keys: ["Cmd", "K"] })
		});
		const hint = document.createElement("kanban-shortcut-hint");
		document.body.append(hint);
		await hint.updateComplete;

		const keys = [...(hint.shadowRoot?.querySelectorAll("kbd") ?? [])].map((key) => key.textContent);
		expect(keys).toEqual(["Cmd", "K"]);
	});

	it("updates its accessible shortcut description when its service signal changes", async () => {
		const shortcutHint = signal<KanbanShortcutHintState>({ keys: ["Cmd", "K"] });
		new ContextProvider(document.body, kanbanShortcutHintRenderServiceContext, { shortcutHint });
		const hint = document.createElement("kanban-shortcut-hint");
		document.body.append(hint);
		await hint.updateComplete;

		shortcutHint.set({ keys: ["Shift", "Enter"] });
		await hint.updateComplete;

		const shortcut = hint.shadowRoot?.querySelector<HTMLElement>("[role=group]");
		expect(shortcut?.getAttribute("aria-label")).toBe("Keyboard shortcut: Shift plus Enter");
		expect([...shortcut?.querySelectorAll("kbd") ?? []].map((key) => key.textContent)).toEqual(["Shift", "Enter"]);
	});
});