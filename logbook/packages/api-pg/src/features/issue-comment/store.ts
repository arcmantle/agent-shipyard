import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

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
	type IssueCommentSummary,
	type IssueCommentRevisionPatch
} from "@agent-issues/core";

import type { TenantExecutor } from "../../db/connection.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { entities, issueCommentReferences, issueComments, revisionEntries } from "../../schema.js";
import { PgUserDirectoryStore } from "../user-directory/store.js";

const DEFAULT_PAGE_SIZE = 50;

type IssueCommentRow = {
	id: string;
	reference: string;
	short_reference: string;
	issue_id: string;
	created_by: string;
	updated_by: string;
	body: string;
	tombstone: boolean;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

type CommentCursor = {
	createdAt: string;
	reference: string;
};

type LedgerRow = {
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Buffer;
	source_hash: Buffer;
	target_hash: Buffer;
	restored_from_revision: number | null;
	created_at: string;
};

export class PgIssueCommentStore {
	public constructor(executor: TenantExecutor) {
		this.executor = executor;
	}

	protected readonly executor: TenantExecutor;

	public async createIssueComment(input: { issueId: string; body: string; referencedIssueIds?: string[] }, actorId: string): Promise<IssueCommentSummary> {
		const issueId = await getProjectIssueIdOrThrow(this.executor, input.issueId);
		if (input.body.trim().length === 0) {
			throw new Error("Issue comment body must not be empty.");
		}

		const referencedIssueIds = await validateReferencedIssueIds(this.executor, input.referencedIssueIds ?? []);
		const id = randomUUID();
		const reference = encodeCanonicalReference("issueComment", id);
		const shortReference = await allocateShortReference(this.executor, id);
		const createdAt = new Date().toISOString();
		const state = { body: input.body, referencedIssueIds, tombstone: false };
		const contentHash = computeIssueCommentContentHash(state.body, state.referencedIssueIds, state.tombstone);
		await this.executor.insert(issueComments).values({
			tenantId: this.executor.tenantId,
			id,
			reference,
			shortReference,
			issueId,
			createdBy: actorId,
			updatedBy: actorId,
			body: state.body,
			revision: 1,
			contentHash,
			tombstone: false,
			createdAt,
			updatedAt: createdAt
		});
		await replaceIssueCommentReferences(this.executor, id, referencedIssueIds);
		await appendIssueCommentDelta(this.executor, id, 1, state, state, actorId, createdAt);

		return toIssueCommentSummary(toIssueCommentRecord({
			id,
			reference,
			short_reference: shortReference,
			issue_id: issueId,
			created_by: actorId,
			updated_by: actorId,
			body: state.body,
			tombstone: false,
			revision: 1,
			content_hash: contentHash,
			created_at: createdAt,
			updated_at: createdAt,
			referencedIssueIds
		}));
	}

	public async updateIssueComment(input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string }, actorId: string): Promise<IssueCommentRecord> {
		const existing = await getProjectIssueCommentOrThrow(this.executor, input.commentId);
		if (existing.tombstone) {
			throw new Error(`Issue comment not found: ${input.commentId}`);
		}
		assertIssueCommentHead(existing, input);
		if (input.body.trim().length === 0) {
			throw new Error("Issue comment body must not be empty.");
		}

		const existingReferencedIssueIds = await listIssueCommentReferences(this.executor, existing.id);
		const referencedIssueIds = input.referencedIssueIds === undefined
			? existingReferencedIssueIds
			: await validateReferencedIssueIds(this.executor, input.referencedIssueIds);
		const updatedAt = new Date().toISOString();
		const successor = { body: input.body, referencedIssueIds, tombstone: false };
		const revision = existing.revision + 1;
		const contentHash = computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone);
		const result = await this.executor.execute(sql`
			UPDATE issue_comments
			SET body = ${successor.body}, updated_by = ${actorId}::uuid, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
			WHERE tenant_id = ${this.executor.tenantId}
				AND id = ${existing.id}::uuid
				AND revision = ${input.expectedRevision}
				AND content_hash = ${input.expectedContentHash}
				AND tombstone = FALSE
		`);
		if ((result.rowCount ?? 0) === 0) {
			throw await getIssueCommentConflict(this.executor, input.commentId);
		}
		await replaceIssueCommentReferences(this.executor, existing.id, referencedIssueIds);
		await appendIssueCommentDelta(
			this.executor,
			existing.id,
			revision,
			successor,
			{ body: existing.body, referencedIssueIds: existingReferencedIssueIds, tombstone: false },
			actorId,
			updatedAt
		);

		return toIssueCommentRecord({
			...existing,
			body: successor.body,
			updated_by: actorId,
			revision,
			content_hash: contentHash,
			updated_at: updatedAt,
			referencedIssueIds
		});
	}

	public async deleteIssueComment(input: { commentId: string; expectedRevision: number; expectedContentHash: string }, actorId: string): Promise<IssueCommentRecord> {
		const existing = await getProjectIssueCommentOrThrow(this.executor, input.commentId);
		if (existing.tombstone) {
			throw new Error(`Issue comment not found: ${input.commentId}`);
		}
		assertIssueCommentHead(existing, input);

		const referencedIssueIds = await listIssueCommentReferences(this.executor, existing.id);
		const updatedAt = new Date().toISOString();
		const successor = { body: existing.body, referencedIssueIds, tombstone: true };
		const revision = existing.revision + 1;
		const contentHash = computeIssueCommentContentHash(successor.body, successor.referencedIssueIds, successor.tombstone);
		const result = await this.executor.execute(sql`
			UPDATE issue_comments
			SET updated_by = ${actorId}::uuid, revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_at = ${updatedAt}
			WHERE tenant_id = ${this.executor.tenantId}
				AND id = ${existing.id}::uuid
				AND revision = ${input.expectedRevision}
				AND content_hash = ${input.expectedContentHash}
				AND tombstone = FALSE
		`);
		if ((result.rowCount ?? 0) === 0) {
			throw await getIssueCommentConflict(this.executor, input.commentId);
		}
		await appendIssueCommentDelta(this.executor, existing.id, revision, successor, { ...successor, tombstone: false }, actorId, updatedAt);

		return toIssueCommentRecord({
			...existing,
			updated_by: actorId,
			tombstone: true,
			revision,
			content_hash: contentHash,
			updated_at: updatedAt,
			referencedIssueIds
		});
	}

	public async listIssueComments(input: { issueId: string; before?: string; all?: boolean }): Promise<IssueCommentPage> {
		const issueId = await findProjectIssueId(this.executor, input.issueId);
		if (!issueId) {
			throw new Error(`Entity not found: ${input.issueId}`);
		}

		const cursor = input.before ? decodeCursor(input.before) : undefined;
		const beforePredicate = cursor
			? sql`AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND reference < ${cursor.reference}))`
			: sql``;
		const totalResult = await this.executor.execute(sql`SELECT count(*) AS count FROM issue_comments WHERE tenant_id = ${this.executor.tenantId} AND issue_id = ${issueId}::uuid`);
		const availableResult = await this.executor.execute(sql`SELECT count(*) AS count FROM issue_comments WHERE tenant_id = ${this.executor.tenantId} AND issue_id = ${issueId}::uuid ${beforePredicate}`);
		const rowsResult = input.all
			? await this.executor.execute(sql`SELECT * FROM issue_comments WHERE tenant_id = ${this.executor.tenantId} AND issue_id = ${issueId}::uuid ${beforePredicate} ORDER BY created_at ASC, reference ASC`)
			: await this.executor.execute(sql`SELECT * FROM (
				SELECT * FROM issue_comments WHERE tenant_id = ${this.executor.tenantId} AND issue_id = ${issueId}::uuid ${beforePredicate}
				ORDER BY created_at DESC, reference DESC LIMIT ${DEFAULT_PAGE_SIZE}
			) AS page ORDER BY created_at ASC, reference ASC`);
		const rows = rowsResult.rows as IssueCommentRow[];
		const references = rows.length === 0
			? []
			: await this.executor
				.select({ commentId: issueCommentReferences.commentId, issueId: issueCommentReferences.issueId })
				.from(issueCommentReferences)
				.where(and(
					eq(issueCommentReferences.tenantId, this.executor.tenantId),
					inArray(issueCommentReferences.commentId, rows.map((row) => row.id))
				))
				.orderBy(asc(issueCommentReferences.commentId), asc(issueCommentReferences.position));
		const referencedIssueIdsByCommentId = new Map<string, string[]>();
		for (const reference of references) {
			referencedIssueIdsByCommentId.set(reference.commentId, [
				...(referencedIssueIdsByCommentId.get(reference.commentId) ?? []),
				reference.issueId
			]);
		}
		const comments = rows.map((row): IssueCommentRecord => ({
			id: row.id,
			reference: row.reference,
			shortReference: row.short_reference,
			issueId: row.issue_id,
			createdBy: row.created_by,
			updatedBy: row.updated_by,
			...(!row.tombstone && { body: row.body }),
			referencedIssueIds: referencedIssueIdsByCommentId.get(row.id) ?? [],
			tombstone: row.tombstone,
			revision: row.revision,
			contentHash: row.content_hash,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		}));
		const userIds = new Set(comments.flatMap((comment) => [comment.createdBy, comment.updatedBy]));
		const oldest = comments[0];
		const total = Number(totalResult.rows[0]?.count ?? 0);
		const available = Number(availableResult.rows[0]?.count ?? 0);

		return {
			comments,
			users: (await new PgUserDirectoryStore(this.executor).listUsers()).filter((user) => userIds.has(user.id)),
			total,
			nextBefore: !input.all && oldest && available > comments.length
				? encodeCursor(oldest)
				: null
		};
	}

	public async listIssueCommentHistory(input: { commentId: string }): Promise<IssueCommentHistoryEntry[]> {
		const comment = await findProjectIssueComment(this.executor, input.commentId);
		if (!comment) {
			return [];
		}
		const references = await this.executor
			.select({ issueId: issueCommentReferences.issueId })
			.from(issueCommentReferences)
			.where(and(
				eq(issueCommentReferences.tenantId, this.executor.tenantId),
				eq(issueCommentReferences.commentId, comment.id)
			))
			.orderBy(asc(issueCommentReferences.position));
		const ledgerResult = await this.executor.execute(sql`
			SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
			FROM revision_entries
			WHERE tenant_id = ${this.executor.tenantId}
				AND project_id = ${this.executor.currentProjectId}::uuid
				AND record_kind = 'issue-comment'
				AND record_key = ${encodeIssueCommentRecordKey(comment.id)}
			ORDER BY revision ASC
		`);
		const patches = (ledgerResult.rows as LedgerRow[]).map((row): IssueCommentRevisionPatch => ({
			revision: row.revision,
			author: row.author,
			patchFormat: row.patch_format,
			reversePatch: row.reverse_patch,
			sourceHash: decodeRevisionPatchHash(row.source_hash),
			targetHash: decodeRevisionPatchHash(row.target_hash),
			createdAt: row.created_at,
			...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision })
		}));
		const referencedIssueIds = references.map((reference) => reference.issueId);

		return patches.map((patch) => ({
			commentId: comment.id,
			targetRevision: patch.revision,
			headRevision: comment.revision,
			...materializeIssueCommentFromPatches({
				body: comment.body,
				referencedIssueIds,
				tombstone: comment.tombstone,
				revision: comment.revision,
				createdAt: comment.created_at
			}, patches, patch.revision),
			author: patch.author,
			createdAt: patch.createdAt,
			restoredFromRevision: patch.restoredFromRevision ?? null
		}));
	}
}

