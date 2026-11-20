import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";

export type KanbanShortcutHintState = {
	keys: readonly string[];
};

export type KanbanShortcutHintRenderService = {
	shortcutHint: { get(): KanbanShortcutHintState };
};

export const kanbanShortcutHintRenderServiceContext = createContext<KanbanShortcutHintRenderService>(Symbol("kanban-shortcut-hint-render-service"));

@customElement("kanban-shortcut-hint")
export class KanbanShortcutHint extends SignalWatcher(LitElement) {
	@consume({ context: kanbanShortcutHintRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanShortcutHintRenderService | undefined;

	protected render() {
		const shortcutHint = this.service?.shortcutHint.get();
		if (shortcutHint === undefined) {
			return html``;
		}

		return html`
		<span
			aria-label=${`Keyboard shortcut: ${shortcutHint.keys.join(" plus ")}`}
			role="group"
		>
			${map(shortcutHint.keys, (key, index) => html`
				${when(index > 0, () => html`<span aria-hidden="true" class="shortcut-separator">+</span>`)}
				<kbd>${key}</kbd>
			`)}
		</span>
		`;
	}

	public static styles = css`
	:host,
	span {
		align-items: center;
		display: inline-flex;
	}
	span {
		color: var(--color-text-secondary);
		font-family: var(--font-family-mono);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		gap: var(--size-1);
		line-height: var(--line-height-ui);
		white-space: nowrap;
	}
	kbd {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-bottom-width: var(--size-1);
		border-radius: var(--radius-control);
		box-shadow: var(--shadow-card);
		color: var(--color-text-primary);
		font: inherit;
		min-width: var(--size-10);
		padding: var(--size-2) var(--size-3);
		text-align: center;
	}
	.shortcut-separator {
		color: var(--color-text-tertiary);
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-shortcut-hint": KanbanShortcutHint;
	}
}