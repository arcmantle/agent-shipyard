import { signal } from "@lit-labs/signals";

import type {
	KanbanKeyboardFocusRenderService,
	KanbanKeyboardFocusState
} from "../components/keyboard-focus/kanban-keyboard-focus.js";

const keyboardFocus: KanbanKeyboardFocusState = {
	controls: [
		{ disabled: false, id: "save", kind: "button", label: "Save changes" },
		{ disabled: false, href: "#record-details", id: "details", kind: "link", label: "View details" },
		{
			disabled: false,
			id: "status",
			kind: "select",
			label: "Status",
			options: [ "Todo", "In progress", "Done" ],
			value: "Todo"
		},
		{ disabled: true, id: "archive", kind: "button", label: "Archive issue" }
	],
	description: "Use Tab and Shift+Tab to move through the enabled controls.",
	title: "Record actions",
	typeLabel: "Keyboard navigation"
};

export class KeyboardFocusFixtureRenderService implements KanbanKeyboardFocusRenderService {
	public activationControlId: string | undefined;
	public changedValue: string | undefined;
	public keyboardFocus = signal(keyboardFocus);

	public activate(controlId: string) {
		this.activationControlId = controlId;
	}

	public change(controlId: string, value: string) {
		this.changedValue = value;
		const current = this.keyboardFocus.get();
		this.keyboardFocus.set({
			...current,
			controls: current.controls.map((control) => {
				if (control.id !== controlId || control.kind !== "select") {
					return control;
				}

				return { ...control, value };
			})
		});
	}
}

export function createKeyboardFocusShowcaseFixture(): KeyboardFocusFixtureRenderService {
	return new KeyboardFocusFixtureRenderService();
}
