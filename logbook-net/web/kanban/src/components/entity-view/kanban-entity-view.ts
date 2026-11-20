import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanEntityViewState = {
	actionLabel: string;
	description: string;
	label: string;
	title: string;
};

export type KanbanEntityViewRenderService = {
	activate: () => void;
	entityView: { get(): KanbanEntityViewState };
};

export const kanbanEntityViewRenderServiceContext = createContext<KanbanEntityViewRenderService>(
	Symbol("kanban-entity-view-render-service")
);

@customElement("kanban-entity-view")
export class KanbanEntityView extends SignalWatcher(LitElement) {
	@consume({ context: kanbanEntityViewRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanEntityViewRenderService | undefined;

	protected handleActivate() {
		this.service?.activate();
		this.dispatchEvent(new CustomEvent("kanban-entity-view-activate", { bubbles: true, composed: true }));
	}

	protected render() {
		const entityView = this.service?.entityView.get();
		if (entityView === undefined) {
			return html``;
		}

		return html`
		<section aria-label=${`${entityView.label} view`}>
			<header>
				<div>
					<span class="type-label">${entityView.label}</span>
					<h2>${entityView.title}</h2>
					<p>${entityView.description}</p>
				</div>
				<button
					@click=${this.handleActivate}
					type="button"
				>
					${entityView.actionLabel}
				</button>
			</header>
			<slot></slot>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	section {
		padding: var(--size-12) var(--size-16) var(--size-16);
	}
	header {
		align-items: flex-start;
		display: flex;
		gap: var(--size-10);
		justify-content: space-between;
		margin-bottom: var(--size-10);
	}
	.type-label {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	h2 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-title);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-tight);
		margin: var(--size-2) var(--size-0);
	}
	p {
		color: var(--color-text-secondary);
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		max-width: 64ch;
	}
	button {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		flex: 0 0 auto;
		font-family: var(--font-family-ui);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		padding: var(--size-5) var(--size-6);
	}
	button:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	@media (max-width: 47.5rem) {
		section {
			padding: var(--size-9);
		}
		header {
			display: grid;
		}
		button {
			justify-self: start;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-entity-view": KanbanEntityView;
	}

	interface HTMLElementEventMap {
		"kanban-entity-view-activate": CustomEvent;
	}
}