export type IssueCommentRecord = {
	id: string;
	reference: string;
	shortReference: string;
	issueId: string;
	createdBy: string;
	updatedBy: string;
	body?: string;
	referencedIssueIds: string[];
	tombstone: boolean;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
};

export type IssueCommentSummary = Omit<IssueCommentRecord, "body">;

export function toIssueCommentSummary(comment: IssueCommentRecord): IssueCommentSummary {
	const { body: _body, ...summary } = comment;
	return summary;
}

import type { UserDirectoryRecord } from "../user-directory/user-directory.js";

export type IssueCommentPage = {
	comments: IssueCommentRecord[];
	users: UserDirectoryRecord[];
	total: number;
	nextBefore: string | null;
};

export type IssueCommentHistoryEntry = {
	commentId: string;
	targetRevision: number;
	headRevision: number;
	body: string;
	referencedIssueIds: string[];
	tombstone: boolean;
	author: string;
	createdAt: string;
	restoredFromRevision: number | null;
};

export class IssueCommentConflictError extends Error {
	public readonly commentId: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;

	public constructor(commentId: string, currentRevision: number, currentContentHash: string) {
		super(`Stale edit for issue comment ${commentId}: current revision is ${currentRevision}.`);
		this.name = "IssueCommentConflictError";
		this.commentId = commentId;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}
}

export interface IssueCommentStore {
	createIssueComment(input: { issueId: string; body: string; referencedIssueIds?: string[] }): Promise<IssueCommentSummary>;
	updateIssueComment(input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord>;
	deleteIssueComment(input: { commentId: string; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord>;
	listIssueComments(input: { issueId: string; before?: string; all?: boolean }): Promise<IssueCommentPage>;
	listIssueCommentHistory(input: { commentId: string }): Promise<IssueCommentHistoryEntry[]>;
}