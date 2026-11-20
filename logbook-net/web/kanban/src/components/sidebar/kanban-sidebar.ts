import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanSidebarState = {
	brandLabel: string;
	collapsed: boolean;
	navigationLabel: string;
};

export type KanbanSidebarRenderService = {
	sidebar: { get(): KanbanSidebarState };
	setCollapsed: (collapsed: boolean) => void;
};

export const kanbanSidebarRenderServiceContext = createContext<KanbanSidebarRenderService>(Symbol("kanban-sidebar-render-service"));

@customElement("kanban-sidebar")
export class KanbanSidebar extends SignalWatcher(LitElement) {
	@consume({ context: kanbanSidebarRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanSidebarRenderService | undefined;

	protected handleCollapse() {
		const sidebar = this.service?.sidebar.get();
		if (sidebar === undefined) {
			return;
		}

		const collapsed = !sidebar.collapsed;
		this.service?.setCollapsed(collapsed);
		this.dispatchEvent(new CustomEvent("kanban-sidebar-collapse", {
			bubbles: true,
			composed: true,
			detail: { collapsed }
		}));
	}

	protected render() {
		const sidebar = this.service?.sidebar.get();
		if (sidebar === undefined) {
			return html``;
		}

		return html`
		<aside
			aria-label=${sidebar.navigationLabel}
			class=${classMap({ "is-collapsed": sidebar.collapsed, "sidebar-shell": true })}
		>
			<div class="brand">
				<span aria-hidden="true" class="brand-mark">A</span>
				<span class="brand-label">${sidebar.brandLabel}</span>
				<button
					@click=${this.handleCollapse}
					aria-label=${sidebar.collapsed ? "Expand sidebar" : "Collapse sidebar"}
					type="button"
				>
					<span aria-hidden="true">${sidebar.collapsed ? ">" : "<"}</span>
				</button>
			</div>
			<div ?hidden=${sidebar.collapsed} class="navigation-content">
				<slot></slot>
			</div>
		</aside>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-height: 100%;
	}

	.sidebar-shell {
		background: var(--color-surface-sidebar);
		box-sizing: border-box;
		color: var(--color-text-inverse);
		min-height: 100%;
		padding: var(--size-14) var(--size-10);
	}

	.brand {
		align-items: center;
		display: flex;
		font-size: var(--font-size-brand);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-5);
	}

	.brand-mark {
		align-items: center;
		background: var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		display: inline-flex;
		height: var(--size-13);
		justify-content: center;
		width: var(--size-13);
	}

	button {
		align-items: center;
		background: transparent;
		border: var(--border-width) solid var(--color-border-sidebar-control);
		border-radius: var(--radius-control);
		color: var(--color-text-inverse);
		cursor: pointer;
		display: inline-flex;
		font: inherit;
		height: var(--size-15);
		justify-content: center;
		margin-left: auto;
		padding: var(--size-0);
		width: var(--size-15);
	}

	button:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.navigation-content {
		margin-top: var(--size-14);
	}

	.is-collapsed {
		padding: var(--size-14) var(--size-6);
	}

	.is-collapsed .brand {
		justify-content: center;
	}

	.is-collapsed .brand-label,
	.is-collapsed .brand-mark {
		display: none;
	}

	.is-collapsed button {
		border-color: var(--color-text-tertiary);
		color: var(--color-accent);
		margin-left: var(--size-0);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-sidebar": KanbanSidebar;
	}

	interface HTMLElementEventMap {
		"kanban-sidebar-collapse": CustomEvent<{ collapsed: boolean }>;
	}
}