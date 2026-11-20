import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanFieldEditorRenderServiceContext,
	type KanbanFieldEditorState
} from "./kanban-field-editor.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanFieldEditor", () => {
	it("renders an associated required text field from its typed render service", async () => {
		new ContextProvider(document.body, kanbanFieldEditorRenderServiceContext, {
			fieldEditor: signal<KanbanFieldEditorState>({
				disabled: false,
				kind: "text",
				label: "Title",
				name: "title",
				placeholder: "Enter a title",
				required: true,
				value: "Define the board-server write contract"
			}),
			setFieldValue: () => undefined
		});
		const fieldEditor = document.createElement("kanban-field-editor");
		document.body.append(fieldEditor);
		await fieldEditor.updateComplete;

		const input = fieldEditor.shadowRoot?.querySelector<HTMLInputElement>("input");
		const label = fieldEditor.shadowRoot?.querySelector<HTMLLabelElement>("label");
		expect(label?.textContent).toContain("Title");
		expect(label?.htmlFor).toBe(input?.id);
		expect(input?.name).toBe("title");
		expect(input?.placeholder).toBe("Enter a title");
		expect(input?.required).toBe(true);
		expect(input?.value).toBe("Define the board-server write contract");
	});

	it("renders select and disabled description controls from service state", async () => {
		const fieldEditorState = signal<KanbanFieldEditorState>({
			disabled: false,
			kind: "select",
			label: "Status",
			name: "status",
			options: [
				{ label: "Todo", value: "todo" },
				{ label: "In progress", value: "in-progress" }
			],
			placeholder: "",
			required: false,
			value: "in-progress"
		});
		new ContextProvider(document.body, kanbanFieldEditorRenderServiceContext, {
			fieldEditor: fieldEditorState,
			setFieldValue: () => undefined
		});
		const fieldEditor = document.createElement("kanban-field-editor");
		document.body.append(fieldEditor);
		await fieldEditor.updateComplete;

		const select = fieldEditor.shadowRoot?.querySelector<HTMLSelectElement>("select");
		expect(select?.value).toBe("in-progress");
		expect(select?.options).toHaveLength(2);

		fieldEditorState.set({
			disabled: true,
			kind: "description",
			label: "Description",
			name: "description",
			placeholder: "Describe the work",
			required: false,
			value: "Document the write contract."
		});
		await fieldEditor.updateComplete;

		const textarea = fieldEditor.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
		expect(textarea?.disabled).toBe(true);
		expect(textarea?.placeholder).toBe("Describe the work");
		expect(textarea?.value).toBe("Document the write contract.");
	});

	it("sends a field change intent through its render service and semantic event", async () => {
		const fieldValues: string[] = [];
		new ContextProvider(document.body, kanbanFieldEditorRenderServiceContext, {
			fieldEditor: signal<KanbanFieldEditorState>({
				disabled: false,
				kind: "text",
				label: "Title",
				name: "title",
				placeholder: "Enter a title",
				required: true,
				value: "Define the board-server write contract"
			}),
			setFieldValue: (value) => fieldValues.push(value)
		});
		const fieldEditor = document.createElement("kanban-field-editor");
		const events: Array<{ name: string; value: string }> = [];
		fieldEditor.addEventListener("kanban-field-editor-change", (event) => events.push(event.detail));
		document.body.append(fieldEditor);
		await fieldEditor.updateComplete;

		const input = fieldEditor.shadowRoot?.querySelector<HTMLInputElement>("input");
		if (input === null || input === undefined) {
			throw new Error("The Field editor text input did not render.");
		}
		input.value = "Document the board-server write contract";
		input.dispatchEvent(new Event("change", { bubbles: true }));

		expect(fieldValues).toEqual(["Document the board-server write contract"]);
		expect(events).toEqual([{ name: "title", value: "Document the board-server write contract" }]);
	});
});