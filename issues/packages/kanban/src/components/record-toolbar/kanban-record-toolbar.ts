import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";

export type KanbanRecordToolbarAction = {
	id: string;
	label: string;
};

export type KanbanRecordToolbarFilterOption = {
	label: string;
	value: string;
};

export type KanbanRecordToolbarView = "board" | "table";

export type KanbanRecordToolbarState = {
	actions: readonly KanbanRecordToolbarAction[];
	filter: string;
	filterOptions: readonly KanbanRecordToolbarFilterOption[];
	query: string;
	reference: string;
	title: string;
	view: KanbanRecordToolbarView;
};

export type KanbanRecordToolbarRenderService = {
	performAction: (actionId: string) => void;
	recordToolbar: { get(): KanbanRecordToolbarState };
	setFilter: (filter: string) => void;
	setQuery: (query: string) => void;
	setView: (view: KanbanRecordToolbarView) => void;
};

export const kanbanRecordToolbarRenderServiceContext = createContext<KanbanRecordToolbarRenderService>(
	Symbol("kanban-record-toolbar-render-service")
);

@customElement("kanban-record-toolbar")
export class KanbanRecordToolbar extends SignalWatcher(LitElement) {
	@consume({ context: kanbanRecordToolbarRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanRecordToolbarRenderService | undefined;

	protected getViewLabel(view: KanbanRecordToolbarView) {
		return `${view.slice(0, 1).toUpperCase()}${view.slice(1)}`;
	}

	protected handleAction(event: MouseEvent) {
		const actionId = (event.currentTarget as HTMLElement).dataset.actionId;
		if (actionId === undefined) {
			return;
		}

		this.service?.performAction(actionId);
		this.dispatchEvent(
			new CustomEvent("kanban-record-toolbar-action", {
				bubbles: true,
				composed: true,
				detail: { actionId }
			})
		);
	}

	protected handleFilterChange(event: Event) {
		const filter = (event.target as HTMLSelectElement).value;
		this.service?.setFilter(filter);
		this.dispatchEvent(
			new CustomEvent("kanban-record-toolbar-filter", {
				bubbles: true,
				composed: true,
				detail: { filter }
			})
		);
	}

	protected handleQueryInput(event: Event) {
		const query = (event.target as HTMLInputElement).value;
		this.service?.setQuery(query);
		this.dispatchEvent(
			new CustomEvent("kanban-record-toolbar-query", {
				bubbles: true,
				composed: true,
				detail: { query }
			})
		);
	}

	protected handleSearchSubmit(event: SubmitEvent) {
		event.preventDefault();
	}

	protected handleViewChange(event: MouseEvent) {
		const view = (event.currentTarget as HTMLElement).dataset.view;
		if (view !== "board" && view !== "table") {
			return;
		}

		this.service?.setView(view);
		this.dispatchEvent(
			new CustomEvent("kanban-record-toolbar-view", {
				bubbles: true,
				composed: true,
				detail: { view }
			})
		);
	}

	protected render() {
		const recordToolbar = this.service?.recordToolbar.get();
		if (recordToolbar === undefined) {
			return html``;
		}

		return html`
		<section aria-label=${`${recordToolbar.title} controls`}>
			<header>
				<div class="title">
					<code>${recordToolbar.reference}</code>
					<h2>${recordToolbar.title}</h2>
				</div>
				<div class="actions">
					${map(recordToolbar.actions, (action) => html`
					<button
						data-action-id=${action.id}
						@click=${this.handleAction}
						type="button"
					>
						${action.label}
					</button>
					`)}
				</div>
			</header>
			<div class="controls">
				<form
					@submit=${this.handleSearchSubmit}
					role="search"
				>
					<label>
						<span class="screen-reader-only">Search records</span>
						<input
							@input=${this.handleQueryInput}
							placeholder="Search records"
							type="search"
							.value=${recordToolbar.query}
						>
					</label>
				</form>
				<label class="filter">
					<span>Filter</span>
					<select
						@change=${this.handleFilterChange}
						.value=${recordToolbar.filter}
					>
						${map(recordToolbar.filterOptions, (option) => html`
						<option value=${option.value}>${option.label}</option>
						`)}
					</select>
				</label>
				<div
					aria-label="Record view"
					class="views"
					role="group"
				>
					${map(["board", "table"] as const, (view) => html`
					<button
						aria-pressed=${String(recordToolbar.view === view)}
						class=${classMap({ "is-selected": recordToolbar.view === view })}
						data-view=${view}
						@click=${this.handleViewChange}
						type="button"
					>
						${this.getViewLabel(view)}
					</button>
					`)}
				</div>
			</div>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	section {
		background: var(--color-surface-canvas);
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-7);
		padding: var(--size-9) var(--size-16);
	}
	header,
	.actions,
	.controls,
	.views {
		align-items: center;
		display: flex;
	}
	header {
		gap: var(--size-8);
		justify-content: space-between;
	}
	.title {
		min-width: var(--size-0);
	}
	code {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
	}
	h2 {
		font-family: var(--font-family-display);
		font-size: var(--font-size-title);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-tight);
		margin: var(--size-2) var(--size-0) var(--size-0);
		overflow-wrap: anywhere;
	}
	.actions {
		flex: 0 0 auto;
		gap: var(--size-4);
	}
	.controls {
		gap: var(--size-5);
	}
	form {
		flex: 1 1 var(--size-104);
		min-width: var(--size-0);
	}
	input,
	select {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		font: inherit;
		font-size: var(--font-size-ui);
		min-height: var(--size-18);
		padding: var(--size-3) var(--size-4);
		width: 100%;
	}
	.filter {
		color: var(--color-text-secondary);
		display: grid;
		flex: 0 1 var(--size-80);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-2);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.views {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		flex: 0 0 auto;
		overflow: hidden;
	}
	button {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-ui);
		font-weight: var(--font-weight-strong);
		min-height: var(--size-18);
		padding: var(--size-3) var(--size-5);
	}
	.views button {
		background: transparent;
		border: var(--size-0);
		border-left: var(--border-width) solid var(--color-border-subtle);
	}
	.views button:first-child {
		border-left: var(--size-0);
	}
	.views button.is-selected {
		background: var(--color-surface-subtle);
	}
	button:hover {
		background: var(--color-surface-subtle);
	}
	input:focus-visible,
	select:focus-visible,
	button:focus-visible {
		outline: var(--border-width) solid var(--color-status-success);
		outline-offset: var(--size-1);
	}
	.screen-reader-only {
		clip: rect(var(--size-0), var(--size-0), var(--size-0), var(--size-0));
		height: var(--size-1);
		overflow: hidden;
		position: absolute;
		white-space: nowrap;
		width: var(--size-1);
	}
	@media (max-width: 47.5rem) {
		section {
			padding: var(--size-9);
		}
		header {
			align-items: flex-start;
		}
		.controls {
			display: grid;
			grid-template-columns: minmax(var(--size-0), 1fr) minmax(var(--size-0), 1fr);
		}
		form {
			grid-column: 1 / -1;
		}
		.filter {
			max-width: none;
		}
		.views {
			justify-self: end;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-record-toolbar": KanbanRecordToolbar;
	}

	interface HTMLElementEventMap {
		"kanban-record-toolbar-action": CustomEvent<{ actionId: string }>;
		"kanban-record-toolbar-filter": CustomEvent<{ filter: string }>;
		"kanban-record-toolbar-query": CustomEvent<{ query: string }>;
		"kanban-record-toolbar-view": CustomEvent<{ view: KanbanRecordToolbarView }>;
	}
}