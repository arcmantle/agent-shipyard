import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";

import type { KanbanActivityEventState } from "../activity-event/kanban-activity-event.js";

export type KanbanActivityTimelineEntry = KanbanActivityEventState & {
	id: string;
};

export type KanbanActivityTimelineState = {
	entries: readonly KanbanActivityTimelineEntry[];
	label: string;
};

export type KanbanActivityTimelineRenderService = {
	activityTimeline: { get(): KanbanActivityTimelineState };
};

export const kanbanActivityTimelineRenderServiceContext = createContext<KanbanActivityTimelineRenderService>(
	Symbol("kanban-activity-timeline-render-service")
);

@customElement("kanban-activity-timeline")
export class KanbanActivityTimeline extends SignalWatcher(LitElement) {
	@consume({ context: kanbanActivityTimelineRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanActivityTimelineRenderService | undefined;

	protected renderEntry(entry: KanbanActivityTimelineEntry) {
		return html`
		<li class="activity-event">
			<time datetime=${entry.time}>${entry.timeLabel}</time>
			<span
				aria-hidden="true"
				class=${classMap({
					"activity-event-marker": true,
					"is-accent": entry.tone === "accent",
					"is-warning": entry.tone === "warning"
				})}
			></span>
			<div>
				<h3>${entry.summary}</h3>
				<p>${entry.detail}</p>
			</div>
		</li>
		`;
	}

	protected render() {
		const activityTimeline = this.service?.activityTimeline.get();
		if (activityTimeline === undefined) {
			return html``;
		}

		return html`
		${when(
			activityTimeline.entries.length > 0,
			() => html`
			<ol aria-label=${activityTimeline.label}>
				${repeat(activityTimeline.entries, (entry) => entry.id, (entry) => this.renderEntry(entry))}
			</ol>
			`,
			() => html`
			<p class="activity-timeline-empty">No activity has been recorded for this initiative.</p>
			`
		)}
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	ol {
		list-style: none;
		margin: var(--size-0);
		padding: var(--size-2) var(--size-8);
		position: relative;
	}
	ol::before {
		background: var(--color-border-subtle);
		bottom: var(--size-10);
		content: "";
		left: calc(var(--size-8) + var(--size-50) + var(--size-8));
		position: absolute;
		top: var(--size-10);
		width: var(--border-width);
	}
	.activity-event {
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-6);
		grid-template-columns: var(--size-50) var(--size-4) minmax(var(--size-0), 1fr);
		padding: var(--size-7) var(--size-0);
		position: relative;
		z-index: 1;
	}
	.activity-event:last-child {
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
	.activity-timeline-empty {
		margin: var(--size-0);
		padding: var(--size-12) var(--size-0);
		text-align: center;
	}
	@media (max-width: 47.5rem) {
		ol::before {
			left: calc(var(--size-8) + var(--size-36) + var(--size-8));
		}
		.activity-event {
			grid-template-columns: var(--size-36) var(--size-4) minmax(var(--size-0), 1fr);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-activity-timeline": KanbanActivityTimeline;
	}
}