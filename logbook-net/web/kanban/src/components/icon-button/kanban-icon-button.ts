import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { choose } from "lit/directives/choose.js";
import { when } from "lit/directives/when.js";

export type KanbanIconButtonAction = "close" | "create" | "collapse" | "overflow";

export type KanbanIconButtonState = {
	action: KanbanIconButtonAction;
	disabled: boolean;
	label: string;
	loading: boolean;
};

export type KanbanIconButtonRenderService = {
	activate: () => void;
	iconButton: { get(): KanbanIconButtonState };
};

export const kanbanIconButtonRenderServiceContext = createContext<KanbanIconButtonRenderService>(
	Symbol("kanban-icon-button-render-service")
);

@customElement("kanban-icon-button")
export class KanbanIconButton extends SignalWatcher(LitElement) {
	@consume({ context: kanbanIconButtonRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanIconButtonRenderService | undefined;

	protected handleActivate() {
		this.service?.activate();
		this.dispatchEvent(new CustomEvent("kanban-icon-button-activate", { bubbles: true, composed: true }));
	}

	protected renderIcon(action: KanbanIconButtonAction) {
		return choose(action, [
			[ "close", () => html`×` ],
			[ "create", () => html`+` ],
			[ "collapse", () => html`‹` ],
			[ "overflow", () => html`…` ]
		]);
	}

	protected render() {
		const iconButton = this.service?.iconButton.get();
		if (iconButton === undefined) {
			return html``;
		}

		return html`
		<button
			aria-busy=${String(iconButton.loading)}
			aria-label=${iconButton.label}
			class=${classMap({
				"icon-button": true,
				"is-loading": iconButton.loading
			})}
			?disabled=${iconButton.disabled || iconButton.loading}
			@click=${this.handleActivate}
			title=${iconButton.label}
			type="button"
		>
			<span aria-hidden="true">
				${when(
					iconButton.loading,
					() => nothing,
					() => this.renderIcon(iconButton.action)
				)}
			</span>
		</button>
		`;
	}

	public static styles = css`
	:host {
		display: inline-block;
	}
	.icon-button {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		display: inline-grid;
		height: var(--size-16);
		place-items: center;
		width: var(--size-16);
	}
	.icon-button:hover {
		background: var(--color-surface-subtle);
		border-color: var(--color-text-primary);
	}
	.icon-button:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.icon-button:disabled {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	.icon-button > span {
		font-size: var(--font-size-icon-large);
		font-weight: var(--font-weight-medium);
		line-height: 1;
	}
	.icon-button.is-loading > span {
		animation: icon-button-spin .7s linear infinite;
		border: var(--size-1) solid var(--color-text-tertiary);
		border-radius: 50%;
		border-right-color: transparent;
		font-size: var(--size-0);
		height: var(--size-7);
		width: var(--size-7);
	}
	@keyframes icon-button-spin {
		to {
			transform: rotate(1turn);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-icon-button": KanbanIconButton;
	}

	interface HTMLElementEventMap {
		"kanban-icon-button-activate": CustomEvent;
	}
}
