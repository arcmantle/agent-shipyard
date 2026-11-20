import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";

export type KanbanNavigationTreeNode = {
	children?: readonly KanbanNavigationTreeNode[];
	current?: boolean;
	id: string;
	kind: string;
	label: string;
};

export type KanbanNavigationTreeState = {
	expandedNodeIds: readonly string[];
	navigationLabel: string;
	nodes: readonly KanbanNavigationTreeNode[];
};

export type KanbanNavigationTreeRenderService = {
	navigationTree: { get(): KanbanNavigationTreeState };
	selectNode: (nodeId: string) => void;
	toggleNode: (nodeId: string) => void;
};

export const kanbanNavigationTreeRenderServiceContext = createContext<KanbanNavigationTreeRenderService>(Symbol("kanban-navigation-tree-render-service"));

@customElement("kanban-navigation-tree")
export class KanbanNavigationTree extends SignalWatcher(LitElement) {
	@consume({ context: kanbanNavigationTreeRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanNavigationTreeRenderService | undefined;

	protected getToggleLabel(node: KanbanNavigationTreeNode, expanded: boolean): string {
		return `${expanded ? "Collapse" : "Expand"} ${node.kind} ${node.label}`;
	}

	protected handleSelect(event: Event) {
		const nodeId = (event.currentTarget as HTMLButtonElement).dataset.nodeId;
		if (nodeId === undefined) {
			return;
		}

		this.service?.selectNode(nodeId);
		this.dispatchEvent(new CustomEvent("kanban-navigation-tree-select", {
			bubbles: true,
			composed: true,
			detail: { nodeId }
		}));
	}

	protected handleToggle(event: Event) {
		const nodeId = (event.currentTarget as HTMLButtonElement).dataset.nodeId;
		if (nodeId === undefined) {
			return;
		}

		this.service?.toggleNode(nodeId);
		this.dispatchEvent(new CustomEvent("kanban-navigation-tree-toggle", {
			bubbles: true,
			composed: true,
			detail: { nodeId }
		}));
	}

	protected isExpanded(nodeId: string, state: KanbanNavigationTreeState): boolean {
		return state.expandedNodeIds.includes(nodeId);
	}

	protected renderChildren(node: KanbanNavigationTreeNode, state: KanbanNavigationTreeState): TemplateResult | typeof nothing {
		const children = node.children ?? [];
		const expanded = this.isExpanded(node.id, state);
		return when(
			children.length > 0 && expanded,
			() => html`
			<ul>
				${map(children, (child) => this.renderNode(child, state))}
			</ul>
			`
		);
	}

	protected renderNode(node: KanbanNavigationTreeNode, state: KanbanNavigationTreeState): TemplateResult {
		const children = node.children ?? [];
		const expanded = this.isExpanded(node.id, state);
		return html`
		<li class="navigation-tree-item">
			${when(
				children.length > 0,
				() => html`
				<button
					@click=${this.handleToggle}
					aria-expanded=${String(expanded)}
					aria-label=${this.getToggleLabel(node, expanded)}
					data-node-id=${node.id}
					type="button"
				>
					<span aria-hidden="true">${expanded ? "-" : "+"}</span>
				</button>
				`,
				() => html`<span aria-hidden="true" class="navigation-tree-spacer"></span>`
			)}
			<button
				@click=${this.handleSelect}
				aria-current=${node.current ? "page" : "false"}
				class=${classMap({ "is-current": node.current === true, "navigation-tree-record": true })}
				data-node-id=${node.id}
				type="button"
			>
				${node.label}
				<span>${node.kind}</span>
			</button>
			${this.renderChildren(node, state)}
		</li>
		`;
	}

	protected render() {
		const state = this.service?.navigationTree.get();
		if (state === undefined) {
			return html``;
		}

		return html`
		<nav aria-label=${state.navigationLabel}>
			${when(
				state.nodes.length > 0,
				() => html`
				<ul>
					${map(state.nodes, (node) => this.renderNode(node, state))}
				</ul>
				`,
				() => html`<p>No records are available in this project yet.</p>`
			)}
		</nav>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}

	nav {
		font-size: var(--font-size-control);
	}

	ul {
		display: grid;
		gap: var(--size-2);
		list-style: none;
		margin: var(--size-0);
		padding: var(--size-0);
	}

	nav > ul {
		gap: var(--size-4);
	}

	.navigation-tree-item {
		align-items: center;
		display: grid;
		gap: var(--size-2);
		grid-template-columns: var(--size-11) minmax(var(--size-0), 1fr);
	}

	.navigation-tree-item > ul {
		border-left: var(--border-width) solid var(--color-border-sidebar-strong);
		grid-column: 2;
		margin: var(--size-2) var(--size-0) var(--size-0) var(--size-7);
		padding-left: var(--size-5);
	}

	button,
	.navigation-tree-spacer {
		font: inherit;
	}

	button[aria-expanded],
	.navigation-tree-spacer {
		align-items: center;
		display: inline-flex;
		height: var(--size-11);
		justify-content: center;
		width: var(--size-11);
	}

	button[aria-expanded] {
		background: transparent;
		border: var(--size-0);
		border-radius: var(--radius-control);
		color: var(--color-text-tertiary);
		cursor: pointer;
		padding: var(--size-0);
	}

	.navigation-tree-record {
		background: transparent;
		border: var(--size-0);
		border-radius: var(--radius-control);
		color: var(--color-text-inverse-muted);
		cursor: pointer;
		display: grid;
		font-weight: var(--font-weight-strong);
		gap: var(--size-1);
		padding: var(--size-4);
		text-align: left;
		width: 100%;
	}

	.navigation-tree-record span {
		color: var(--color-text-tertiary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}

	button:hover,
	button:focus-visible {
		background: var(--color-surface-sidebar-hover);
		color: var(--color-surface-panel);
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.is-current {
		background: var(--color-surface-sidebar-selected);
		color: var(--color-surface-panel);
	}

	p {
		border: var(--border-width) dashed var(--color-border-sidebar-strong);
		color: var(--color-text-inverse-muted);
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		padding: var(--size-12) var(--size-6);
		text-align: center;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-navigation-tree": KanbanNavigationTree;
	}

	interface HTMLElementEventMap {
		"kanban-navigation-tree-select": CustomEvent<{ nodeId: string }>;
		"kanban-navigation-tree-toggle": CustomEvent<{ nodeId: string }>;
	}
}