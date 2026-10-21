import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { when } from "lit/directives/when.js";

export type KanbanCardBadge = {
	label: string;
	variant: "active" | "blocked" | "default" | "high" | "low" | "medium" | "muted";
};

export type KanbanCardDue = {
	label: string;
	overdue: boolean;
};

export type KanbanCardState = {
	blockerCount: number;
	due: KanbanCardDue;
	id: string;
	isBlocked: boolean;
	owner: string;
	priority: KanbanCardBadge;
	reference: string;
	relationshipCount: number;
	status: KanbanCardBadge;
	title: string;
};

export type KanbanCardRenderService = {
	card: { get(): KanbanCardState };
	openCard: (cardId: string) => void;
};

export const kanbanCardRenderServiceContext = createContext<KanbanCardRenderService>(Symbol("kanban-card-render-service"));

@customElement("kanban-card")
export class KanbanCard extends SignalWatcher(LitElement) {
	@consume({ context: kanbanCardRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanCardRenderService | undefined;

	protected getCountLabel(count: number, noun: string) {
		return `${count} ${noun}${count === 1 ? "" : "s"}`;
	}

	protected handleOpenCard() {
		const card = this.service?.card.get();
		if (card === undefined) {
			return;
		}

		this.service?.openCard(card.id);
		this.dispatchEvent(new CustomEvent("kanban-card-open", {
			bubbles: true,
			composed: true,
			detail: { cardId: card.id }
		}));
	}

	protected render() {
		const card = this.service?.card.get();
		if (card === undefined) {
			return html``;
		}

		return html`
		<button
			@click=${this.handleOpenCard}
			aria-label=${`Open ${card.reference}: ${card.title}`}
			class=${classMap({ "is-blocked": card.isBlocked, card: true })}
			type="button"
		>
			${when(
				card.isBlocked,
				() => html`<span class="blocked-label">Waiting on daemon</span>`
			)}
			<h3>${card.title}</h3>
			<div class="metadata-header">
				<span class="reference">${card.reference}</span>
				<div class="badges">
					<span class=${classMap({ "is-blocked": card.status.variant === "blocked", "is-default": card.status.variant === "default", "status-badge": true })}>
						${card.status.label}
					</span>
					<span class=${classMap({ "is-high": card.priority.variant === "high", "is-low": card.priority.variant === "low", "is-medium": card.priority.variant === "medium", "priority-badge": true })}>
						${card.priority.label}
					</span>
				</div>
			</div>
			<dl>
				<div>
					<dt>Owner</dt>
					<dd>${card.owner}</dd>
				</div>
				<div>
					<dt>Due</dt>
					<dd class=${classMap({ "is-overdue": card.due.overdue })}>${card.due.label}</dd>
				</div>
				<div>
					<dt>Blockers</dt>
					<dd class=${classMap({ "is-blocked": card.blockerCount > 0 })}>${this.getCountLabel(card.blockerCount, "blocker")}</dd>
				</div>
				<div>
					<dt>Relationships</dt>
					<dd>${this.getCountLabel(card.relationshipCount, "relationship")}</dd>
				</div>
			</dl>
		</button>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	button {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		box-shadow: var(--shadow-card);
		color: var(--color-text-primary);
		cursor: pointer;
		display: grid;
		font: inherit;
		gap: var(--size-5);
		padding: var(--size-7);
		text-align: start;
		width: 100%;
	}
	button:hover,
	button:focus-visible {
		border-color: var(--color-text-primary);
		box-shadow: var(--shadow-card-hover);
		outline: none;
	}
	button.is-blocked {
		background: var(--color-status-blocked-surface);
		border-color: var(--color-status-blocked-border);
	}
	.blocked-label {
		background: var(--color-status-blocked-label);
		color: var(--color-status-blocked-text);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		justify-self: start;
		padding: var(--size-2) var(--size-3);
		text-transform: uppercase;
	}
	h3 {
		font-family: var(--font-family-display);
		font-size: var(--font-size-card-title);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-ui);
		margin: var(--size-0);
		overflow-wrap: anywhere;
	}
	.metadata-header,
	.badges {
		align-items: center;
		display: flex;
		gap: var(--size-4);
	}
	.metadata-header {
		justify-content: space-between;
	}
	.reference {
		color: var(--color-text-secondary);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	.badges {
		flex-wrap: wrap;
		justify-content: end;
	}
	.status-badge,
	.priority-badge {
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		padding: var(--size-2) var(--size-3);
		white-space: nowrap;
	}
	.status-badge {
		background: var(--color-surface-subtle);
		color: var(--color-text-secondary);
	}
	.status-badge.is-blocked,
	.priority-badge.is-high {
		background: var(--color-status-blocked-surface);
		border-color: var(--color-status-blocked-border);
		color: var(--color-status-blocked-text);
	}
	.priority-badge.is-medium {
		background: var(--color-comment-surface);
		border-color: var(--color-accent-secondary);
		color: var(--color-status-success-text);
	}
	.priority-badge.is-low {
		color: var(--color-text-tertiary);
	}
	dl {
		border-top: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-4) var(--size-6);
		grid-template-columns: repeat(2, minmax(var(--size-0), 1fr));
		margin: var(--size-0);
		padding-top: var(--size-5);
	}
	dl div {
		display: grid;
		gap: var(--size-1);
		min-width: var(--size-0);
	}
	dt {
		color: var(--color-text-tertiary);
		font-size: var(--font-size-compact);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	dd {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		margin: var(--size-0);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	dd.is-overdue,
	dd.is-blocked {
		color: var(--color-status-blocked-text);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-card": KanbanCard;
	}

	interface HTMLElementEventMap {
		"kanban-card-open": CustomEvent<{ cardId: string }>;
	}
}