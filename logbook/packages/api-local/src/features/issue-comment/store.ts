import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
	computeIssueCommentContentHash,
	createReverseFieldPatch,
	encodeCanonicalReference,
	encodeIssueCommentRecordKey,
	ISSUE_COMMENT_REVERSE_PATCH_REGISTRY,
	IssueCommentConflictError,
	materializeIssueCommentFromPatches,
	shortEntityReference,
	toIssueCommentSummary,
	type IssueCommentHistoryEntry,
	type IssueCommentPage,
	type IssueCommentRecord,
	type IssueCommentSummary
} from "@agent-issues/core";
import { getSqliteEntityOrThrow, type SqliteExecutor } from "../../db/sqlite-executor.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { listUsers } from "../user-directory/store.js";

type IssueCommentRow = {
	id: string;
	reference: string;
	short_reference: string;
	issue_id: string;
	created_by: string;
	updated_by: string;
	body: string;
	tombstone: number;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

type CommentCursor = {
	createdAt: string;
	reference: string;
};

type IssueCommentState = {
	body: string;
	referencedIssueIds: string[];
	tombstone: boolean;
};

type LedgerRow = {
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
	restored_from_revision: number | null;
	created_at: string;
};

const DEFAULT_PAGE_SIZE = 50;

export function createIssueComment(
	executor: SqliteExecutor,
	input: { issueId: string; body: string; referencedIssueIds?: string[] },
	actorId: string
): IssueCommentRecord {
	const issue = getProjectIssueOrThrow(executor, input.issueId);

	const body = input.body;
	if (body.trim().length === 0) {
		throw new Error("Issue comment body must not be empty.");
	}

	const referencedIssueIds = [...new Set(input.referencedIssueIds ?? [])];
	for (const referencedIssueId of referencedIssueIds) {
		getProjectIssueOrThrow(executor, referencedIssueId);
	}

	const id = randomUUID();
	const reference = encodeCanonicalReference("issueComment", id);
	const shortReference = allocateShortReference(executor, id);
	const createdAt = new Date().toISOString();
	const state = { body, referencedIssueIds, tombstone: false };
	const contentHash = computeIssueCommentContentHash(body, referencedIssueIds, false);
	executor.drizzle.transaction((tx) => {
		tx.run(sql`INSERT INTO issue_comments (tenant_id, id, reference, short_reference, issue_id, created_by, updated_by, body, revision, content_hash, tombstone, created_at, updated_at)
			VALUES (${executor.tenantId}, ${id}, ${reference}, ${shortReference}, ${issue.id}, ${actorId}, ${actorId}, ${body}, 1, ${contentHash}, 0, ${createdAt}, ${createdAt})`);
		for (const [position, referencedIssueId] of referencedIssueIds.entries()) {
			tx.run(sql`INSERT INTO issue_comment_references (tenant_id, comment_id, issue_id, position) VALUES (${executor.tenantId}, ${id}, ${referencedIssueId}, ${position})`);
		}
		appendIssueCommentDelta(executor, id, 1, state, state, actorId, createdAt);
	});

	return getIssueComment(executor, id);
}

export function listIssueComments(
	executor: SqliteExecutor,
	input: { issueId: string; before?: string; all?: boolean }
): IssueCommentPage {
	const issue = getProjectIssueOrThrow(executor, input.issueId);

	const cursor = input.before ? decodeCursor(input.before) : undefined;
	const beforePredicate = cursor
		? sql`AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND reference < ${cursor.reference}))`
		: sql``;
	const availableCount = executor.drizzle.all(sql`SELECT count(*) AS count FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issue.id} ${beforePredicate}`)[0] as { count: number };
	const total = executor.drizzle.all(sql`SELECT count(*) AS count FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issue.id}`)[0] as { count: number };
	const rows = input.all
		? executor.drizzle.all(sql`SELECT * FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issue.id} ${beforePredicate} ORDER BY created_at ASC, reference ASC`) as IssueCommentRow[]
		: executor.drizzle.all(sql`SELECT * FROM (
			SELECT * FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issue.id} ${beforePredicate}
			ORDER BY created_at DESC, reference DESC LIMIT ${DEFAULT_PAGE_SIZE}
		) ORDER BY created_at ASC, reference ASC`) as IssueCommentRow[];
	const comments = rows.map((row) => toIssueCommentRecord(executor, row));
	const userIds = new Set(comments.flatMap((comment) => [comment.createdBy, comment.updatedBy]));
	const oldest = comments[0];

	return {
		comments,
		users: listUsers(executor).filter((user) => userIds.has(user.id)),
		total: total.count,
		nextBefore: !input.all && oldest && availableCount.count > comments.length
			? encodeCursor({ createdAt: oldest.createdAt, reference: oldest.reference })
			: null
	};
}

export function updateIssueComment(
	executor: SqliteExecutor,
	input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string },
	actorId: string
): IssueCommentRecord {
	const existing = getIssueComment(executor, input.commentId);
	if (existing.tombstone) {
		throw new Error(`Issue comment not found: ${input.commentId}`);
	}
	if (existing.revision !== input.expectedRevision || existing.contentHash !== input.expectedContentHash) {
		throw new IssueCommentConflictError(existing.id, existing.revision, existing.contentHash);
	}
	if (input.body.trim().length === 0) {
		throw new Error("Issue comment body must not be empty.");
	}

	const referencedIssueIds = input.referencedIssueIds === undefined
		? existing.referencedIssueIds
		: validateReferencedIssueIds(executor, input.referencedIssueIds);
	const updatedAt = new Date().toISOString();
	const successor = { body: input.body, referencedIssueIds, tombstone: false };
	const predecessor = { body: existing.body!, referencedIssueIds: existing.referencedIssueIds, tombstone: false };
	const revision = existing.revision + 1;
	const contentHash = computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone);
	const result = executor.drizzle.run(sql`UPDATE issue_comments SET body = ${successor.body}, updated_by = ${actorId}, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${existing.id} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = 0`);
	if (result.changes === 0) {
		const current = getIssueComment(executor, existing.id);
		throw new IssueCommentConflictError(current.id, current.revision, current.contentHash);
	}
	replaceIssueCommentReferences(executor, existing.id, referencedIssueIds);
	appendIssueCommentDelta(executor, existing.id, revision, successor, predecessor, actorId, updatedAt);

	return getIssueComment(executor, existing.id);
}

