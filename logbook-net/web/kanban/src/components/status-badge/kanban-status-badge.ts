import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanStatusBadgeVariant = "active" | "blocked" | "default" | "muted";

export type KanbanStatusBadgeState = {
	label: string;
	variant: KanbanStatusBadgeVariant;
};

export type KanbanStatusBadgeRenderService = {
	statusBadge: { get(): KanbanStatusBadgeState };
};

export const kanbanStatusBadgeRenderServiceContext = createContext<KanbanStatusBadgeRenderService>(Symbol("kanban-status-badge-render-service"));

@customElement("kanban-status-badge")
export class KanbanStatusBadge extends SignalWatcher(LitElement) {
	@consume({ context: kanbanStatusBadgeRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanStatusBadgeRenderService | undefined;

	protected render() {
		const statusBadge = this.service?.statusBadge.get();
		if (statusBadge === undefined) {
			return html``;
		}

		return html`
		<span
			class=${classMap({
				"is-active": statusBadge.variant === "active",
				"is-blocked": statusBadge.variant === "blocked",
				"is-default": statusBadge.variant === "default",
				"is-muted": statusBadge.variant === "muted",
				"status-badge": true
			})}
			role="status"
		>
			${statusBadge.label}
		</span>
		`;
	}

	public static styles = css`
	:host {
		display: inline-flex;
	}

	.status-badge {
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
		border-color: var(--color-border-subtle);
	}

	.status-badge.is-muted {
		color: var(--color-text-tertiary);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-status-badge": KanbanStatusBadge;
	}
}