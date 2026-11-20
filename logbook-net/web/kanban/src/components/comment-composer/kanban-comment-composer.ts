import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";

export type KanbanCommentComposerState = {
	isPosting: boolean;
	message: string;
	placeholder: string;
	postLabel: string;
};

export type KanbanCommentComposerRenderService = {
	commentComposer: { get(): KanbanCommentComposerState };
	postComment: (message: string) => void;
	setMessage: (message: string) => void;
};

export const kanbanCommentComposerRenderServiceContext = createContext<KanbanCommentComposerRenderService>(
	Symbol("kanban-comment-composer-render-service")
);

@customElement("kanban-comment-composer")
export class KanbanCommentComposer extends SignalWatcher(LitElement) {
	public static composerCount = 0;

	constructor() {
		super();
		KanbanCommentComposer.composerCount += 1;
		this.inputId = `comment-message-${KanbanCommentComposer.composerCount}`;
	}

	@consume({ context: kanbanCommentComposerRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanCommentComposerRenderService | undefined;

	protected inputId: string;

	protected handleInput(event: Event) {
		const message = (event.currentTarget as HTMLTextAreaElement).value;
		this.service?.setMessage(message);
		this.dispatchEvent(new CustomEvent("kanban-comment-message-change", {
			bubbles: true,
			composed: true,
			detail: { message }
		}));
	}

	protected handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		const composer = this.service?.commentComposer.get();
		const message = new FormData(event.currentTarget as HTMLFormElement).get("message");
		if (composer === undefined || composer.isPosting || typeof message !== "string" || message.trim() === "") {
			return;
		}

		const detail = { message: message.trim() };
		this.service?.postComment(detail.message);
		this.dispatchEvent(new CustomEvent("kanban-comment-post", {
			bubbles: true,
			composed: true,
			detail
		}));
	}

	protected render() {
		const composer = this.service?.commentComposer.get();
		if (composer === undefined) {
			return html``;
		}

		const isPostDisabled = composer.isPosting || composer.message.trim() === "";
		return html`
		<form
			aria-busy=${String(composer.isPosting)}
			class="comment-composer"
			@submit=${this.handleSubmit}
		>
			<label
				class="comment-composer-label"
				for=${this.inputId}
			>
				New comment
			</label>
			<textarea
				?disabled=${composer.isPosting}
				id=${this.inputId}
				name="message"
				placeholder=${composer.placeholder}
				rows="3"
				.value=${composer.message}
				@input=${this.handleInput}
			></textarea>
			<div class="comment-composer-actions">
				<span>Comments are visible to project members.</span>
				<button
					?disabled=${isPostDisabled}
					type="submit"
				>
					${composer.postLabel}
				</button>
			</div>
		</form>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	.comment-composer {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-panel);
		display: grid;
		gap: var(--size-5);
		padding: var(--size-6);
	}
	.comment-composer-label {
		clip: rect(0 0 0 0);
		height: var(--size-1);
		overflow: hidden;
		position: absolute;
		white-space: nowrap;
		width: var(--size-1);
	}
	.comment-composer textarea {
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		font: inherit;
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		min-height: var(--size-38);
		padding: var(--size-5);
		resize: vertical;
		width: 100%;
	}
	.comment-composer textarea::placeholder {
		color: var(--color-text-tertiary);
	}
	.comment-composer textarea:focus-visible,
	.comment-composer button:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}
	.comment-composer-actions {
		align-items: center;
		color: var(--color-text-secondary);
		display: flex;
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		gap: var(--size-5);
		justify-content: space-between;
	}
	.comment-composer button {
		background: var(--color-text-primary);
		border: var(--border-width) solid var(--color-text-primary);
		border-radius: var(--radius-control);
		color: var(--color-surface-panel);
		cursor: pointer;
		font: inherit;
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-heavy);
		min-height: var(--size-19);
		padding: var(--size-5) var(--size-7);
	}
	.comment-composer button:hover:not(:disabled) {
		background: var(--color-surface-sidebar);
	}
	.comment-composer button:disabled {
		background: var(--color-surface-subtle);
		border-color: var(--color-border-subtle);
		color: var(--color-text-tertiary);
		cursor: not-allowed;
	}
	@media (max-width: 31.25rem) {
		.comment-composer-actions {
			align-items: stretch;
			flex-direction: column;
		}
		.comment-composer button {
			width: 100%;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-comment-composer": KanbanCommentComposer;
	}

	interface HTMLElementEventMap {
		"kanban-comment-message-change": CustomEvent<{ message: string }>;
		"kanban-comment-post": CustomEvent<{ message: string }>;
	}
}