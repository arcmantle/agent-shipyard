import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";

export type KanbanRelationshipListEntry = {
	id: string;
	kind: string;
	relation: string;
	title: string;
};

export type KanbanRelationshipListState = {
	label: string;
	relationships: readonly KanbanRelationshipListEntry[];
};

export type KanbanRelationshipListRenderService = {
	relationshipList: { get(): KanbanRelationshipListState };
};

export const kanbanRelationshipListRenderServiceContext = createContext<KanbanRelationshipListRenderService>(
	Symbol("kanban-relationship-list-render-service")
);

@customElement("kanban-relationship-list")
export class KanbanRelationshipList extends SignalWatcher(LitElement) {
	@consume({ context: kanbanRelationshipListRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanRelationshipListRenderService | undefined;

	protected renderRelationship(relationship: KanbanRelationshipListEntry) {
		return html`
		<li>
			<article>
				<div class="relationship-summary">
					<span>${relationship.kind}</span>
					<strong>${relationship.title}</strong>
				</div>
				<small>${relationship.relation}</small>
			</article>
		</li>
		`;
	}

	protected render() {
		const relationshipList = this.service?.relationshipList.get();
		if (relationshipList === undefined) {
			return html``;
		}

		return html`
		<section>
			${when(
				relationshipList.relationships.length > 0,
				() => html`
				<ol
					aria-label=${relationshipList.label}
					aria-live="polite"
				>
					${repeat(
						relationshipList.relationships,
						(relationship) => relationship.id,
						(relationship) => this.renderRelationship(relationship)
					)}
				</ol>
				`,
				() => html`<p class="relationship-list-empty">No related records yet.</p>`
			)}
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	section {
		display: grid;
		gap: var(--size-5);
	}
	ol {
		display: grid;
		gap: var(--size-5);
		list-style: none;
		margin: var(--size-0);
		padding: var(--size-0);
	}
	article {
		align-items: center;
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		display: flex;
		gap: var(--size-6);
		justify-content: space-between;
		padding: var(--size-6);
	}
	.relationship-summary {
		display: grid;
		gap: var(--size-2);
		min-width: var(--size-0);
	}
	.relationship-summary span,
	small {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	strong {
		color: var(--color-text-primary);
		font-size: var(--font-size-ui);
		font-weight: var(--font-weight-strong);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	small {
		flex: 0 0 auto;
	}
	.relationship-list-empty {
		border: var(--border-width) dashed var(--color-border-subtle);
		color: var(--color-text-secondary);
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		padding: var(--size-12) var(--size-6);
		text-align: center;
	}
	@media (max-width: 31.25rem) {
		article {
			align-items: flex-start;
			flex-direction: column;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-relationship-list": KanbanRelationshipList;
	}
}