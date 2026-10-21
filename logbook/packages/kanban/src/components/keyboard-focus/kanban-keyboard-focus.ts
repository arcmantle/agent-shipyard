import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";

export type KanbanKeyboardFocusControlKind = "button" | "link" | "select";

export type KanbanKeyboardFocusButtonControl = {
	disabled: boolean;
	id: string;
	kind: "button";
	label: string;
};

export type KanbanKeyboardFocusLinkControl = {
	disabled: boolean;
	href: string;
	id: string;
	kind: "link";
	label: string;
};

export type KanbanKeyboardFocusSelectControl = {
	disabled: boolean;
	id: string;
	kind: "select";
	label: string;
	options: readonly string[];
	value: string;
};

export type KanbanKeyboardFocusControl =
	| KanbanKeyboardFocusButtonControl
	| KanbanKeyboardFocusLinkControl
	| KanbanKeyboardFocusSelectControl;

export type KanbanKeyboardFocusState = {
	controls: readonly KanbanKeyboardFocusControl[];
	description: string;
	title: string;
	typeLabel: string;
};

export type KanbanKeyboardFocusRenderService = {
	activate: (controlId: string) => void;
	change: (controlId: string, value: string) => void;
	keyboardFocus: { get(): KanbanKeyboardFocusState };
};

export const kanbanKeyboardFocusRenderServiceContext = createContext<KanbanKeyboardFocusRenderService>(
	Symbol("kanban-keyboard-focus-render-service")
);

@customElement("kanban-keyboard-focus")
export class KanbanKeyboardFocus extends SignalWatcher(LitElement) {
	@consume({ context: kanbanKeyboardFocusRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanKeyboardFocusRenderService | undefined;

	protected handleActivate(controlId: string) {
		this.service?.activate(controlId);
		this.dispatchEvent(
			new CustomEvent("kanban-keyboard-focus-activate", {
				bubbles: true,
				composed: true,
				detail: { controlId }
			})
		);
	}

	protected handleChange(controlId: string, value: string) {
		this.service?.change(controlId, value);
		this.dispatchEvent(
			new CustomEvent("kanban-keyboard-focus-change", {
				bubbles: true,
				composed: true,
				detail: { controlId, value }
			})
		);
	}

	protected handleSelectChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		this.handleChange(select.dataset.controlId ?? "", select.value);
	}

	protected handleLinkActivate(event: Event) {
		const link = event.currentTarget as HTMLAnchorElement;
		if (link.getAttribute("aria-disabled") === "true") {
			event.preventDefault();
			return;
		}

		this.handleActivate(link.dataset.controlId ?? "");
	}

	protected getLinkHref(control: KanbanKeyboardFocusLinkControl) {
		if (control.disabled) {
			return undefined;
		}

		return control.href;
	}

	protected getDisabledLinkTabIndex(disabled: boolean) {
		if (disabled) {
			return -1;
		}

		return undefined;
	}

	protected renderButton(control: KanbanKeyboardFocusButtonControl) {
		return html`
		<button
			class="keyboard-focus-control"
			?disabled=${control.disabled}
			@click=${() => this.handleActivate(control.id)}
			type="button"
		>
			${control.label}
		</button>
		`;
	}

	protected renderLink(control: KanbanKeyboardFocusLinkControl) {
		return html`
		<a
			aria-disabled=${String(control.disabled)}
			class="keyboard-focus-control keyboard-focus-link"
			data-control-id=${control.id}
			href=${ifDefined(this.getLinkHref(control))}
			@click=${this.handleLinkActivate}
			tabindex=${ifDefined(this.getDisabledLinkTabIndex(control.disabled))}
		>
			${control.label}
		</a>
		`;
	}

	protected renderSelect(control: KanbanKeyboardFocusSelectControl) {
		return html`
		<label class="keyboard-focus-field">
			${control.label}
			<select
				class="keyboard-focus-control"
				data-control-id=${control.id}
				?disabled=${control.disabled}
				@change=${this.handleSelectChange}
				.value=${live(control.value)}
			>
				${map(control.options, (option) => html`
				<option value=${option}>
					${option}
				</option>
				`)}
			</select>
		</label>
		`;
	}

	protected renderControl(control: KanbanKeyboardFocusControl) {
		return choose(control.kind, [
			[ "button", () => this.renderButton(control as KanbanKeyboardFocusButtonControl) ],
			[ "link", () => this.renderLink(control as KanbanKeyboardFocusLinkControl) ],
			[ "select", () => this.renderSelect(control as KanbanKeyboardFocusSelectControl) ]
		]);
	}

	protected render() {
		const keyboardFocus = this.service?.keyboardFocus.get();
		if (keyboardFocus === undefined) {
			return html``;
		}

		const titleId = "keyboard-focus-title";

		return html`
		<section
			aria-labelledby=${titleId}
			class="keyboard-focus-preview"
		>
			<header>
				<span class="type-label">${keyboardFocus.typeLabel}</span>
				<h2 id=${titleId}>${keyboardFocus.title}</h2>
			</header>
			${when(keyboardFocus.description.length > 0, () => html`
			<p>${keyboardFocus.description}</p>
			`)}
			<div class="keyboard-focus-controls">
				${map(keyboardFocus.controls, (control) => this.renderControl(control))}
			</div>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.keyboard-focus-preview {
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-preview);
		border-radius: var(--radius-panel);
		display: grid;
		gap: var(--size-7);
		padding: var(--size-12);
	}
	header {
		display: grid;
		gap: var(--size-2);
	}
	.type-label {
		font-family: var(--font-family-ui);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	h2 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-title);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-tight);
		margin: var(--size-0);
	}
	p {
		color: var(--color-text-secondary);
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
	}
	.keyboard-focus-controls {
		align-items: end;
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-5);
	}
	.keyboard-focus-control {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-text-primary);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		font-family: var(--font-family-ui);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-heavy);
		line-height: var(--line-height-ui);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-7);
		text-decoration: none;
	}
	.keyboard-focus-control:hover:not(:disabled):not([aria-disabled="true"]) {
		background: var(--color-surface-subtle);
	}
	.keyboard-focus-control:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-2);
	}
	.keyboard-focus-link {
		align-items: center;
		display: inline-flex;
	}
	.keyboard-focus-field {
		color: var(--color-text-secondary);
		display: grid;
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-2);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}
	.keyboard-focus-field select {
		font-weight: var(--font-weight-strong);
		width: 100%;
	}
	.keyboard-focus-control:disabled,
	.keyboard-focus-control[aria-disabled="true"] {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	@media (max-width: 31.25rem) {
		.keyboard-focus-preview {
			padding: var(--size-8);
		}
		.keyboard-focus-controls {
			align-items: stretch;
			display: grid;
			grid-template-columns: 1fr;
		}
		.keyboard-focus-control {
			width: 100%;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-keyboard-focus": KanbanKeyboardFocus;
	}

	interface HTMLElementEventMap {
		"kanban-keyboard-focus-activate": CustomEvent<{ controlId: string }>;
		"kanban-keyboard-focus-change": CustomEvent<{ controlId: string; value: string }>;
	}
}
