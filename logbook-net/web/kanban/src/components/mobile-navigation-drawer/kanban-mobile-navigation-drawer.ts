import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";

export type KanbanMobileNavigationDrawerItem = {
	current?: boolean;
	id: string;
	label: string;
	reference: string;
};

export type KanbanMobileNavigationDrawerGroup = {
	items: readonly KanbanMobileNavigationDrawerItem[];
	label: string;
};

export type KanbanMobileNavigationDrawerState = {
	brandLabel: string;
	groups: readonly KanbanMobileNavigationDrawerGroup[];
	navigationLabel: string;
	open: boolean;
	projectLabel: string;
};

export type KanbanMobileNavigationDrawerRenderService = {
	close: () => void;
	mobileNavigationDrawer: { get(): KanbanMobileNavigationDrawerState };
	open: () => void;
	selectItem: (itemId: string) => void;
	selectProject: () => void;
};

export const kanbanMobileNavigationDrawerRenderServiceContext = createContext<KanbanMobileNavigationDrawerRenderService>(
	Symbol("kanban-mobile-navigation-drawer-render-service")
);

@customElement("kanban-mobile-navigation-drawer")
export class KanbanMobileNavigationDrawer extends SignalWatcher(LitElement) {
	@consume({ context: kanbanMobileNavigationDrawerRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanMobileNavigationDrawerRenderService | undefined;

	protected handleDocumentKeyDown = (event: KeyboardEvent) => {
		const drawer = this.service?.mobileNavigationDrawer.get();
		if (event.key !== "Escape" || drawer === undefined || !drawer.open) {
			return;
		}

		event.preventDefault();
		this.handleClose();
	};

	public connectedCallback() {
		super.connectedCallback();
		document.addEventListener("keydown", this.handleDocumentKeyDown);
	}

	public disconnectedCallback() {
		document.removeEventListener("keydown", this.handleDocumentKeyDown);
		super.disconnectedCallback();
	}

	protected handleClose() {
		const drawer = this.service?.mobileNavigationDrawer.get();
		if (drawer === undefined || !drawer.open) {
			return;
		}

		this.service?.close();
		this.dispatchEvent(new CustomEvent("kanban-mobile-navigation-drawer-close", { bubbles: true, composed: true }));
	}

	protected handleSelectItem(event: Event) {
		const itemId = (event.currentTarget as HTMLButtonElement).dataset.itemId;
		if (itemId === undefined) {
			return;
		}

		this.service?.selectItem(itemId);
		this.dispatchEvent(new CustomEvent("kanban-mobile-navigation-drawer-select-item", {
			bubbles: true,
			composed: true,
			detail: { itemId }
		}));
	}

	protected handleSelectProject() {
		this.service?.selectProject();
		this.dispatchEvent(new CustomEvent("kanban-mobile-navigation-drawer-select-project", { bubbles: true, composed: true }));
	}

	protected render() {
		const drawer = this.service?.mobileNavigationDrawer.get();
		if (drawer === undefined) {
			return html``;
		}

		return html`
		<div ?hidden=${!drawer.open}>
			<button
				aria-label="Close navigation"
				class="scrim"
				@click=${this.handleClose}
				type="button"
			></button>
			<aside
				aria-hidden=${String(!drawer.open)}
				aria-label=${drawer.navigationLabel}
				class=${classMap({ "is-open": drawer.open, "mobile-navigation-drawer": true })}
				?inert=${!drawer.open}
			>
				<header>
					<div class="brand">
						<span aria-hidden="true" class="brand-mark">A</span>
						<span>${drawer.brandLabel}</span>
					</div>
					<button
						aria-label="Close navigation"
						class="close-button"
						@click=${this.handleClose}
						title="Close navigation"
						type="button"
					>
						<span aria-hidden="true">x</span>
					</button>
				</header>
				<div class="project">
					<span class="label">Project</span>
					<button
						@click=${this.handleSelectProject}
						type="button"
					>
						<span>${drawer.projectLabel}</span>
						<span aria-hidden="true">v</span>
					</button>
				</div>
				<nav aria-label=${drawer.navigationLabel}>
					${map(drawer.groups, (group) => html`
					<section>
						<h2>${group.label}</h2>
						${map(group.items, (item) => html`
						<button
							aria-current=${item.current ? "page" : "false"}
							class=${classMap({ "is-current": item.current === true, "navigation-item": true })}
							data-item-id=${item.id}
							@click=${this.handleSelectItem}
							type="button"
						>
							<span>${item.label}</span>
							<code>${item.reference}</code>
						</button>
						`)}
					</section>
					`)}
				</nav>
			</aside>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.scrim {
		background: var(--color-overlay-scrim);
		border: var(--size-0);
		cursor: pointer;
		inset: var(--size-0);
		position: fixed;
		width: 100%;
		z-index: 39;
	}
	.mobile-navigation-drawer {
		background: var(--color-surface-sidebar);
		box-shadow: var(--shadow-overlay);
		box-sizing: border-box;
		color: var(--color-text-inverse);
		display: grid;
		gap: var(--size-10);
		grid-template-rows: auto auto minmax(var(--size-0), 1fr);
		inset: var(--size-0) auto var(--size-0) var(--size-0);
		padding: var(--size-10);
		position: fixed;
		transform: translateX(-100%);
		transition: transform 180ms ease-out;
		width: min(var(--size-150), calc(100vw - var(--size-26)));
		z-index: 40;
	}
	.mobile-navigation-drawer.is-open {
		transform: translateX(0);
	}
	header,
	.brand,
	.project button,
	.navigation-item {
		align-items: center;
		display: flex;
	}
	header,
	.project button,
	.navigation-item {
		justify-content: space-between;
	}
	header,
	.brand {
		gap: var(--size-5);
	}
	.brand {
		font-size: var(--font-size-brand);
		font-weight: var(--font-weight-heavy);
	}
	.brand-mark {
		background: var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		display: grid;
		height: var(--size-13);
		place-items: center;
		width: var(--size-13);
	}
	.close-button {
		background: transparent;
		border: var(--border-width) solid var(--color-border-sidebar-control);
		border-radius: var(--radius-control);
		color: var(--color-text-inverse);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-icon-large);
		height: var(--size-16);
		line-height: var(--line-height-ui);
		padding: var(--size-0);
		width: var(--size-16);
	}
	.project {
		display: grid;
		gap: var(--size-4);
	}
	.label {
		color: var(--color-text-tertiary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.project button {
		background: transparent;
		border: var(--border-width) solid var(--color-border-sidebar-strong);
		border-radius: var(--radius-control);
		color: var(--color-surface-panel);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		min-height: var(--size-18);
		padding: var(--size-0) var(--size-5);
		text-align: left;
		width: 100%;
	}
	nav {
		display: grid;
		align-content: start;
		gap: var(--size-8);
		overflow-y: auto;
	}
	nav section {
		border-top: var(--border-width) solid var(--color-border-sidebar);
		display: grid;
		gap: var(--size-2);
		padding-top: var(--size-6);
	}
	h2 {
		color: var(--color-surface-panel);
		font-size: var(--font-size-ui);
		font-weight: var(--font-weight-strong);
		margin: var(--size-0) var(--size-0) var(--size-2);
	}
	.navigation-item {
		background: transparent;
		border: var(--size-0);
		border-radius: var(--radius-control);
		color: var(--color-text-inverse-muted);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-control);
		gap: var(--size-4);
		padding: var(--size-5);
		text-align: left;
	}
	.navigation-item.is-current {
		background: var(--color-surface-sidebar-selected);
		color: var(--color-surface-panel);
	}
	code {
		color: inherit;
		font-size: var(--font-size-label);
	}
	.close-button:hover,
	.project button:hover,
	.navigation-item:hover {
		background: var(--color-surface-sidebar-hover);
	}
	.close-button:focus-visible,
	.project button:focus-visible,
	.navigation-item:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-mobile-navigation-drawer": KanbanMobileNavigationDrawer;
	}

	interface HTMLElementEventMap {
		"kanban-mobile-navigation-drawer-close": CustomEvent;
		"kanban-mobile-navigation-drawer-select-item": CustomEvent<{ itemId: string }>;
		"kanban-mobile-navigation-drawer-select-project": CustomEvent;
	}
}
