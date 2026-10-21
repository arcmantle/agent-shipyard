import { LitElement, css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { when } from "lit/directives/when.js";

import type { Entity } from "../models.js";
import { issueBrowserControlStyles } from "../styles/issue-browser-shared-styles.js";

export type RecordBrowserView = "list" | "tree";

class RecordListItem extends LitElement {
	static properties = {
		active: { type: Boolean },
		crossLink: { type: Boolean },
		record: { attribute: false },
		reference: { type: String },
		statusTone: { type: String }
	};

	public active = false;
	public crossLink = false;
	public record: Entity | null = null;
	public reference = "";
	public statusTone = "neutral";

	protected onOpen = () => {
		if (!this.record) return;

		this.dispatchEvent(
			new CustomEvent<{ crossLink: boolean; record: Entity }>("record-open", {
				bubbles: true,
				composed: true,
				detail: { crossLink: this.crossLink, record: this.record }
			})
		);
	};

	render() {
		const record = this.record;
		if (!record) return html``;

		return html`
		<button
			aria-label=${`Open ${this.reference} ${record.title}`}
			class=${classMap({ active: this.active, line: true })}
			@click=${this.onOpen}
		>
			<span class="idtag">${this.reference}</span>
			<span class="line-title">${record.title}</span>
			<span class=${`badge ${this.statusTone}`}>${record.status}</span>
		</button>
		`;
	}

	static styles = [issueBrowserControlStyles, css`
	:host {
		display: block;
	}
	.line {
		display: flex;
		gap: 12px;
		align-items: center;
		width: stretch;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: inherit;
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	.line:hover {
		border-color: var(--accent);
		background: var(--surface-muted);
	}
	.line.active {
		border-color: var(--accent);
		background: var(--surface-muted);
		box-shadow: inset 3px 0 0 0 var(--accent);
	}
	.line-title {
		flex: 1;
		font-weight: 600;
	}
	.idtag {
		min-width: 56px;
		color: var(--muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
	}
	`];
}

class RecordFilterToolbar extends LitElement {
	static properties = {
		countText: { type: String },
		currentWorkFilter: { type: Boolean },
		query: { type: String },
		status: { type: String },
		statuses: { attribute: false },
		title: { type: String },
		treeTab: { type: String },
		treeView: { type: String }
	};

	public countText = "";
	public currentWorkFilter = false;
	public query = "";
	public status = "all";
	public statuses: string[] = [];
	public title = "Records";
	public treeTab: string | null = null;
	public treeView: RecordBrowserView = "list";

	protected onQueryInput = (event: Event) => {
		this.dispatchEvent(
			new CustomEvent<{ query: string }>("record-query-change", {
				bubbles: true,
				composed: true,
				detail: { query: (event.target as HTMLInputElement).value }
			})
		);
	};

	protected onStatusChange = (event: Event) => {
		this.dispatchEvent(
			new CustomEvent<{ status: string }>("record-status-change", {
				bubbles: true,
				composed: true,
				detail: { status: (event.target as HTMLSelectElement).value }
			})
		);
	};

	protected onSetView = (event: Event) => {
		const view = (event.currentTarget as HTMLElement).dataset.view as RecordBrowserView | undefined;
		if (!view || !this.treeTab) return;

		this.dispatchEvent(
			new CustomEvent<{ tab: string; view: RecordBrowserView }>("record-view-change", {
				bubbles: true,
				composed: true,
				detail: { tab: this.treeTab, view }
			})
		);
	};

	render() {
		const title = this.title.toLowerCase();
		return html`
		<div class="toolbar">
			<label class="filter">
				<span>Filter ${title}</span>
				<input
					placeholder=${`Filter ${title}`}
					type="search"
					.value=${this.query}
					@input=${this.onQueryInput}
				>
			</label>
			<label class="filter">
				<span>Status</span>
				<select
					.value=${this.status}
					@change=${this.onStatusChange}
				>
					${when(this.currentWorkFilter, () => html`
					<option value="current-work">Current work</option>
					`)}
					<option value="all">All statuses</option>
					${this.statuses.map((status) => html`<option value=${status}>${status}</option>`)}
				</select>
			</label>
			${when(
				this.treeTab !== null,
				() => html`
				<div
					aria-label="Record view"
					class="view-toggle"
					role="group"
				>
					<button
						aria-pressed=${String(this.treeView === "list")}
						class=${classMap({ active: this.treeView === "list", "view-button": true })}
						data-view="list"
						@click=${this.onSetView}
						type="button"
					>
						List
					</button>
					<button
						aria-pressed=${String(this.treeView === "tree")}
						class=${classMap({ active: this.treeView === "tree", "view-button": true })}
						data-view="tree"
						@click=${this.onSetView}
						type="button"
					>
						Tree
					</button>
				</div>
				`,
				() => html``
			)}
			<span class="count">${this.countText}</span>
		</div>
		`;
	}

	static styles = css`
	:host {
		display: block;
	}
	.toolbar {
		display: flex;
		gap: 12px;
		align-items: end;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-muted);
	}
	.filter {
		display: grid;
		gap: 4px;
	}
	.filter:first-child {
		flex: 1;
	}
	.filter > span {
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
	}
	.filter input,
	.filter select {
		box-sizing: border-box;
		min-height: 32px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
	}
	.view-toggle {
		display: inline-flex;
		align-self: end;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.view-button {
		min-height: 32px;
		padding: 6px 10px;
		border: 0;
		border-right: 1px solid var(--border);
		background: var(--surface);
		color: var(--muted);
		cursor: pointer;
		font: inherit;
	}
	.view-button:last-child {
		border-right: 0;
	}
	.view-button.active {
		background: var(--surface-muted);
		color: var(--text);
		font-weight: 600;
	}
	.count {
		padding-bottom: 7px;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
	}
	@media (max-width: 640px) {
		.toolbar {
			align-items: stretch;
			flex-direction: column;
		}
		.count {
			padding-bottom: 0;
		}
	}
	`;
}

customElements.define("agent-issues-record-list-item", RecordListItem);
customElements.define("agent-issues-record-filter-toolbar", RecordFilterToolbar);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-record-filter-toolbar": RecordFilterToolbar;
		"agent-issues-record-list-item": RecordListItem;
	}
	interface HTMLElementEventMap {
		"record-open": CustomEvent<{ crossLink: boolean; record: Entity }>;
		"record-query-change": CustomEvent<{ query: string }>;
		"record-status-change": CustomEvent<{ status: string }>;
		"record-view-change": CustomEvent<{ tab: string; view: RecordBrowserView }>;
	}
}