async function appendIssueCommentDelta(
	executor: TenantExecutor,
	commentId: string,
	revision: number,
	successor: { body: string; referencedIssueIds: string[]; tombstone: boolean },
	predecessor: { body: string; referencedIssueIds: string[]; tombstone: boolean },
	author: string,
	createdAt: string
): Promise<void> {
	const transition = createReverseFieldPatch(successor, predecessor, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY);
	await executor.insert(revisionEntries).values({
		id: randomUUID(),
		tenantId: executor.tenantId,
		projectId: executor.currentProjectId,
		recordKind: "issue-comment",
		recordKey: encodeIssueCommentRecordKey(commentId),
		revision,
		author,
		patchFormat: transition.patchFormat,
		reversePatch: Buffer.from(transition.reversePatch),
		sourceHash: encodeRevisionPatchHash(transition.sourceHash),
		targetHash: encodeRevisionPatchHash(transition.targetHash),
		restoredFromRevision: null,
		createdAt
	});
}

function assertIssueCommentHead(
	existing: IssueCommentRow,
	input: { expectedRevision: number; expectedContentHash: string }
): void {
	if (existing.revision !== input.expectedRevision || existing.content_hash !== input.expectedContentHash) {
		throw new IssueCommentConflictError(existing.id, existing.revision, existing.content_hash);
	}
}

