import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanActivityEventTone = "accent" | "default" | "warning";

export type KanbanActivityEventState = {
	detail: string;
	summary: string;
	time: string;
	timeLabel: string;
	tone: KanbanActivityEventTone;
};

export type KanbanActivityEventRenderService = {
	activityEvent: { get(): KanbanActivityEventState };
};

export const kanbanActivityEventRenderServiceContext = createContext<KanbanActivityEventRenderService>(
	Symbol("kanban-activity-event-render-service")
);

@customElement("kanban-activity-event")
export class KanbanActivityEvent extends SignalWatcher(LitElement) {
	@consume({ context: kanbanActivityEventRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanActivityEventRenderService | undefined;

	protected render() {
		const activityEvent = this.service?.activityEvent.get();
		if (activityEvent === undefined) {
			return html``;
		}

		return html`
		<article class="activity-event">
			<time datetime=${activityEvent.time}>${activityEvent.timeLabel}</time>
			<span
				aria-hidden="true"
				class=${classMap({
					"activity-event-marker": true,
					"is-accent": activityEvent.tone === "accent",
					"is-warning": activityEvent.tone === "warning"
				})}
			></span>
			<div>
				<h3>${activityEvent.summary}</h3>
				<p>${activityEvent.detail}</p>
			</div>
		</article>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.activity-event {
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-6);
		grid-template-columns: var(--size-50) var(--size-4) minmax(var(--size-0), 1fr);
		padding: var(--size-7) var(--size-0);
	}
	:host(:last-child) .activity-event {
		border-bottom: var(--size-0);
	}
	time {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
	}
	h3 {
		color: var(--color-text-primary);
		font-size: var(--font-size-body);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		margin: var(--size-0);
	}
	p {
		color: var(--color-text-secondary);
		font-size: var(--font-size-ui);
		line-height: var(--line-height-body);
		margin: var(--size-2) var(--size-0) var(--size-0);
		overflow-wrap: anywhere;
	}
	.activity-event-marker {
		background: var(--color-text-tertiary);
		border-radius: 50%;
		height: var(--size-4);
		margin-top: var(--size-2);
		width: var(--size-4);
	}
	.activity-event-marker.is-accent {
		background: var(--color-status-success);
	}
	.activity-event-marker.is-warning {
		background: var(--color-accent-warning);
	}
	@media (max-width: 47.5rem) {
		.activity-event {
			grid-template-columns: var(--size-36) var(--size-4) minmax(var(--size-0), 1fr);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-activity-event": KanbanActivityEvent;
	}
}