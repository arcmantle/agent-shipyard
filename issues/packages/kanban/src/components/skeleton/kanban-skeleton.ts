import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";

export type KanbanSkeletonLayout = "card" | "panel" | "table";

export type KanbanSkeletonState = {
	layout: KanbanSkeletonLayout;
};

export type KanbanSkeletonRenderService = {
	skeleton: { get(): KanbanSkeletonState };
};

export const kanbanSkeletonRenderServiceContext = createContext<KanbanSkeletonRenderService>(Symbol("kanban-skeleton-render-service"));

@customElement("kanban-skeleton")
export class KanbanSkeleton extends SignalWatcher(LitElement) {
	@consume({ context: kanbanSkeletonRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanSkeletonRenderService | undefined;

	protected getBusyLabel(layout: KanbanSkeletonLayout) {
		if (layout === "panel") {
			return "Loading record panel";
		}

		return `Loading ${layout}`;
	}

	protected renderCardLayout() {
		return html`
		<div
			aria-hidden="true"
			class="skeleton-card"
		>
			<span class="skeleton-block skeleton-title"></span>
			<span class="skeleton-block skeleton-line"></span>
			<span class="skeleton-block skeleton-line is-short"></span>
			<div class="skeleton-card-meta">
				<span class="skeleton-block skeleton-chip"></span>
				<span class="skeleton-block skeleton-meta"></span>
			</div>
		</div>
		`;
	}

	protected renderPanelLayout() {
		return html`
		<div
			aria-hidden="true"
			class="skeleton-panel"
		>
			<div class="skeleton-panel-header">
				<span class="skeleton-block skeleton-kicker"></span>
				<span class="skeleton-block skeleton-panel-title"></span>
			</div>
			<span class="skeleton-block skeleton-line"></span>
			<span class="skeleton-block skeleton-line"></span>
			<span class="skeleton-block skeleton-line is-short"></span>
			<div class="skeleton-panel-section">
				<span class="skeleton-block skeleton-kicker"></span>
				<span class="skeleton-block skeleton-line"></span>
				<span class="skeleton-block skeleton-line is-short"></span>
			</div>
		</div>
		`;
	}

	protected renderTableLayout() {
		return html`
		<div
			aria-hidden="true"
			class="skeleton-table"
		>
			<div class="skeleton-table-head">
				<span class="skeleton-block skeleton-heading"></span>
				<span class="skeleton-block skeleton-heading"></span>
				<span class="skeleton-block skeleton-heading"></span>
			</div>
			<div class="skeleton-table-row">
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell is-short"></span>
			</div>
			<div class="skeleton-table-row">
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell is-short"></span>
			</div>
			<div class="skeleton-table-row">
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell"></span>
				<span class="skeleton-block skeleton-cell is-short"></span>
			</div>
		</div>
		`;
	}

	protected render() {
		const skeleton = this.service?.skeleton.get();
		if (skeleton === undefined) {
			return html``;
		}

		return html`
		<div
			aria-busy="true"
			aria-label=${this.getBusyLabel(skeleton.layout)}
			role="status"
		>
			${choose(skeleton.layout, [
				[ "card", () => this.renderCardLayout() ],
				[ "panel", () => this.renderPanelLayout() ],
				[ "table", () => this.renderTableLayout() ]
			])}
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.skeleton-block {
		background: var(--color-surface-subtle);
		border-radius: var(--radius-control);
		display: block;
	}
	.skeleton-card,
	.skeleton-panel {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		display: grid;
		gap: var(--size-5);
		padding: var(--size-8);
	}
	.skeleton-title {
		height: var(--size-8);
		width: 68%;
	}
	.skeleton-line {
		height: var(--size-4);
		width: 100%;
	}
	.skeleton-line.is-short {
		width: 58%;
	}
	.skeleton-card-meta {
		align-items: center;
		display: flex;
		justify-content: space-between;
		margin-top: var(--size-3);
	}
	.skeleton-chip {
		height: var(--size-8);
		width: var(--size-30);
	}
	.skeleton-meta {
		height: var(--size-4);
		width: var(--size-24);
	}
	.skeleton-table {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		overflow: hidden;
	}
	.skeleton-table-head,
	.skeleton-table-row {
		align-items: center;
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-7);
		grid-template-columns: minmax(var(--size-30), .7fr) minmax(var(--size-50), 2fr) minmax(var(--size-30), .6fr);
		padding: var(--size-7) var(--size-8);
	}
	.skeleton-table-row:last-child {
		border-bottom: var(--size-0);
	}
	.skeleton-heading {
		height: var(--size-3);
		width: 64%;
	}
	.skeleton-cell {
		height: var(--size-4);
		width: 86%;
	}
	.skeleton-cell.is-short {
		width: 100%;
	}
	.skeleton-panel-header {
		display: grid;
		gap: var(--size-4);
		margin-bottom: var(--size-3);
	}
	.skeleton-kicker {
		height: var(--size-3);
		width: var(--size-24);
	}
	.skeleton-panel-title {
		height: var(--size-9);
		width: 72%;
	}
	.skeleton-panel-section {
		border-top: var(--border-width) solid var(--color-border-subtle);
		display: grid;
		gap: var(--size-4);
		margin-top: var(--size-6);
		padding-top: var(--size-7);
	}
	@media (max-width: 40rem) {
		.skeleton-table-head,
		.skeleton-table-row {
			gap: var(--size-4);
			grid-template-columns: minmax(var(--size-24), .7fr) minmax(var(--size-40), 1.6fr) minmax(var(--size-24), .6fr);
			padding: var(--size-6);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-skeleton": KanbanSkeleton;
	}
}
