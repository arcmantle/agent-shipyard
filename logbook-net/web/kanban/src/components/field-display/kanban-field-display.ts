import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanFieldDisplayState = {
	label: string;
	multiline: boolean;
	value: string;
};

export type KanbanFieldDisplayRenderService = {
	fieldDisplay: { get(): KanbanFieldDisplayState };
};

export const kanbanFieldDisplayRenderServiceContext = createContext<KanbanFieldDisplayRenderService>(
	Symbol("kanban-field-display-render-service")
);

@customElement("kanban-field-display")
export class KanbanFieldDisplay extends SignalWatcher(LitElement) {
	@consume({ context: kanbanFieldDisplayRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanFieldDisplayRenderService | undefined;

	protected render() {
		const fieldDisplay = this.service?.fieldDisplay.get();
		if (fieldDisplay === undefined) {
			return html``;
		}

		return html`
		<dl class=${classMap({ "field-display": true, "is-multiline": fieldDisplay.multiline })}>
			<dt>${fieldDisplay.label}</dt>
			<dd>${fieldDisplay.value}</dd>
		</dl>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.field-display {
		margin: var(--size-0);
	}
	dt {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		margin-bottom: var(--size-4);
		text-transform: uppercase;
	}
	dd {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-field);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		overflow-wrap: anywhere;
		padding: var(--size-5) var(--size-6);
	}
	.is-multiline dd {
		font-family: var(--font-family-ui);
		font-size: var(--font-size-body);
		font-weight: var(--font-weight-regular);
		min-height: var(--size-50);
		white-space: pre-wrap;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-field-display": KanbanFieldDisplay;
	}
}