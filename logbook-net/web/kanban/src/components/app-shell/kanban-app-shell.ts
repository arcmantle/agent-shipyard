import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export type KanbanAppShellState = {
	mainLabel: string;
	sidebarCollapsed: boolean;
};

export type KanbanAppShellRenderService = {
	appShell: { get(): KanbanAppShellState };
	openMobileNavigation: () => void;
	setSidebarCollapsed: (collapsed: boolean) => void;
};

export const kanbanAppShellRenderServiceContext = createContext<KanbanAppShellRenderService>(
	Symbol("kanban-app-shell-render-service")
);

@customElement("kanban-app-shell")
export class KanbanAppShell extends SignalWatcher(LitElement) {
	@consume({ context: kanbanAppShellRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanAppShellRenderService | undefined;

	protected handleSidebarCollapse = (event: Event) => {
		const { collapsed } = (event as CustomEvent<{ collapsed?: unknown }>).detail;
		if (typeof collapsed !== "boolean") {
			return;
		}

		this.service?.setSidebarCollapsed(collapsed);
	};

	protected handleOpenInitiative = (event: Event) => {
		this.forwardIntent(event, "kanban-app-shell-open-initiative");
	};

	protected handleOpenIssue = (event: Event) => {
		this.forwardIntent(event, "kanban-app-shell-open-issue");
	};

	protected handleOpenMobileNavigation = (event: Event) => {
		this.service?.openMobileNavigation();
		this.forwardIntent(event, "kanban-app-shell-open-mobile-navigation");
	};

	public connectedCallback() {
		super.connectedCallback();
		this.addEventListener("kanban-entity-view-open-issue", this.handleOpenIssue);
		this.addEventListener("kanban-header-open-initiative", this.handleOpenInitiative);
		this.addEventListener("kanban-header-open-mobile-navigation", this.handleOpenMobileNavigation);
		this.addEventListener("kanban-sidebar-collapse", this.handleSidebarCollapse);
	}

	public disconnectedCallback() {
		this.removeEventListener("kanban-entity-view-open-issue", this.handleOpenIssue);
		this.removeEventListener("kanban-header-open-initiative", this.handleOpenInitiative);
		this.removeEventListener("kanban-header-open-mobile-navigation", this.handleOpenMobileNavigation);
		this.removeEventListener("kanban-sidebar-collapse", this.handleSidebarCollapse);
		super.disconnectedCallback();
	}

	protected forwardIntent(event: Event, eventName: string) {
		event.stopPropagation();
		this.dispatchEvent(
			new CustomEvent(eventName, {
				bubbles: true,
				composed: true,
				detail: (event as CustomEvent<unknown>).detail
			})
		);
	}

	protected render() {
		const appShell = this.service?.appShell.get();
		if (appShell === undefined) {
			return html``;
		}

		return html`
		<section class=${classMap({ "app-shell": true, "is-sidebar-collapsed": appShell.sidebarCollapsed })}>
			<slot name="sidebar"></slot>
			<main aria-label=${appShell.mainLabel}>
				<slot name="header"></slot>
				<slot name="tabs"></slot>
				<slot name="content"></slot>
			</main>
		</section>
		<slot name="mobile-navigation-drawer"></slot>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-height: 100vh;
	}
	.app-shell {
		display: grid;
		grid-template-columns: var(--size-150) minmax(var(--size-0), 1fr);
		min-height: 100vh;
		transition: grid-template-columns 180ms ease-out;
	}
	.app-shell.is-sidebar-collapsed {
		grid-template-columns: var(--size-38) minmax(var(--size-0), 1fr);
	}
	main {
		min-width: var(--size-0);
	}
	@media (max-width: 47.5rem) {
		.app-shell {
			grid-template-columns: 1fr;
		}
		::slotted([slot="sidebar"]) {
			display: none;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-app-shell": KanbanAppShell;
	}

	interface HTMLElementEventMap {
		"kanban-app-shell-open-initiative": CustomEvent<unknown>;
		"kanban-app-shell-open-issue": CustomEvent<unknown>;
		"kanban-app-shell-open-mobile-navigation": CustomEvent<void>;
	}
}