async function getIssueCommentConflict(executor: TenantExecutor, commentId: string): Promise<IssueCommentConflictError> {
	const current = await getProjectIssueCommentOrThrow(executor, commentId);
	return new IssueCommentConflictError(current.id, current.revision, current.content_hash);
}

async function getProjectIssueCommentOrThrow(executor: TenantExecutor, commentId: string): Promise<IssueCommentRow> {
	const comment = await findProjectIssueComment(executor, commentId);
	if (!comment) {
		throw new Error(`Issue comment not found: ${commentId}`);
	}
	return comment;
}

async function getProjectIssueIdOrThrow(executor: TenantExecutor, issueId: string): Promise<string> {
	const id = await findProjectIssueId(executor, issueId);
	if (!id) {
		throw new Error(`Entity not found: ${issueId}`);
	}
	return id;
}

async function listIssueCommentReferences(executor: TenantExecutor, commentId: string): Promise<string[]> {
	const references = await executor
		.select({ issueId: issueCommentReferences.issueId })
		.from(issueCommentReferences)
		.where(and(
			eq(issueCommentReferences.tenantId, executor.tenantId),
			eq(issueCommentReferences.commentId, commentId)
		))
		.orderBy(asc(issueCommentReferences.position));
	return references.map((reference) => reference.issueId);
}