export function deleteIssueComment(
	executor: SqliteExecutor,
	input: { commentId: string; expectedRevision: number; expectedContentHash: string },
	actorId: string
): IssueCommentRecord {
	const existing = getIssueComment(executor, input.commentId);
	if (existing.tombstone) {
		throw new Error(`Issue comment not found: ${input.commentId}`);
	}
	if (existing.revision !== input.expectedRevision || existing.contentHash !== input.expectedContentHash) {
		throw new IssueCommentConflictError(existing.id, existing.revision, existing.contentHash);
	}

	const updatedAt = new Date().toISOString();
	const successor = { body: existing.body!, referencedIssueIds: existing.referencedIssueIds, tombstone: true };
	const predecessor = { ...successor, tombstone: false };
	const revision = existing.revision + 1;
	const contentHash = computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone);
	const result = executor.drizzle.run(sql`UPDATE issue_comments SET updated_by = ${actorId}, revision = ${revision}, content_hash = ${contentHash}, tombstone = 1, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${existing.id} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = 0`);
	if (result.changes === 0) {
		const current = getIssueComment(executor, existing.id);
		throw new IssueCommentConflictError(current.id, current.revision, current.contentHash);
	}
	appendIssueCommentDelta(executor, existing.id, revision, successor, predecessor, actorId, updatedAt);

	return getIssueComment(executor, existing.id);
}

