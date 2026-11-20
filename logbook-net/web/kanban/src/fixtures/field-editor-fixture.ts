import { signal } from "@lit-labs/signals";

import type { KanbanFieldEditorRenderService, KanbanFieldEditorState } from "../components/field-editor/kanban-field-editor.js";

const fieldEditor: KanbanFieldEditorState = {
	disabled: false,
	kind: "text",
	label: "Title",
	name: "title",
	placeholder: "Enter a title",
	required: true,
	value: "Define the board-server write contract"
};

export class FieldEditorFixtureRenderService implements KanbanFieldEditorRenderService {
	public fieldEditor = signal(fieldEditor);
	public fieldValues: string[] = [];

	public setFieldValue(value: string) {
		this.fieldValues.push(value);
		this.fieldEditor.set({
			...this.fieldEditor.get(),
			value
		});
	}
}

export function createFieldEditorShowcaseFixture(): FieldEditorFixtureRenderService {
	return new FieldEditorFixtureRenderService();
}