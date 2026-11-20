import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { map } from "lit/directives/map.js";

export type KanbanFieldEditorOption = {
	label: string;
	value: string;
};

export type KanbanFieldEditorState = {
	disabled: boolean;
	kind: "description" | "select" | "text";
	label: string;
	name: string;
	options?: readonly KanbanFieldEditorOption[];
	placeholder: string;
	required: boolean;
	value: string;
};

export type KanbanFieldEditorRenderService = {
	fieldEditor: { get(): KanbanFieldEditorState };
	setFieldValue: (value: string) => void;
};

export const kanbanFieldEditorRenderServiceContext = createContext<KanbanFieldEditorRenderService>(
	Symbol("kanban-field-editor-render-service")
);

let fieldEditorId = 0;

@customElement("kanban-field-editor")
export class KanbanFieldEditor extends SignalWatcher(LitElement) {
	constructor() {
		super();
		this.controlId = `field-editor-${++fieldEditorId}`;
	}

	@consume({ context: kanbanFieldEditorRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanFieldEditorRenderService | undefined;

	protected controlId: string;

	protected handleChange(event: Event) {
		const control = event.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
		const fieldEditor = this.service?.fieldEditor.get();
		if (fieldEditor === undefined || fieldEditor.disabled) {
			return;
		}

		const detail = { name: fieldEditor.name, value: control.value };
		this.service?.setFieldValue(detail.value);
		this.dispatchEvent(new CustomEvent("kanban-field-editor-change", {
			bubbles: true,
			composed: true,
			detail
		}));
	}

	protected renderControl(fieldEditor: KanbanFieldEditorState) {
		return choose(fieldEditor.kind, [
			["description", () => html`
			<textarea
				?disabled=${fieldEditor.disabled}
				id=${this.controlId}
				name=${fieldEditor.name}
				placeholder=${fieldEditor.placeholder}
				?required=${fieldEditor.required}
				rows="5"
				.value=${fieldEditor.value}
				@change=${this.handleChange}
			></textarea>
			`],
			["select", () => html`
			<select
				?disabled=${fieldEditor.disabled}
				id=${this.controlId}
				name=${fieldEditor.name}
				?required=${fieldEditor.required}
				.value=${fieldEditor.value}
				@change=${this.handleChange}
			>
				${map(fieldEditor.options ?? [], (option) => html`
				<option
					.selected=${option.value === fieldEditor.value}
					value=${option.value}
				>
					${option.label}
				</option>
				`)}
			</select>
			`]
		], () => html`
		<input
			?disabled=${fieldEditor.disabled}
			id=${this.controlId}
			name=${fieldEditor.name}
			placeholder=${fieldEditor.placeholder}
			?required=${fieldEditor.required}
			type="text"
			.value=${fieldEditor.value}
			@change=${this.handleChange}
		>
		`);
	}

	protected render() {
		const fieldEditor = this.service?.fieldEditor.get();
		if (fieldEditor === undefined) {
			return html``;
		}

		return html`
		<div class=${`field-editor field-editor--${fieldEditor.kind}`}>
			<label for=${this.controlId}>${fieldEditor.label}</label>
			${this.renderControl(fieldEditor)}
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.field-editor {
		display: grid;
		gap: var(--size-4);
	}
	.field-editor label {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.field-editor input,
	.field-editor select,
	.field-editor textarea {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		font: inherit;
		line-height: var(--line-height-body);
		padding: var(--size-5) var(--size-6);
		width: 100%;
	}
	.field-editor input {
		font-family: var(--font-family-display);
		font-size: var(--font-size-field);
		font-weight: var(--font-weight-display);
	}
	.field-editor select {
		cursor: pointer;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		min-height: var(--size-19);
	}
	.field-editor textarea {
		font-size: var(--font-size-body);
		min-height: var(--size-60);
		resize: vertical;
	}
	.field-editor input:hover,
	.field-editor select:hover,
	.field-editor textarea:hover {
		border-color: var(--color-text-primary);
	}
	.field-editor input:focus-visible,
	.field-editor select:focus-visible,
	.field-editor textarea:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.field-editor input:disabled,
	.field-editor select:disabled,
	.field-editor textarea:disabled {
		background: var(--color-surface-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-field-editor": KanbanFieldEditor;
	}

	interface HTMLElementEventMap {
		"kanban-field-editor-change": CustomEvent<{ name: string; value: string }>;
	}
}