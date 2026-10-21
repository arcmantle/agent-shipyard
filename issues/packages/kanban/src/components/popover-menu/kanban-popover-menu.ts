import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

export type KanbanPopoverMenuAction = {
	id: string;
	label: string;
	tone?: "danger";
};

export type KanbanPopoverMenuState = {
	actions: readonly KanbanPopoverMenuAction[];
	label: string;
};

export type KanbanPopoverMenuRenderService = {
	menu: { get(): KanbanPopoverMenuState };
	performAction: (actionId: string) => void;
};

export const kanbanPopoverMenuRenderServiceContext = createContext<KanbanPopoverMenuRenderService>(
	Symbol("kanban-popover-menu-render-service")
);

let popoverMenuId = 0;

@customElement("kanban-popover-menu")
export class KanbanPopoverMenu extends SignalWatcher(LitElement) {
	constructor() {
		super();
		this.menuId = `popover-menu-${++popoverMenuId}`;
	}

	@consume({ context: kanbanPopoverMenuRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanPopoverMenuRenderService | undefined;

	@state()
	protected menuOpen = false;

	protected menuId: string;

	protected closeMenu() {
		const menu = this.getMenu();
		if (menu === null || !this.menuOpen) {
			return;
		}

		menu.hidePopover();
	}

	protected getMenu(): HTMLElement | null {
		return this.shadowRoot?.querySelector<HTMLElement>("[role=menu]") ?? null;
	}

	protected getTrigger(): HTMLButtonElement | null {
		return this.shadowRoot?.querySelector<HTMLButtonElement>(".popover-menu > button") ?? null;
	}

	protected handleActionClick(event: MouseEvent) {
		const actionId = (event.currentTarget as HTMLElement).dataset.actionId;
		const service = this.service;
		if (service === undefined || actionId === undefined) {
			return;
		}

		service.performAction(actionId);
		this.dispatchEvent(
			new CustomEvent("kanban-popover-action", {
				bubbles: true,
				composed: true,
				detail: { actionId }
			})
		);
		this.closeMenu();
		this.getTrigger()?.focus();
	}

	protected handleMenuKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape") {
			return;
		}

		event.preventDefault();
		this.closeMenu();
		this.getTrigger()?.focus();
	}

	protected handleMenuToggle(event: Event) {
		this.menuOpen = (event as ToggleEvent).newState === "open";
	}

	protected handleTriggerClick() {
		if (this.menuOpen) {
			this.closeMenu();
			return;
		}

		this.openMenu();
	}

	protected openMenu() {
		const menu = this.getMenu();
		if (menu === null || this.menuOpen) {
			return;
		}

		menu.showPopover();
	}

	protected render() {
		const menu = this.service?.menu.get();
		if (menu === undefined) {
			return html``;
		}

		return html`
		<div class="popover-menu">
			<button
				aria-controls=${this.menuId}
				aria-expanded=${String(this.menuOpen)}
				aria-haspopup="menu"
				@click=${this.handleTriggerClick}
				type="button"
			>
				${menu.label}
				<span aria-hidden="true">...</span>
			</button>
			<div
				aria-label=${menu.label}
				id=${this.menuId}
				popover="auto"
				role="menu"
				@keydown=${this.handleMenuKeydown}
				@toggle=${this.handleMenuToggle}
			>
				${map(menu.actions, (action) => html`
				<button
					data-action-id=${action.id}
					data-tone=${action.tone ?? ""}
					@click=${this.handleActionClick}
					role="menuitem"
					type="button"
				>
					${action.label}
				</button>
				`)}
			</div>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: inline-block;
	}
	.popover-menu {
		display: inline-block;
		position: relative;
	}
	button {
		font: inherit;
	}
	.popover-menu > button {
		align-items: center;
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		display: inline-flex;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-4);
		line-height: var(--line-height-ui);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-6);
	}
	.popover-menu > button:hover,
	.popover-menu > button[aria-expanded=true] {
		background: var(--color-surface-subtle);
		border-color: var(--color-text-primary);
	}
	button:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	[role=menu] {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-card-hover);
		display: grid;
		min-width: var(--size-80);
		padding: var(--size-3);
		position: fixed;
	}
	[role=menu] button {
		background: transparent;
		border: var(--size-0);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		padding: var(--size-5) var(--size-6);
		text-align: left;
		white-space: nowrap;
	}
	[role=menu] button:hover {
		background: var(--color-surface-subtle);
	}
	[role=menu] button[data-tone=danger] {
		color: var(--color-status-blocked-text);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-popover-menu": KanbanPopoverMenu;
	}

	interface HTMLElementEventMap {
		"kanban-popover-action": CustomEvent<{ actionId: string }>;
	}
}