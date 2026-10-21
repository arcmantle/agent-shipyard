import { Option } from "clipanion";

import { getHelpPayload, renderHelp } from "../help.js";

import { BaseCommand, BodyTenantCommand, TenantCommand, requireOption, requirePositional, withStore } from "../shared.js";

export class IssueCommentCommand extends BaseCommand {
	public static paths = [["comment"]];

	public async execute(): Promise<number> {
		const payload = getHelpPayload("comment");
		this.print(payload, renderHelp(payload));
		return 0;
	}
}

export class AddIssueCommentCommand extends BodyTenantCommand {
	public static paths = [["comment", "add"]];

	public positionals = Option.Rest();
	public references = Option.Array("--reference");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const referencedIssueIds = await resolveReferencedIssueIds(store, this.references ?? []);
			const comment = await store.createIssueComment({
				issueId: requirePositional(this.positionals, 0, "comment add <issueId> --body-file <path|-> [--reference <issueId>]"),
				body: requireOption(await this.resolveBody(), "--body-file is required for comment add."),
				referencedIssueIds
			});
			this.print(comment, renderIssueComment(comment));
			return 0;
		});
	}
}

export class EditIssueCommentCommand extends BodyTenantCommand {
	public static paths = [["comment", "edit"]];

	public positionals = Option.Rest();
	public references = Option.Array("--reference");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const issueId = requirePositional(this.positionals, 0, "comment edit <issueId> <commentId> --body-file <path|-> [--reference <issueId>]");
			const commentId = requirePositional(this.positionals, 1, "comment edit <issueId> <commentId> --body-file <path|-> [--reference <issueId>]");
			const comment = await getIssueComment(store, issueId, commentId);
			const referencedIssueIds = this.references === undefined
				? undefined
				: await resolveReferencedIssueIds(store, this.references);
			const updated = await store.updateIssueComment({
				commentId,
				body: requireOption(await this.resolveBody(), "--body-file is required for comment edit."),
				referencedIssueIds,
				expectedRevision: comment.revision,
				expectedContentHash: comment.contentHash
			});
			this.print(updated, renderIssueComment(updated));
			return 0;
		});
	}
}

export class DeleteIssueCommentCommand extends TenantCommand {
	public static paths = [["comment", "delete"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const issueId = requirePositional(this.positionals, 0, "comment delete <issueId> <commentId>");
			const commentId = requirePositional(this.positionals, 1, "comment delete <issueId> <commentId>");
			const comment = await getIssueComment(store, issueId, commentId);
			const deleted = await store.deleteIssueComment({
				commentId,
				expectedRevision: comment.revision,
				expectedContentHash: comment.contentHash
			});
			this.print(deleted, renderIssueComment(deleted));
			return 0;
		});
	}
}

export class IssueCommentHistoryCommand extends TenantCommand {
	public static paths = [["comment", "history"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const history = await store.listIssueCommentHistory({
				commentId: requirePositional(this.positionals, 0, "comment history <commentId>")
			});
			this.print(history, history.map(renderIssueCommentHistory).join("\n") || "No comment history found.");
			return 0;
		});
	}
}

export class ListIssueCommentsCommand extends TenantCommand {
	public static paths = [["comment", "list"]];

	public all = Option.Boolean("--all", false);
	public before = Option.String("--before");
	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const page = await store.listIssueComments({
				issueId: requirePositional(this.positionals, 0, "comment list <issueId> [--before <cursor>] [--all]"),
				before: this.before,
				all: this.all
			});
			this.print(page, page.comments.map(renderIssueComment).join("\n") || "No comments found.");
			return 0;
		});
	}
}

function renderIssueComment(comment: {
	reference: string;
	createdBy: string;
	updatedAt: string;
	body?: string;
	tombstone: boolean;
}): string {
	if (comment.tombstone) {
		return `${comment.reference} deleted ${comment.updatedAt}`;
	}

	return `${comment.reference} by ${comment.createdBy}\n${comment.body}`;
}

function renderIssueCommentHistory(entry: {
	targetRevision: number;
	headRevision: number;
	author: string;
	createdAt: string;
	body: string;
	tombstone: boolean;
}): string {
	return `revision ${entry.targetRevision}/${entry.headRevision} by ${entry.author} ${entry.createdAt}${entry.tombstone ? " deleted" : ""}\n${entry.body}`;
}

async function getIssueComment(
	store: {
		getEntityDetails(entityId: string): Promise<{ entity: { id: string } }>;
		listIssueComments(input: { issueId: string; all?: boolean }): Promise<{ comments: Array<{ id: string; reference: string; revision: number; contentHash: string }> }>;
	},
	issueId: string,
	commentId: string
): Promise<{ id: string; reference: string; revision: number; contentHash: string }> {
	const issue = await store.getEntityDetails(issueId);
	const comment = (await store.listIssueComments({ issueId: issue.entity.id, all: true })).comments
		.find((candidate) => candidate.id === commentId || candidate.reference === commentId);
	if (!comment) {
		throw new Error(`Issue comment not found: ${commentId}`);
	}

	return comment;
}

async function resolveReferencedIssueIds(
	store: { getEntityDetails(entityId: string): Promise<{ entity: { id: string } }> },
	references: string[]
): Promise<string[]> {
	return await Promise.all(references.map(async (reference) => {
		return (await store.getEntityDetails(reference)).entity.id;
	}));
}