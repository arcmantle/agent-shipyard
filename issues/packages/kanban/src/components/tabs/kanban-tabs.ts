import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";

export type KanbanTab = {
	id: string;
	label: string;
};

export type KanbanTabsState = {
	activeTabId: string;
	tabs: readonly KanbanTab[];
};

export type KanbanTabsRenderService = {
	selectTab: (tabId: string) => void;
	tabs: { get(): KanbanTabsState };
};

export const kanbanTabsRenderServiceContext = createContext<KanbanTabsRenderService>(Symbol("kanban-tabs-render-service"));

@customElement("kanban-tabs")
export class KanbanTabs extends SignalWatcher(LitElement) {
	@consume({ context: kanbanTabsRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanTabsRenderService | undefined;

	protected handleSelect(event: MouseEvent) {
		const tab = event.currentTarget as HTMLButtonElement;
		const tabId = tab.dataset.tabId;
		if (tabId === undefined) {
			return;
		}

		this.service?.selectTab(tabId);
		this.dispatchEvent(new CustomEvent("kanban-tabs-select", {
			bubbles: true,
			composed: true,
			detail: { tabId }
		}));
	}

	protected getAriaCurrent(tabId: string, activeTabId: string): "false" | "page" {
		return tabId === activeTabId ? "page" : "false";
	}

	protected render() {
		const tabs = this.service?.tabs.get();
		if (tabs === undefined) {
			return html``;
		}

		return html`
		<nav
			aria-label="Entity views"
			class="entity-tabs"
		>
			${map(tabs.tabs, (tab) => html`
			<button
				aria-current=${this.getAriaCurrent(tab.id, tabs.activeTabId)}
				class=${classMap({ "entity-tab": true, "is-active": tab.id === tabs.activeTabId })}
				data-tab-id=${tab.id}
				@click=${this.handleSelect}
				type="button"
			>
				${tab.label}
			</button>
			`)}
		</nav>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}

	.entity-tabs {
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: flex;
		gap: var(--size-1);
		overflow-x: auto;
	}

	.entity-tab {
		background: transparent;
		border: var(--size-0);
		border-bottom: var(--size-1) solid transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		flex: 0 0 auto;
		font-family: var(--font-family-ui);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-heavy);
		padding: var(--size-5) var(--size-6);
	}

	.entity-tab.is-active {
		border-bottom-color: var(--color-text-primary);
		color: var(--color-text-primary);
	}

	.entity-tab:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-tabs": KanbanTabs;
	}

	interface HTMLElementEventMap {
		"kanban-tabs-select": CustomEvent<{ tabId: string }>;
	}
}