import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { when } from "lit/directives/when.js";

export type KanbanButtonVariant = "primary" | "secondary" | "quiet" | "destructive";

export type KanbanButtonState = {
	disabled: boolean;
	label: string;
	loading: boolean;
	variant: KanbanButtonVariant;
};

export type KanbanButtonRenderService = {
	activate: () => void;
	button: { get(): KanbanButtonState };
};

export const kanbanButtonRenderServiceContext = createContext<KanbanButtonRenderService>(Symbol("kanban-button-render-service"));

@customElement("kanban-button")
export class KanbanButton extends SignalWatcher(LitElement) {
	@consume({ context: kanbanButtonRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanButtonRenderService | undefined;

	protected handleActivate() {
		this.service?.activate();
		this.dispatchEvent(new CustomEvent("kanban-button-activate", { bubbles: true, composed: true }));
	}

	protected render() {
		const button = this.service?.button.get();
		if (button === undefined) {
			return html``;
		}

		return html`
		<button
			aria-busy=${String(button.loading)}
			class=${classMap({
				"command-button": true,
				"is-destructive": button.variant === "destructive",
				"is-primary": button.variant === "primary",
				"is-quiet": button.variant === "quiet",
				"is-secondary": button.variant === "secondary"
			})}
			?disabled=${button.disabled || button.loading}
			@click=${this.handleActivate}
			type="button"
		>
			${when(
				button.loading,
				() => html`
				<span
					aria-hidden="true"
					class="spinner"
				></span>
				`
			)}
			<span>${button.label}</span>
		</button>
		`;
	}

	public static styles = css`
	:host {
		display: inline-block;
	}
	.command-button {
		align-items: center;
		background: var(--color-accent);
		border: var(--border-width) solid transparent;
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		cursor: pointer;
		display: inline-flex;
		font-family: var(--font-family-ui);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-3);
		justify-content: center;
		line-height: var(--line-height-ui);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-7);
	}
	.command-button:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.command-button.is-primary:hover {
		background: var(--color-accent-secondary);
	}
	.command-button.is-secondary {
		background: var(--color-surface-panel);
		border-color: var(--color-text-primary);
		color: var(--color-text-primary);
	}
	.command-button.is-secondary:hover {
		background: var(--color-surface-subtle);
	}
	.command-button.is-quiet {
		background: transparent;
		color: var(--color-text-primary);
	}
	.command-button.is-quiet:hover {
		background: var(--color-surface-subtle);
	}
	.command-button.is-destructive {
		background: var(--color-status-blocked-surface);
		border-color: var(--color-status-blocked-border);
		color: var(--color-status-blocked-text);
	}
	.command-button.is-destructive:hover {
		background: var(--color-status-blocked-label);
	}
	.command-button:disabled,
	.command-button:disabled:hover {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	.spinner {
		animation: spin 700ms linear infinite;
		border: var(--size-1) solid currentColor;
		border-right-color: transparent;
		border-radius: 50%;
		height: var(--size-6);
		width: var(--size-6);
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-button": KanbanButton;
	}

	interface HTMLElementEventMap {
		"kanban-button-activate": CustomEvent;
	}
}