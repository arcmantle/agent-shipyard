import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { kanbanFieldDisplayRenderServiceContext } from "./kanban-field-display.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanFieldDisplay", () => {
	it("renders a labelled field value from its typed render service", async () => {
		new ContextProvider(document.body, {
			context: kanbanFieldDisplayRenderServiceContext,
			initialValue: {
				fieldDisplay: signal({
					label: "Title",
					multiline: false,
					value: "Define the board-server write contract"
				})
			}
		});
		const fieldDisplay = document.createElement("kanban-field-display");
		document.body.append(fieldDisplay);
		await fieldDisplay.updateComplete;

		expect(fieldDisplay.shadowRoot?.querySelector("dl")).not.toBeNull();
		expect(fieldDisplay.shadowRoot?.querySelector("dt")?.textContent).toContain("Title");
		expect(fieldDisplay.shadowRoot?.querySelector("dd")?.textContent).toContain("Define the board-server write contract");
	});

	it("updates its multiline description when the render-service signal changes", async () => {
		const fieldDisplayState = signal({
			label: "Description",
			multiline: false,
			value: "Define the board-server write contract"
		});
		new ContextProvider(document.body, {
			context: kanbanFieldDisplayRenderServiceContext,
			initialValue: { fieldDisplay: fieldDisplayState }
		});
		const fieldDisplay = document.createElement("kanban-field-display");
		document.body.append(fieldDisplay);
		await fieldDisplay.updateComplete;

		fieldDisplayState.set({
			label: "Description",
			multiline: true,
			value: "Apply issue updates\nand relationship changes through the active storage driver."
		});
		await fieldDisplay.updateComplete;

		expect(fieldDisplay.shadowRoot?.querySelector(".is-multiline")).not.toBeNull();
		expect(fieldDisplay.shadowRoot?.querySelector("dd")?.textContent).toContain("Apply issue updates\nand relationship changes through the active storage driver.");
	});
});