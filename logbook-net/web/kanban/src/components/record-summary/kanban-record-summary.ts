import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanRecordSummaryState = {
	metadata: string;
	owner: string;
	reference: string;
	title: string;
};

export type KanbanRecordSummaryRenderService = {
	recordSummary: { get(): KanbanRecordSummaryState };
};

export const kanbanRecordSummaryRenderServiceContext = createContext<KanbanRecordSummaryRenderService>(
	Symbol("kanban-record-summary-render-service")
);

@customElement("kanban-record-summary")
export class KanbanRecordSummary extends SignalWatcher(LitElement) {
	@consume({ context: kanbanRecordSummaryRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanRecordSummaryRenderService | undefined;

	protected render() {
		const recordSummary = this.service?.recordSummary.get();
		if (recordSummary === undefined) {
			return html``;
		}

		return html`
		<article aria-label=${`Summary for ${recordSummary.reference}`}>
			<div class="primary">
				<span>${recordSummary.reference}</span>
				<h2>${recordSummary.title}</h2>
			</div>
			<dl>
				<div>
					<dt>Metadata</dt>
					<dd>${recordSummary.metadata}</dd>
				</div>
				<div>
					<dt>Owner</dt>
					<dd>${recordSummary.owner}</dd>
				</div>
			</dl>
		</article>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
	}
	article {
		display: grid;
		gap: var(--size-6);
		min-width: var(--size-0);
	}
	.primary {
		display: grid;
		gap: var(--size-2);
		min-width: var(--size-0);
	}
	.primary span,
	dt {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
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
		margin: var(--size-0);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	dl {
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-6) var(--size-10);
		margin: var(--size-0);
	}
	dl div {
		display: grid;
		gap: var(--size-2);
	}
	dd {
		color: var(--color-text-primary);
		font-size: var(--font-size-ui);
		font-weight: var(--font-weight-strong);
		margin: var(--size-0);
	}
	@media (max-width: 31.25rem) {
		h2 {
			font-size: var(--font-size-card-title);
		}
		dl {
			display: grid;
			gap: var(--size-4);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-record-summary": KanbanRecordSummary;
	}
}