async function replaceIssueCommentReferences(executor: TenantExecutor, commentId: string, referencedIssueIds: string[]): Promise<void> {
	await executor.delete(issueCommentReferences).where(and(
		eq(issueCommentReferences.tenantId, executor.tenantId),
		eq(issueCommentReferences.commentId, commentId)
	));
	if (referencedIssueIds.length > 0) {
		await executor.insert(issueCommentReferences).values(referencedIssueIds.map((issueId, position) => ({
			tenantId: executor.tenantId,
			commentId,
			issueId,
			position
		})));
	}
}

async function validateReferencedIssueIds(executor: TenantExecutor, referencedIssueIds: string[]): Promise<string[]> {
	const deduplicated = [...new Set(referencedIssueIds)];
	for (const issueId of deduplicated) {
		await getProjectIssueIdOrThrow(executor, issueId);
	}
	return deduplicated;
}

async function findProjectIssueId(executor: TenantExecutor, issueId: string): Promise<string | undefined> {
	const [issue] = await executor
		.select({ id: entities.id })
		.from(entities)
		.where(and(
			eq(entities.tenantId, executor.tenantId),
			eq(entities.projectId, executor.currentProjectId),
			eq(entities.kind, "issue"),
			eq(entities.tombstone, false),
			sql`(${entities.id}::text = ${issueId} OR ${entities.reference} = ${issueId})`
		));
	return issue?.id;
}

async function findProjectIssueComment(executor: TenantExecutor, commentId: string): Promise<IssueCommentRow | undefined> {
	const result = await executor.execute(sql`
		SELECT issue_comments.*
		FROM issue_comments
		JOIN entities AS issue ON issue.tenant_id = issue_comments.tenant_id AND issue.id = issue_comments.issue_id
		WHERE issue_comments.tenant_id = ${executor.tenantId}
			AND issue.project_id = ${executor.currentProjectId}::uuid
			AND (issue_comments.id::text = ${commentId} OR issue_comments.reference = ${commentId} OR issue_comments.short_reference = ${commentId})
	`);
	return result.rows[0] as IssueCommentRow | undefined;
}

function toIssueCommentRecord(row: IssueCommentRow & { referencedIssueIds: string[] }): IssueCommentRecord {
	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		issueId: row.issue_id,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		...(!row.tombstone && { body: row.body }),
		referencedIssueIds: row.referencedIssueIds,
		tombstone: row.tombstone,
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

async function allocateShortReference(executor: TenantExecutor, id: string): Promise<string> {
	const baseReference = shortEntityReference({ id, kind: "issueComment" });
	let shortReference = baseReference;
	let suffix = 2;

	while ((await executor
		.select({ id: issueComments.id })
		.from(issueComments)
		.where(and(eq(issueComments.tenantId, executor.tenantId), eq(issueComments.shortReference, shortReference)))
		.limit(1)).length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}

	return shortReference;
}

function encodeCursor(comment: Pick<IssueCommentRecord, "createdAt" | "reference">): string {
	return Buffer.from(JSON.stringify({ createdAt: comment.createdAt, reference: comment.reference })).toString("base64url");
}

function decodeCursor(value: string): CommentCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; reference?: unknown };
		if (typeof cursor.createdAt !== "string" || typeof cursor.reference !== "string") {
			throw new Error();
		}
		return { createdAt: cursor.createdAt, reference: cursor.reference };
	} catch {
		throw new Error("Invalid issue comment cursor.");
	}
}