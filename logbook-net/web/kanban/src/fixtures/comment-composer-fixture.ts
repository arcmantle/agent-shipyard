import { signal } from "@lit-labs/signals";

import type { KanbanCommentComposerRenderService, KanbanCommentComposerState } from "../components/comment-composer/kanban-comment-composer.js";

const commentComposer: KanbanCommentComposerState = {
	isPosting: false,
	message: "",
	placeholder: "Write a comment",
	postLabel: "Post comment"
};

export class CommentComposerFixtureRenderService implements KanbanCommentComposerRenderService {
	public commentComposer = signal(commentComposer);
	public postedMessages: string[] = [];

	public postComment(message: string) {
		this.postedMessages.push(message);
		this.setMessage("");
	}

	public setMessage(message: string) {
		this.commentComposer.set({
			...this.commentComposer.get(),
			message
		});
	}
}

export function createCommentComposerShowcaseFixture(): CommentComposerFixtureRenderService {
	return new CommentComposerFixtureRenderService();
}