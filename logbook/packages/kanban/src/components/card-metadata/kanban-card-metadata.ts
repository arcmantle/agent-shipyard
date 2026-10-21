import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import type { KanbanPriorityBadgeVariant } from "../priority-badge/kanban-priority-badge.js";
import type { KanbanStatusBadgeVariant } from "../status-badge/kanban-status-badge.js";

export type KanbanCardMetadataDue = {
	label: string;
	overdue: boolean;
};

export type KanbanCardMetadataBadge<V> = {
	label: string;
	variant: V;
};

export type KanbanCardMetadataState = {
	blockerCount: number;
	due: KanbanCardMetadataDue;
	owner: string;
	priority: KanbanCardMetadataBadge<KanbanPriorityBadgeVariant>;
	reference: string;
	relationshipCount: number;
	status: KanbanCardMetadataBadge<KanbanStatusBadgeVariant>;
};

export type KanbanCardMetadataRenderService = {
	cardMetadata: { get(): KanbanCardMetadataState };
};

export const kanbanCardMetadataRenderServiceContext = createContext<KanbanCardMetadataRenderService>(
	Symbol("kanban-card-metadata-render-service")
);

@customElement("kanban-card-metadata")
export class KanbanCardMetadata extends SignalWatcher(LitElement) {
	@consume({ context: kanbanCardMetadataRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanCardMetadataRenderService | undefined;

	protected getCountLabel(count: number, noun: string) {
		return `${count} ${noun}${count === 1 ? "" : "s"}`;
	}

	protected render() {
		const cardMetadata = this.service?.cardMetadata.get();
		if (cardMetadata === undefined) {
			return html``;
		}

		return html`
		<section aria-label=${`Metadata for ${cardMetadata.reference}`}>
			<div class="metadata-header">
				<span class="reference">${cardMetadata.reference}</span>
				<div class="badges">
					<span
						class=${classMap({
							"is-active": cardMetadata.status.variant === "active",
							"is-blocked": cardMetadata.status.variant === "blocked",
							"is-default": cardMetadata.status.variant === "default",
							"is-muted": cardMetadata.status.variant === "muted",
							"status-badge": true
						})}
						role="status"
					>
						${cardMetadata.status.label}
					</span>
					<span
						class=${classMap({
							"is-high": cardMetadata.priority.variant === "high",
							"is-low": cardMetadata.priority.variant === "low",
							"is-medium": cardMetadata.priority.variant === "medium",
							"priority-badge": true
						})}
						role="status"
					>
						${cardMetadata.priority.label}
					</span>
				</div>
			</div>
			<dl>
				<div>
					<dt>Owner</dt>
					<dd>${cardMetadata.owner}</dd>
				</div>
				<div>
					<dt>Due</dt>
					<dd class=${classMap({ "is-overdue": cardMetadata.due.overdue })}>${cardMetadata.due.label}</dd>
				</div>
				<div>
					<dt>Blockers</dt>
					<dd class=${classMap({ "is-blocked": cardMetadata.blockerCount > 0 })}>${this.getCountLabel(cardMetadata.blockerCount, "blocker")}</dd>
				</div>
				<div>
					<dt>Relationships</dt>
					<dd>${this.getCountLabel(cardMetadata.relationshipCount, "relationship")}</dd>
				</div>
			</dl>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
	}
	section {
		display: grid;
		gap: var(--size-5);
		min-width: var(--size-0);
	}
	.metadata-header {
		align-items: start;
		display: flex;
		gap: var(--size-5);
		justify-content: space-between;
	}
	.reference {
		color: var(--color-text-secondary);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-2);
		justify-content: end;
	}
	.status-badge,
	.priority-badge {
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		display: inline-flex;
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		padding: var(--size-2) var(--size-3);
		white-space: nowrap;
	}
	.status-badge {
		color: var(--color-text-secondary);
	}
	.status-badge.is-active {
		background: var(--color-comment-surface);
		border-color: var(--color-status-success);
		color: var(--color-status-success-text);
	}
	.status-badge.is-blocked {
		background: var(--color-status-blocked-surface);
		border-color: var(--color-status-blocked-border);
		color: var(--color-status-blocked-text);
	}
	.status-badge.is-default {
		background: var(--color-surface-subtle);
	}
	.status-badge.is-muted {
		color: var(--color-text-tertiary);
	}
	.priority-badge {
		color: var(--color-text-secondary);
	}
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
		"kanban-card-metadata": KanbanCardMetadata;
	}
}