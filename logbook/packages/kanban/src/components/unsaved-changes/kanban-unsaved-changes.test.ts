import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanUnsavedChangesRenderServiceContext,
	type KanbanUnsavedChangesState
} from "./kanban-unsaved-changes.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanUnsavedChanges", () => {
	it("renders pending changes from its typed render service", async () => {
		new ContextProvider(document.body, kanbanUnsavedChangesRenderServiceContext, {
			unsavedChanges: signal<KanbanUnsavedChangesState>({ pending: true })
		});
		const element = document.createElement("kanban-unsaved-changes");
		document.body.append(element);
		await element.updateComplete;

		const status = element.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.textContent).toContain("Unsaved changes");
		expect(status?.getAttribute("aria-live")).toBe("polite");
	});

	it("removes the feedback when its service signal becomes clean", async () => {
		const unsavedChanges = signal<KanbanUnsavedChangesState>({ pending: true });
		new ContextProvider(document.body, kanbanUnsavedChangesRenderServiceContext, { unsavedChanges });
		const element = document.createElement("kanban-unsaved-changes");
		document.body.append(element);
		await element.updateComplete;

		unsavedChanges.set({ pending: false });
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[role=status]")).toBeNull();
	});
});