import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

export type KanbanSelectMenuOption = {
	label: string;
	value: string;
};

export type KanbanSelectMenuState = {
	disabled: boolean;
	label: string;
	name: string;
	options: readonly KanbanSelectMenuOption[];
	value: string;
};

export type KanbanSelectMenuRenderService = {
	select: (value: string) => void;
	selectMenu: { get(): KanbanSelectMenuState };
};

export const kanbanSelectMenuRenderServiceContext = createContext<KanbanSelectMenuRenderService>(
	Symbol("kanban-select-menu-render-service")
);

let selectMenuId = 0;

@customElement("kanban-select-menu")
export class KanbanSelectMenu extends SignalWatcher(LitElement) {
	constructor() {
		super();
		this.triggerId = `select-menu-trigger-${++selectMenuId}`;
		this.listboxId = `select-menu-listbox-${selectMenuId}`;
	}

	@consume({ context: kanbanSelectMenuRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanSelectMenuRenderService | undefined;

	@state()
	protected listboxOpen = false;

	protected listboxId: string;

	protected triggerId: string;

	protected closeListbox() {
		const listbox = this.getListbox();
		if (listbox === null || !this.listboxOpen) {
			return;
		}

		listbox.hidePopover();
	}

	protected getListbox(): HTMLElement | null {
		return this.shadowRoot?.querySelector<HTMLElement>("[role=listbox]") ?? null;
	}

	protected getOptionElements(): HTMLElement[] {
		return [ ...(this.shadowRoot?.querySelectorAll<HTMLElement>("[role=option]") ?? []) ];
	}

	protected getTrigger(): HTMLButtonElement | null {
		return this.shadowRoot?.querySelector<HTMLButtonElement>("button.select-menu-trigger") ?? null;
	}

	protected handleListboxToggle(event: Event) {
		this.listboxOpen = (event as ToggleEvent).newState === "open";
	}

	protected handleOptionClick(event: MouseEvent) {
		const option = event.currentTarget as HTMLElement;
		this.selectOption(option.dataset.value);
	}

	protected handleOptionKeydown(event: KeyboardEvent) {
		const option = event.currentTarget as HTMLElement;
		const options = this.getOptionElements();
		const optionIndex = options.indexOf(option);
		if (event.key === "ArrowDown") {
			event.preventDefault();
			options[(optionIndex + 1) % options.length]?.focus();
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			options[(optionIndex - 1 + options.length) % options.length]?.focus();
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			options[0]?.focus();
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			options.at(-1)?.focus();
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			this.selectOption(option.dataset.value);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.closeListbox();
			this.getTrigger()?.focus();
		}
	}

	protected handleTriggerClick() {
		if (this.listboxOpen) {
			this.closeListbox();
			return;
		}

		this.openListbox();
	}

	protected handleTriggerKeydown(event: KeyboardEvent) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}

		event.preventDefault();
		this.openListbox();
		const options = this.getOptionElements();
		if (event.key === "ArrowDown") {
			options[0]?.focus();
			return;
		}

		options.at(-1)?.focus();
	}

	protected openListbox() {
		const listbox = this.getListbox();
		if (listbox === null || this.listboxOpen) {
			return;
		}

		listbox.showPopover();
	}

	protected selectOption(value: string | undefined) {
		const service = this.service;
		const selectMenu = service?.selectMenu.get();
		if (service === undefined || selectMenu === undefined || selectMenu.disabled || value === undefined) {
			return;
		}

		service.select(value);
		this.dispatchEvent(
			new CustomEvent("kanban-select-menu-change", {
				bubbles: true,
				composed: true,
				detail: {
					name: selectMenu.name,
					value
				}
			})
		);
		this.closeListbox();
		this.getTrigger()?.focus();
	}

	protected render() {
		const selectMenu = this.service?.selectMenu.get();
		if (selectMenu === undefined) {
			return html``;
		}

		return html`
		<div class="select-menu">
			<label for=${this.triggerId}>${selectMenu.label}</label>
			<button
				aria-controls=${this.listboxId}
				aria-expanded=${String(this.listboxOpen)}
				aria-haspopup="listbox"
				class="select-menu-trigger"
				?disabled=${selectMenu.disabled}
				id=${this.triggerId}
				@keydown=${this.handleTriggerKeydown}
				@click=${this.handleTriggerClick}
				type="button"
			>
				${selectMenu.options.find((option) => option.value === selectMenu.value)?.label}
			</button>
			<div
				aria-label=${selectMenu.label}
				id=${this.listboxId}
				popover="auto"
				role="listbox"
				@toggle=${this.handleListboxToggle}
			>
				${map(selectMenu.options, (option) => html`
				<div
					aria-selected=${String(option.value === selectMenu.value)}
					data-value=${option.value}
					role="option"
					tabindex=${option.value === selectMenu.value ? "0" : "-1"}
					@click=${this.handleOptionClick}
					@keydown=${this.handleOptionKeydown}
				>
					${option.label}
				</div>
				`)}
			</div>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.select-menu {
		display: grid;
		gap: var(--size-4);
	}
	.select-menu label {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.select-menu-trigger {
		anchor-name: --select-menu-trigger;
		align-items: center;
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		display: flex;
		font: inherit;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		justify-content: space-between;
		line-height: var(--line-height-ui);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-7);
		text-align: left;
		width: 100%;
	}
	.select-menu-trigger::after {
		border: var(--size-2) solid transparent;
		border-top-color: currentColor;
		content: "";
		margin-left: var(--size-4);
		margin-top: var(--size-1);
	}
	.select-menu-trigger:hover {
		border-color: var(--color-text-primary);
	}
	.select-menu-trigger:focus-visible,
	[role=option]:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.select-menu-trigger:disabled {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	[role=listbox] {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		box-shadow: 0 var(--size-6) var(--size-14) var(--color-overlay-preview-scrim);
		margin: var(--size-4) var(--size-0) var(--size-0);
		min-width: anchor-size(width);
		overflow: hidden;
		padding: var(--size-2);
		position: fixed;
		position-anchor: --select-menu-trigger;
		left: anchor(left);
		top: anchor(bottom);
	}
	[role=option] {
		cursor: pointer;
		padding: var(--size-5) var(--size-7);
	}
	[role=option]:hover,
	[role=option][aria-selected=true] {
		background: var(--color-surface-subtle);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-select-menu": KanbanSelectMenu;
	}

	interface HTMLElementEventMap {
		"kanban-select-menu-change": CustomEvent<{ name: string; value: string }>;
	}
}
