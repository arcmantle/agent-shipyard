import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanIssueOverlayState = {
	detail: string;
	label: string;
	open: boolean;
	reference: string;
	title: string;
};

export type KanbanIssueOverlayRenderService = {
	close: () => void;
	issueOverlay: { get(): KanbanIssueOverlayState };
};

export const kanbanIssueOverlayRenderServiceContext = createContext<KanbanIssueOverlayRenderService>(
	Symbol("kanban-issue-overlay-render-service")
);

@customElement("kanban-issue-overlay")
export class KanbanIssueOverlay extends SignalWatcher(LitElement) {
	@consume({ context: kanbanIssueOverlayRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanIssueOverlayRenderService | undefined;

	protected handleDocumentKeyDown = (event: KeyboardEvent) => {
		this.handleKeyDown(event);
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
		const issueOverlay = this.service?.issueOverlay.get();
		if (issueOverlay === undefined || !issueOverlay.open) {
			return;
		}

		this.service?.close();
		this.dispatchEvent(new CustomEvent("kanban-issue-overlay-close", { bubbles: true, composed: true }));
	}

	protected handleKeyDown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			this.handleClose();
		}
	}

	protected render() {
		const issueOverlay = this.service?.issueOverlay.get();
		if (issueOverlay === undefined) {
			return html``;
		}

		return html`
		<div
			?hidden=${!issueOverlay.open}
			class="overlay-shell"
		>
			<div
				aria-hidden="true"
				class="scrim"
				@click=${this.handleClose}
			></div>
			<aside
				aria-label=${issueOverlay.label}
				aria-modal="true"
				class="issue-overlay"
				role="dialog"
				tabindex="-1"
			>
				<header>
					<div class="issue-heading">
						<span class="reference">${issueOverlay.reference}</span>
						<h2>${issueOverlay.title}</h2>
					</div>
					<button
						aria-label=${`Close ${issueOverlay.label}`}
						@click=${this.handleClose}
						type="button"
					>
						<span aria-hidden="true">×</span>
					</button>
				</header>
				<div class="metadata">
					<span>${issueOverlay.detail}</span>
					<slot name="metadata"></slot>
				</div>
				<div class="content">
					<slot></slot>
				</div>
			</aside>
		</div>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.overlay-shell {
		inset: var(--size-0);
		position: fixed;
		z-index: 2;
	}
	.scrim {
		background: var(--color-overlay-scrim);
		inset: var(--size-0);
		position: absolute;
	}
	.issue-overlay {
		background: var(--color-surface-canvas);
		border-left: var(--border-width) solid var(--color-border-subtle);
		box-shadow: var(--shadow-overlay);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		height: 100%;
		inset: var(--size-0) var(--size-0) auto auto;
		max-width: 100%;
		position: absolute;
		width: var(--size-310);
	}
	header {
		align-items: flex-start;
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: flex;
		gap: var(--size-8);
		justify-content: space-between;
		padding: var(--size-11) var(--size-12) var(--size-9);
	}
	.issue-heading {
		display: grid;
		gap: var(--size-2);
	}
	.reference,
	.metadata {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
	}
	h2 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-title);
		font-weight: var(--font-weight-display);
		line-height: var(--line-height-tight);
		margin: var(--size-0);
		overflow-wrap: anywhere;
	}
	button {
		align-items: center;
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		display: inline-flex;
		font: inherit;
		font-size: var(--font-size-icon);
		height: var(--size-14);
		justify-content: center;
		padding: var(--size-0);
		width: var(--size-14);
	}
	button:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.metadata {
		align-items: center;
		border-bottom: var(--border-width) solid var(--color-border-subtle);
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-4);
		padding: var(--size-7) var(--size-12);
	}
	.content {
		flex: 1 1 auto;
		overflow-y: auto;
		padding: var(--size-12);
	}
	@media (max-width: 700px) {
		.issue-overlay {
			width: 100%;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-issue-overlay": KanbanIssueOverlay;
	}

	interface HTMLElementEventMap {
		"kanban-issue-overlay-close": CustomEvent;
	}
}