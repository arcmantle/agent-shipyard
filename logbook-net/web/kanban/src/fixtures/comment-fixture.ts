import { signal } from "@lit-labs/signals";

import type { KanbanComment, KanbanCommentRenderService } from "../components/comment-item/kanban-comment-item.js";

const comment: KanbanComment = {
	author: "R. Lee",
	canEdit: true,
	id: "comment-1",
	message: "Keep server behavior identical for local and cloud workspaces.",
	publishedAt: "2026-08-26T09:30:00Z",
	publishedLabel: "Today at 09:30"
};

export class CommentFixtureRenderService implements KanbanCommentRenderService {
	public comment = signal(comment);
	public deletedCommentIds: string[] = [];
	public editedComments: Array<{ commentId: string; message: string }> = [];

	public deleteComment(commentId: string) {
		this.deletedCommentIds.push(commentId);
	}

	public editComment(input: { commentId: string; message: string }) {
		this.editedComments.push(input);
	}
}

export function createCommentShowcaseFixture(): CommentFixtureRenderService {
	return new CommentFixtureRenderService();
}