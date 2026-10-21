import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

export type KanbanEntityTableColumn = {
	id: "reference" | "summary" | "scope" | "status";
	label: string;
};

export type KanbanEntityTableRow = {
	description: string;
	reference: string;
	scope?: string;
	status: string;
	title: string;
};

export type KanbanEntityTableState = {
	caption: string;
	columns: readonly KanbanEntityTableColumn[];
	rows: readonly KanbanEntityTableRow[];
};

export type KanbanEntityTableRenderService = {
	entityTable: { get(): KanbanEntityTableState };
	openEntity: (reference: string) => void;
};

export const kanbanEntityTableRenderServiceContext = createContext<KanbanEntityTableRenderService>(
	Symbol("kanban-entity-table-render-service")
);

@customElement("kanban-entity-table")
export class KanbanEntityTable extends SignalWatcher(LitElement) {
	@consume({ context: kanbanEntityTableRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanEntityTableRenderService | undefined;

	protected handleOpenEntity(event: MouseEvent) {
		const button = event.currentTarget as HTMLButtonElement;
		const reference = button.dataset.reference;
		if (reference === undefined) {
			return;
		}

		this.service?.openEntity(reference);
		this.dispatchEvent(new CustomEvent("kanban-entity-open", {
			bubbles: true,
			composed: true,
			detail: { reference }
		}));
	}

	protected renderCell(row: KanbanEntityTableRow, column: KanbanEntityTableColumn) {
		switch (column.id) {
			case "reference":
				return html`<code>${row.reference}</code>`;
			case "summary":
				return html`
				<strong>${row.title}</strong>
				<span class="description">${row.description}</span>
				`;
			case "scope":
				return row.scope;
			case "status":
				return row.status;
		}
	}

	protected render() {
		const entityTable = this.service?.entityTable.get();
		if (entityTable === undefined) {
			return html``;
		}

		return html`
		<div class="table-wrap">
			<table>
				<caption>${entityTable.caption}</caption>
				<thead>
					<tr>
					${map(entityTable.columns, (column) => html`<th scope="col">${column.label}</th>`)}
						<th scope="col">
							<span class="screen-reader-text">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
				${map(entityTable.rows, (row) => html`
					<tr>
						${map(entityTable.columns, (column) => html`<td>${this.renderCell(row, column)}</td>`)}
						<td>
							<button
								aria-label=${`Open ${row.reference}`}
								data-reference=${row.reference}
								@click=${this.handleOpenEntity}
								type="button"
							>
								Open
							</button>
						</td>
					</tr>
				`)}
				</tbody>
			</table>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
	}
	.table-wrap {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		min-width: var(--size-230);
		width: 100%;
	}
	caption,
	.screen-reader-text {
		height: var(--size-1);
		overflow: hidden;
		position: absolute;
		white-space: nowrap;
		width: var(--size-1);
	}
	caption {
		clip: rect(var(--size-0), var(--size-0), var(--size-0), var(--size-0));
	}
	th,
	td {
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		padding: var(--size-5) var(--size-8);
		text-align: left;
		vertical-align: middle;
	}
	th {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	tbody tr:last-child td {
		border-bottom: var(--size-0);
	}
	td:first-child {
		width: var(--size-36);
	}
	td:nth-child(3) {
		width: var(--size-41);
	}
	td:last-child {
		width: var(--size-41);
	}
	code,
	.description,
	td:nth-child(3),
	td:nth-child(4) {
		color: var(--color-text-secondary);
	}
	code {
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	strong,
	.description {
		display: block;
	}
	strong {
		color: var(--color-text-primary);
		font-size: var(--font-size-body);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
	}
	.description {
		font-size: var(--font-size-ui);
		line-height: var(--line-height-body);
		margin-top: var(--size-2);
	}
	button {
		background: transparent;
		border: var(--size-0);
		color: var(--color-text-primary);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-ui);
		font-weight: var(--font-weight-strong);
		padding: var(--size-2);
		text-decoration: underline;
	}
	button:hover {
		color: var(--color-status-success-text);
	}
	button:focus-visible {
		outline: var(--border-width) solid var(--color-status-success);
		outline-offset: var(--size-1);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-entity-table": KanbanEntityTable;
	}

	interface HTMLElementEventMap {
		"kanban-entity-open": CustomEvent<{ reference: string }>;
	}
}