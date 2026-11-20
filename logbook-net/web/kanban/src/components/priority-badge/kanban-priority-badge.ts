import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanPriorityBadgeVariant = "high" | "medium" | "low";

export type KanbanPriorityBadgeState = {
	label: string;
	variant: KanbanPriorityBadgeVariant;
};

export type KanbanPriorityBadgeRenderService = {
	priorityBadge: { get(): KanbanPriorityBadgeState };
};

export const kanbanPriorityBadgeRenderServiceContext = createContext<KanbanPriorityBadgeRenderService>(
	Symbol("kanban-priority-badge-render-service")
);

@customElement("kanban-priority-badge")
export class KanbanPriorityBadge extends SignalWatcher(LitElement) {
	@consume({ context: kanbanPriorityBadgeRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanPriorityBadgeRenderService | undefined;

	protected render() {
		const priorityBadge = this.service?.priorityBadge.get();
		if (priorityBadge === undefined) {
			return html``;
		}

		return html`
		<span
			class=${classMap({
				"is-high": priorityBadge.variant === "high",
				"is-low": priorityBadge.variant === "low",
				"is-medium": priorityBadge.variant === "medium",
				"priority-badge": true
			})}
			role="status"
		>
			${priorityBadge.label}
		</span>
		`;
	}

	public static styles = css`
	:host {
		display: inline-flex;
	}
	.priority-badge {
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-secondary);
		display: inline-flex;
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		justify-content: center;
		line-height: var(--line-height-ui);
		padding: var(--size-2) var(--size-3);
		white-space: nowrap;
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
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-priority-badge": KanbanPriorityBadge;
	}
}
