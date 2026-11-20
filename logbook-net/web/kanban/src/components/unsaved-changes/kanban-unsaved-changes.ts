import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { when } from "lit/directives/when.js";

export type KanbanUnsavedChangesState = {
	pending: boolean;
};

export type KanbanUnsavedChangesRenderService = {
	unsavedChanges: { get(): KanbanUnsavedChangesState };
};

export const kanbanUnsavedChangesRenderServiceContext = createContext<KanbanUnsavedChangesRenderService>(
	Symbol("kanban-unsaved-changes-render-service")
);

@customElement("kanban-unsaved-changes")
export class KanbanUnsavedChanges extends SignalWatcher(LitElement) {
	@consume({ context: kanbanUnsavedChangesRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanUnsavedChangesRenderService | undefined;

	protected render() {
		const unsavedChanges = this.service?.unsavedChanges.get();
		return html`
		${when(
			unsavedChanges?.pending,
			() => html`
			<span
				aria-live="polite"
				class="unsaved-changes-indicator"
				role="status"
			>
				<span
					aria-hidden="true"
					class="unsaved-changes-marker"
				></span>
				<span>Unsaved changes</span>
			</span>
			`,
			() => html``
		)}
		`;
	}

	public static styles = css`
	:host {
		display: inline-flex;
	}
	.unsaved-changes-indicator {
		align-items: center;
		background: var(--color-status-blocked-surface);
		border: var(--border-width) solid var(--color-status-blocked-border);
		border-radius: var(--radius-control);
		color: var(--color-status-blocked-text);
		display: inline-flex;
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		gap: var(--size-3);
		line-height: var(--line-height-ui);
		padding: var(--size-2) var(--size-3);
		white-space: nowrap;
	}
	.unsaved-changes-marker {
		background: var(--color-accent-warning);
		border-radius: 50%;
		height: var(--size-3);
		width: var(--size-3);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-unsaved-changes": KanbanUnsavedChanges;
	}
}