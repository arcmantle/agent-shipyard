import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";

export type KanbanCommentThreadEntry = {
	author: string;
	id: string;
	message: string;
	publishedAt: string;
	publishedLabel: string;
};

export type KanbanCommentThreadState = {
	comments: readonly KanbanCommentThreadEntry[];
	label: string;
};

export type KanbanCommentThreadRenderService = {
	commentThread: { get(): KanbanCommentThreadState };
};

export const kanbanCommentThreadRenderServiceContext = createContext<KanbanCommentThreadRenderService>(
	Symbol("kanban-comment-thread-render-service")
);

@customElement("kanban-comment-thread")
export class KanbanCommentThread extends SignalWatcher(LitElement) {
	@consume({ context: kanbanCommentThreadRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanCommentThreadRenderService | undefined;

	protected renderComment(comment: KanbanCommentThreadEntry) {
		return html`
		<li>
			<article>
				<header>
					<strong>${comment.author}</strong>
					<time datetime=${comment.publishedAt}>${comment.publishedLabel}</time>
				</header>
				<p>${comment.message}</p>
			</article>
		</li>
		`;
	}

	protected render() {
		const commentThread = this.service?.commentThread.get();
		if (commentThread === undefined) {
			return html``;
		}

		return html`
		<section>
			${when(
				commentThread.comments.length > 0,
				() => html`
				<ol
					aria-label=${commentThread.label}
					aria-live="polite"
				>
					${repeat(commentThread.comments, (comment) => comment.id, (comment) => this.renderComment(comment))}
				</ol>
				`,
				() => html`
				<p class="comment-thread-empty">No comments yet. Start the discussion for this record.</p>
				`
			)}
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	section {
		display: grid;
		gap: var(--size-6);
	}
	ol {
		display: grid;
		gap: var(--size-5);
		list-style: none;
		margin: var(--size-0);
		padding: var(--size-0);
	}
	article {
		background: var(--color-comment-surface);
		border-left: var(--size-1) solid var(--color-accent-secondary);
		padding: var(--size-6);
	}
	header {
		align-items: center;
		color: var(--color-text-primary);
		display: flex;
		font-size: var(--font-size-control);
		justify-content: space-between;
	}
	time {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		white-space: nowrap;
	}
	article p,
	.comment-thread-empty {
		color: var(--color-text-secondary);
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-4) var(--size-0) var(--size-0);
		overflow-wrap: anywhere;
	}
	.comment-thread-empty {
		border: var(--border-width) dashed var(--color-border-subtle);
		margin: var(--size-0);
		padding: var(--size-12) var(--size-6);
		text-align: center;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-comment-thread": KanbanCommentThread;
	}
}
