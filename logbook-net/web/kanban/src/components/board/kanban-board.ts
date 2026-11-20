import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanBoardState = {
	label: string;
};

export type KanbanBoardRenderService = {
	board: { get(): KanbanBoardState };
	openCard: (cardId: string) => void;
};

export const kanbanBoardRenderServiceContext = createContext<KanbanBoardRenderService>(
	Symbol("kanban-board-render-service")
);

@customElement("kanban-board")
export class KanbanBoard extends SignalWatcher(LitElement) {
	@consume({ context: kanbanBoardRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanBoardRenderService | undefined;

	public connectedCallback() {
		super.connectedCallback();
		this.addEventListener("kanban-column-open-card", this.handleCardOpen);
	}

	public disconnectedCallback() {
		this.removeEventListener("kanban-column-open-card", this.handleCardOpen);
		super.disconnectedCallback();
	}

	protected handleCardOpen = (event: Event) => {
		const { cardId, columnId } = (event as CustomEvent<{ cardId?: unknown; columnId?: unknown }>).detail;
		if (typeof cardId !== "string" || typeof columnId !== "string") {
			return;
		}

		event.stopPropagation();
		this.service?.openCard(cardId);
		this.dispatchEvent(new CustomEvent("kanban-board-open-card", {
			bubbles: true,
			composed: true,
			detail: { cardId, columnId }
		}));
	};

	protected render() {
		const board = this.service?.board.get();
		if (board === undefined) {
			return html``;
		}

		return html`
		<section aria-label=${board.label}>
			<slot></slot>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
		width: 100%;
	}
	section {
		box-sizing: border-box;
		max-width: 100%;
		overflow-x: auto;
		scrollbar-gutter: stable;
		scrollbar-color: var(--color-border-subtle) var(--color-surface-canvas);
		scrollbar-width: thin;
		padding: var(--size-9) var(--size-16) var(--size-39);
	}
	section::-webkit-scrollbar {
		height: var(--size-3);
	}
	section::-webkit-scrollbar-thumb {
		background: var(--color-border-subtle);
	}
	section::-webkit-scrollbar-track {
		background: var(--color-surface-canvas);
	}
	slot {
		display: grid;
		gap: var(--size-8);
		grid-auto-columns: minmax(var(--size-112), 1fr);
		grid-auto-flow: column;
	}
	@media (max-width: 47.5rem) {
		section {
			padding-left: var(--size-9);
			padding-right: var(--size-9);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-board": KanbanBoard;
	}

	interface HTMLElementEventMap {
		"kanban-board-open-card": CustomEvent<{ cardId: string; columnId: string }>;
	}
}