export function listIssueCommentHistory(executor: SqliteExecutor, input: { commentId: string }): IssueCommentHistoryEntry[] {
	const comment = executor.drizzle.all(sql`SELECT issue_comments.id
		FROM issue_comments
		JOIN entities AS issue ON issue.tenant_id = issue_comments.tenant_id AND issue.id = issue_comments.issue_id
		WHERE issue_comments.tenant_id = ${executor.tenantId}
			AND issue.project_id = ${executor.currentProjectId}
			AND (issue_comments.id = ${input.commentId} OR issue_comments.reference = ${input.commentId})`)[0] as { id: string } | undefined;
	if (!comment) {
		return [];
	}

	const patches = executor.drizzle.all(sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM revision_entries WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND record_kind = 'issue-comment' AND record_key = ${encodeIssueCommentRecordKey(comment.id)} ORDER BY revision`) as LedgerRow[];
	const head = executor.drizzle.all(sql`SELECT * FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND id = ${comment.id}`)[0] as IssueCommentRow;
	const referencedIssueIds = executor.drizzle.all(sql`SELECT issue_id FROM issue_comment_references WHERE tenant_id = ${executor.tenantId} AND comment_id = ${comment.id} ORDER BY position`) as Array<{ issue_id: string }>;
	return Array.from({ length: head.revision }, (_, index) => {
		const targetRevision = index + 1;
		const state = materializeIssueCommentFromPatches({
			body: head.body,
			referencedIssueIds: referencedIssueIds.map((reference) => reference.issue_id),
			tombstone: head.tombstone !== 0,
			revision: head.revision,
			createdAt: head.created_at
		}, patches.map(toIssueCommentDelta), targetRevision);
		const delta = patches.find((candidate) => candidate.revision === targetRevision)!;
		return {
			commentId: head.id,
			targetRevision,
			headRevision: head.revision,
			...state,
			author: delta.author,
			createdAt: delta.created_at,
			restoredFromRevision: delta.restored_from_revision ?? null
		};
	});
}

export class LocalIssueCommentStore {
	public constructor(executor: SqliteExecutor) {
		this.executor = executor;
	}

	protected readonly executor: SqliteExecutor;

	public createIssueComment(input: { issueId: string; body: string; referencedIssueIds?: string[] }, actorId: string): IssueCommentSummary {
		return toIssueCommentSummary(createIssueComment(this.executor, input, actorId));
	}

	public updateIssueComment(input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string }, actorId: string): IssueCommentRecord {
		return updateIssueComment(this.executor, input, actorId);
	}

	public deleteIssueComment(input: { commentId: string; expectedRevision: number; expectedContentHash: string }, actorId: string): IssueCommentRecord {
		return deleteIssueComment(this.executor, input, actorId);
	}

	public listIssueComments(input: { issueId: string; before?: string; all?: boolean }): IssueCommentPage {
		return listIssueComments(this.executor, input);
	}

	public listIssueCommentHistory(input: { commentId: string }): IssueCommentHistoryEntry[] {
		return listIssueCommentHistory(this.executor, input);
	}
}

function getIssueComment(executor: SqliteExecutor, commentId: string): IssueCommentRecord {
	const row = executor.drizzle.all(sql`SELECT issue_comments.*
		FROM issue_comments
		JOIN entities AS issue ON issue.tenant_id = issue_comments.tenant_id AND issue.id = issue_comments.issue_id
		WHERE issue_comments.tenant_id = ${executor.tenantId}
			AND issue.project_id = ${executor.currentProjectId}
			AND (issue_comments.id = ${commentId} OR issue_comments.reference = ${commentId} OR issue_comments.short_reference = ${commentId})`)[0] as IssueCommentRow | undefined;
	if (!row) {
		throw new Error(`Issue comment not found: ${commentId}`);
	}
	return toIssueCommentRecord(executor, row);
}

function validateReferencedIssueIds(executor: SqliteExecutor, referencedIssueIds: string[]): string[] {
	const deduplicated = [...new Set(referencedIssueIds)];
	for (const referencedIssueId of deduplicated) {
		getProjectIssueOrThrow(executor, referencedIssueId);
	}
	return deduplicated;
}

function getProjectIssueOrThrow(executor: SqliteExecutor, issueId: string) {
	const issue = getSqliteEntityOrThrow(executor, issueId);
	if (issue.kind !== "issue" || issue.projectId !== executor.currentProjectId) {
		throw new Error(`Entity not found: ${issueId}`);
	}
	return issue;
}

function toIssueCommentRecord(executor: SqliteExecutor, row: IssueCommentRow): IssueCommentRecord {
	const references = executor.drizzle.all(sql`SELECT issue_id FROM issue_comment_references WHERE tenant_id = ${executor.tenantId} AND comment_id = ${row.id} ORDER BY position`) as Array<{ issue_id: string }>;
	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		issueId: row.issue_id,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		...(row.tombstone === 0 && { body: row.body }),
		referencedIssueIds: references.map((reference) => reference.issue_id),
		tombstone: row.tombstone !== 0,
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function replaceIssueCommentReferences(executor: SqliteExecutor, commentId: string, referencedIssueIds: string[]): void {
	executor.drizzle.run(sql`DELETE FROM issue_comment_references WHERE tenant_id = ${executor.tenantId} AND comment_id = ${commentId}`);
	for (const [position, referencedIssueId] of referencedIssueIds.entries()) {
		executor.drizzle.run(sql`INSERT INTO issue_comment_references (tenant_id, comment_id, issue_id, position) VALUES (${executor.tenantId}, ${commentId}, ${referencedIssueId}, ${position})`);
	}
}

function appendIssueCommentDelta(executor: SqliteExecutor, commentId: string, revision: number, successor: IssueCommentState, predecessor: IssueCommentState, actorId: string, createdAt: string): void {
	const delta = createReverseFieldPatch(successor, predecessor, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY);
	const issue = getIssueComment(executor, commentId);
	executor.drizzle.run(sql`INSERT INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${executor.tenantId}, ${getSqliteEntityOrThrow(executor, issue.issueId).projectId}, 'issue-comment', ${encodeIssueCommentRecordKey(commentId)}, ${revision}, ${actorId}, ${delta.patchFormat}, ${Buffer.from(delta.reversePatch)}, ${encodeRevisionPatchHash(delta.sourceHash)}, ${encodeRevisionPatchHash(delta.targetHash)}, NULL, ${createdAt})`);
}

function toIssueCommentDelta(delta: LedgerRow) {
	return {
		revision: delta.revision,
		author: delta.author,
		patchFormat: delta.patch_format,
		reversePatch: delta.reverse_patch,
		sourceHash: decodeRevisionPatchHash(delta.source_hash),
		targetHash: decodeRevisionPatchHash(delta.target_hash),
		createdAt: delta.created_at,
		...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision })
	};
}

function allocateShortReference(executor: SqliteExecutor, id: string): string {
	const baseReference = shortEntityReference({ id, kind: "issueComment" });
	let shortReference = baseReference;
	let suffix = 2;

	while (executor.drizzle.all(sql`SELECT id FROM issue_comments WHERE tenant_id = ${executor.tenantId} AND short_reference = ${shortReference}`).length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}

	return shortReference;
}

function encodeCursor(cursor: CommentCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): CommentCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CommentCursor>;
		if (typeof cursor.createdAt !== "string" || typeof cursor.reference !== "string") {
			throw new Error("Invalid issue comment cursor.");
		}
		return { createdAt: cursor.createdAt, reference: cursor.reference };
	} catch {
		throw new Error("Invalid issue comment cursor.");
	}
}