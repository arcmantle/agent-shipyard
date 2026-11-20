import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanColumnState = {
	cardCount: number;
	id: string;
	title: string;
};

export type KanbanColumnRenderService = {
	column: { get(): KanbanColumnState };
};

export const kanbanColumnRenderServiceContext = createContext<KanbanColumnRenderService>(
	Symbol("kanban-column-render-service")
);

@customElement("kanban-column")
export class KanbanColumn extends SignalWatcher(LitElement) {
	protected handleCardOpen = (event: Event) => {
		const cardId = (event as CustomEvent<{ cardId?: unknown }>).detail.cardId;
		const column = this.service?.column.get();
		if (column === undefined || typeof cardId !== "string") {
			return;
		}

		event.stopPropagation();
		this.dispatchEvent(new CustomEvent("kanban-column-open-card", {
			bubbles: true,
			composed: true,
			detail: { cardId, columnId: column.id }
		}));
	};

	@consume({ context: kanbanColumnRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanColumnRenderService | undefined;

	public connectedCallback() {
		super.connectedCallback();
		this.addEventListener("kanban-card-open", this.handleCardOpen);
	}

	public disconnectedCallback() {
		this.removeEventListener("kanban-card-open", this.handleCardOpen);
		super.disconnectedCallback();
	}

	protected getCardCountLabel(cardCount: number) {
		return `${cardCount} ${cardCount === 1 ? "issue" : "issues"}`;
	}

	protected render() {
		const column = this.service?.column.get();
		if (column === undefined) {
			return html``;
		}

		return html`
		<section aria-label=${`${column.title} issues`}>
			<header>
				<h2>${column.title}</h2>
				<span>${this.getCardCountLabel(column.cardCount)}</span>
			</header>
			<div class="cards">
				<slot></slot>
			</div>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-112);
	}
	section {
		min-width: var(--size-112);
	}
	header {
		align-items: center;
		display: flex;
		justify-content: space-between;
	}
	h2,
	span {
		margin: var(--size-0);
	}
	h2 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-display);
	}
	span {
		color: var(--color-text-secondary);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	.cards {
		display: grid;
		gap: var(--size-5);
		padding-top: var(--size-6);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-column": KanbanColumn;
	}

	interface HTMLElementEventMap {
		"kanban-column-open-card": CustomEvent<{ cardId: string; columnId: string }>;
	}
}