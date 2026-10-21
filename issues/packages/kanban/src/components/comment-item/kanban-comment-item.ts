import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { when } from "lit/directives/when.js";

export type KanbanComment = {
	author: string;
	canEdit: boolean;
	id: string;
	message: string;
	publishedAt: string;
	publishedLabel: string;
};

export type KanbanCommentRenderService = {
	comment: { get(): KanbanComment };
	deleteComment: (commentId: string) => void;
	editComment: (input: { commentId: string; message: string }) => void;
};

export const kanbanCommentRenderServiceContext = createContext<KanbanCommentRenderService>(Symbol("kanban-comment-render-service"));

@customElement("kanban-comment-item")
export class KanbanCommentItem extends SignalWatcher(LitElement) {
	@state()
	public isEditing = false;

	@consume({ context: kanbanCommentRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanCommentRenderService | undefined;

	protected handleCancelEdit() {
		this.isEditing = false;
	}

	protected handleDeleteComment() {
		const comment = this.service?.comment.get();
		if (comment === undefined) {
			return;
		}

		this.service?.deleteComment(comment.id);
		this.dispatchEvent(new CustomEvent("kanban-comment-delete", {
			bubbles: true,
			composed: true,
			detail: { commentId: comment.id }
		}));
	}

	protected async handleEditComment() {
		this.isEditing = true;
		await this.updateComplete;
		this.renderRoot.querySelector<HTMLTextAreaElement>("textarea")?.focus();
	}

	protected handleSubmitEdit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const message = new FormData(form).get("message");
		const service = this.service;
		const comment = service?.comment.get();
		if (service === undefined || comment === undefined || typeof message !== "string" || message.trim() === "") {
			return;
		}

		const detail = { commentId: comment.id, message: message.trim() };
		service.editComment(detail);
		this.dispatchEvent(new CustomEvent("kanban-comment-edit", {
			bubbles: true,
			composed: true,
			detail
		}));
		this.isEditing = false;
	}

	protected render() {
		const comment = this.service?.comment.get();
		if (comment === undefined) {
			return html``;
		}

		return html`
		<article>
			<header>
				<strong>${comment.author}</strong>
				<div class="metadata">
					<time datetime=${comment.publishedAt}>${comment.publishedLabel}</time>
					${when(
						comment.canEdit,
						() => html`
						<div class="actions">
							<button
								@click=${this.handleEditComment}
								type="button"
							>
								Edit
							</button>
							<button
								@click=${this.handleDeleteComment}
								type="button"
							>
								Delete
							</button>
						</div>
						`
					)}
				</div>
			</header>
			${when(
				this.isEditing,
				() => html`
				<form @submit=${this.handleSubmitEdit}>
					<label for="comment-message">Edit comment</label>
					<textarea
						id="comment-message"
						name="message"
						rows="3"
					>${comment.message}</textarea>
					<div class="editor-actions">
						<button
							@click=${this.handleCancelEdit}
							type="button"
						>
							Cancel
						</button>
						<button type="submit">Publish edit</button>
					</div>
				</form>
				`,
				() => html`<p>${comment.message}</p>`
			)}
		</article>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}

	article {
		background: var(--color-comment-surface);
		border-left: var(--size-1) solid var(--color-accent-secondary);
		padding: var(--size-6);
	}

	header,
	.metadata,
	.actions,
	.editor-actions {
		align-items: center;
		display: flex;
		gap: var(--size-4);
	}

	header {
		color: var(--color-text-primary);
		font-size: var(--font-size-control);
		justify-content: space-between;
	}

	time,
	p {
		color: var(--color-text-secondary);
	}

	time {
		font-size: var(--font-size-meta);
		white-space: nowrap;
	}

	p {
		font-size: var(--font-size-ui);
		line-height: var(--line-height-body);
		margin: var(--size-4) var(--size-0) var(--size-0);
		overflow-wrap: anywhere;
	}

	button,
	textarea {
		font: inherit;
	}

	button {
		background: var(--color-surface-panel);
		border: var(--border-width) solid var(--color-border-subtle);
		border-radius: var(--radius-control);
		color: var(--color-text-primary);
		cursor: pointer;
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-heavy);
		padding: var(--size-2) var(--size-4);
	}

	.actions button:last-child {
		border-color: var(--color-status-blocked-border);
		color: var(--color-status-blocked-text);
	}

	.actions button:hover,
	.editor-actions button:hover {
		background: var(--color-surface-subtle);
	}

	button:focus-visible,
	textarea:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	form {
		display: grid;
		gap: var(--size-4);
		margin-top: var(--size-4);
	}

	textarea {
		box-sizing: border-box;
		min-height: var(--size-38);
		resize: vertical;
		width: 100%;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-comment-item": KanbanCommentItem;
	}

	interface HTMLElementEventMap {
		"kanban-comment-delete": CustomEvent<{ commentId: string }>;
		"kanban-comment-edit": CustomEvent<{ commentId: string; message: string }>;
	}
}