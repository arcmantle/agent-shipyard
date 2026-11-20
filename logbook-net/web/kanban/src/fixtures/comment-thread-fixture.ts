import { signal } from "@lit-labs/signals";

import type { KanbanCommentThreadRenderService, KanbanCommentThreadState } from "../components/comment-thread/kanban-comment-thread.js";

const commentThread: KanbanCommentThreadState = {
	comments: [
		{
			author: "You",
			id: "comment-1",
			message: "Keep server behavior identical for local and cloud workspaces.",
			publishedAt: "2026-08-26T10:24:00Z",
			publishedLabel: "Today, 10:24"
		},
		{
			author: "R. Lee",
			id: "comment-2",
			message: "Document the storage contract before the migration.",
			publishedAt: "2026-08-26T10:28:00Z",
			publishedLabel: "Today, 10:28"
		}
	],
	label: "Issue comments"
};

export class CommentThreadFixtureRenderService implements KanbanCommentThreadRenderService {
	public commentThread = signal(commentThread);
}

export function createCommentThreadShowcaseFixture(): CommentThreadFixtureRenderService {
	return new CommentThreadFixtureRenderService();
}
