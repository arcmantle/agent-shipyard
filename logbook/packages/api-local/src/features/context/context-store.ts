import { randomUUID } from "node:crypto";
import { recordHistoryMaterialization } from "../history-diagnostics.js";

import {
	computeContextContentHash,
	computeContextTermContentHash,
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeCanonicalReference,
	generateContextIdentity,
	generateContextTermId,
	ContextConflictError,
	ContextRevisionError,
	ContextTermConflictError,
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	DEFAULT_PROJECT_ID,
	deriveMigratedEntityIdentity,
	filterContextDirectory,
	isEntityKind,
	mergeContextDirectory,
	materializeContextFromPatches,
	materializeContextTermFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	shortEntityReference,
	toContextWriteResult,
	toDefineContextTermAcknowledgement,
	type ContextDetails,
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListItem,
	type ContextListResult,
	type ContextRecord,
	type ContextStore,
	type ContextTermRecord,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision,
	type DefineContextTermResult,
	type EntityKind,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
} from "@agent-issues/core";
import { sql } from "drizzle-orm";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { getSqliteEntityOrThrow, type SqliteExecutor } from "../../db/sqlite-executor.js";


export {
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	type ContextDetails,
	type ContextDirectory,
	type ContextDirectoryTerm,
	type ContextDirectoryTermSource,
	type ContextDirectoryView,
	type ContextListItem,
	type ContextListResult,
	type ContextRecord,
	type ContextTermRecord,
	type DefineContextTermResult,
	type ForgetContextTermResult,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
};

const STRUCTURAL_CONTEXT_RELATIONS = ["owns", "records", "tracks", "creates", "decomposes"] as const;

type ContextRow = {
	id: string;
	reference: string;
	short_reference: string;
	created_by?: string | null;
	updated_by?: string | null;
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

type EntityRow = {
	id: string;
	kind: string;
	title: string;
	status: string;
	created_at: string;
	updated_at: string;
};

type ContextTermRow = {
	id: string;
	short_reference: string;
	created_by?: string | null;
	updated_by?: string | null;
	term: string;
	definition: string;
	avoid_terms: string;
	revision: number;
	content_hash: string;
	tombstone: number;
	created_at: string;
	updated_at: string;
};

type ContextTermHead = ContextTermRecord & { tombstone: boolean };

type ContextDeltaRow = {
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
	restored_from_revision: number | null;
	created_at: string;
};

type ContextTermDeltaRow = {
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Uint8Array;
	source_hash: Uint8Array;
	target_hash: Uint8Array;
	restored_from_revision: number | null;
	created_at: string;
};

type ResolvedContextScope = {
	key: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	defaultTitle: string;
	defaultSummary: string;
};

export function listContexts(executor: SqliteExecutor): ContextListResult {
	const rows = executor.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${executor.tenantId} ORDER BY key`) as ContextRow[];
	const rowByScopeEntityId = new Map<string, ContextRow>();
	const rowByKey = new Map<string, ContextRow>();

	for (const row of rows) {
		rowByKey.set(row.key, row);
		if (row.scope_entity_id) {
			rowByScopeEntityId.set(row.scope_entity_id, row);
		}
	}

	const defaultScope = getDefaultContextScope(executor);
	const contexts: ContextListItem[] = [
		createContextListItem(defaultScope, rowByKey.get(defaultScope.key), getContextTermCount(executor, defaultScope.key))
	];

	const initiativeRows = executor.drizzle.all(
		sql`SELECT * FROM entities WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND kind = 'initiative' AND tombstone = FALSE ORDER BY id`
	) as EntityRow[];

	for (const initiativeRow of initiativeRows) {
		const initiative = mapEntityRow(initiativeRow);
		const row = rowByScopeEntityId.get(initiative.id);
		const scope = createInitiativeScope(initiative, row?.key);
		contexts.push(createContextListItem(scope, row, getContextTermCount(executor, row?.key ?? initiative.id)));
	}

	return { contexts };
}

export function getContextDetails(executor: SqliteExecutor, input?: { scopeRef?: string }): ContextDetails {
	const scope = resolveContextScope(executor, input?.scopeRef);
	const contextRow = executor.drizzle.all(
		sql`SELECT * FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${scope.key}`
	)[0] as ContextRow | undefined;
	const termRows = contextRow
		? (executor.drizzle.all(
				sql`SELECT id, short_reference, created_by, updated_by, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at
					FROM context_terms
					WHERE tenant_id = ${executor.tenantId}
						AND context_key = ${scope.key}
						AND tombstone = FALSE
					ORDER BY lower(term), term`
			) as ContextTermRow[])
		: [];

	return {
		context: contextRow ? mapContextRow(contextRow, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

export function getContextDirectory(executor: SqliteExecutor): ContextDirectory {
	const shared = getContextDetails(executor);
	const initiativeRows = executor.drizzle.all(
		sql`SELECT * FROM entities WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND kind = 'initiative' AND tombstone = FALSE ORDER BY id`
	) as EntityRow[];
	const initiatives = initiativeRows.map((row) => getContextDetails(executor, { scopeRef: row.id }));

	return mergeContextDirectory(shared, initiatives);
}

export function queryContextDirectory(executor: SqliteExecutor, input: QueryContextDirectoryInput = {}): QueryContextDirectoryResult {
	const directory = getContextDirectory(executor);
	return filterContextDirectory(directory, input);
}

export function upsertContext(executor: SqliteExecutor, input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }, actorId: string = RESERVED_SYSTEM_AUTHOR): ContextDetails {
	const title = input.title.trim();
	const summary = input.summary.trim();

	if (title.length === 0) {
		throw new Error("Context title must not be empty.");
	}

	if (summary.length === 0) {
		throw new Error("Context summary must not be empty.");
	}

	const scope = resolveContextScope(executor, input.scopeRef);

	return executor.drizzle.transaction(() => {
		const existing = getContextDetails(executor, { scopeRef: input.scopeRef }).context;
		const now = new Date().toISOString();
		const newContentHash = computeContextContentHash(title, summary);

		if (existing.exists) {
			const newRevision = existing.revision + 1;

			if (input.expectedRevision === undefined || input.expectedContentHash === undefined) {
				throw new ContextConflictError(scope.key, existing.revision, existing.contentHash);
			}

			if (existing.revision !== input.expectedRevision || existing.contentHash !== input.expectedContentHash) {
				throw new ContextConflictError(scope.key, existing.revision, existing.contentHash);
			}

			const result = executor.drizzle.run(
				sql`UPDATE contexts SET title = ${title}, summary = ${summary}, revision = ${newRevision}, content_hash = ${newContentHash}, updated_by = ${actorId}, updated_at = ${now}
					WHERE tenant_id = ${executor.tenantId} AND key = ${scope.key} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`
			);

			if (result.changes === 0) {
				const fresh = getContextDetails(executor, { scopeRef: input.scopeRef }).context;
				throw new ContextConflictError(scope.key, fresh.revision, fresh.contentHash);
			}

			appendContextDeltaEntry(executor, scope.key, newRevision, existing.title, existing.summary, actorId, now);
		} else {
			const identity = generateContextIdentity();
			const shortReference = allocateShortReference(executor, "contexts", "context", identity.stableId);
			executor.drizzle.run(
				sql`INSERT INTO contexts (tenant_id, id, reference, short_reference, key, created_by, updated_by, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
					VALUES (${executor.tenantId}, ${identity.stableId}, ${identity.reference}, ${shortReference}, ${scope.key}, ${actorId}, ${actorId}, ${scope.scopeEntityId}, ${title}, ${summary}, 1, ${newContentHash}, ${now}, ${now})`
			);
			appendContextDeltaEntry(executor, scope.key, 1, title, summary, actorId, now);
		}

		return getContextDetails(executor, { scopeRef: input.scopeRef });
	});
}

export function defineContextTerm(
	executor: SqliteExecutor,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string },
	actorId: string = RESERVED_SYSTEM_AUTHOR
): DefineContextTermResult {
	const term = input.term.trim();
	const definition = input.definition.trim();

	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	if (definition.length === 0) {
		throw new Error("Context term definition must not be empty.");
	}

	const scope = ensureContextExists(executor, input.scopeRef, actorId);

	const normalizedAvoid = normalizeAvoidTerms(input.avoid ?? [], term);
	const existing = getContextTerm(executor, scope.key, term);
	const now = new Date().toISOString();

	const contentHash = computeContextTermContentHash(term, definition, normalizedAvoid, false);
	executor.drizzle.transaction(() => {
		if (existing) {
			assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
			const revision = existing.revision + 1;
			const result = executor.drizzle.run(sql`UPDATE context_terms
				SET definition = ${definition}, avoid_terms = ${JSON.stringify(normalizedAvoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = FALSE, updated_by = ${actorId}, updated_at = ${now}
				WHERE tenant_id = ${executor.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
			if (result.changes === 0) {
				const fresh = getContextTerm(executor, scope.key, term)!;
				throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
			}
			appendContextTermDeltaEntry(executor, scope.key, term, revision, existing, actorId, now);
		} else {
			const id = generateContextTermId();
			const shortReference = allocateShortReference(executor, "context_terms", "contextTerm", id);
			executor.drizzle.run(sql`INSERT INTO context_terms (tenant_id, id, short_reference, context_key, created_by, updated_by, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at)
				VALUES (${executor.tenantId}, ${id}, ${shortReference}, ${scope.key}, ${actorId}, ${actorId}, ${term}, ${definition}, ${JSON.stringify(normalizedAvoid)}, 1, ${contentHash}, FALSE, ${now}, ${now})`);
			appendContextTermDeltaEntry(
				executor,
				scope.key,
				term,
				1,
				{ id, reference: encodeCanonicalReference("contextTerm", id), shortReference, createdBy: actorId, updatedBy: actorId, term, definition, avoid: normalizedAvoid, revision: 1, contentHash, tombstone: false, createdAt: now, updatedAt: now },
				actorId,
				now
			);
		}
	});

	const storedTerm = getContextTerm(executor, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}
	const { tombstone: _tombstone, ...publicTerm } = storedTerm;

	return {
		context: getContextDetails(executor, { scopeRef: input.scopeRef }).context,
		term: publicTerm,
		created: existing === null
	};
}

export function forgetContextTerm(executor: SqliteExecutor, input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }, actorId: string = RESERVED_SYSTEM_AUTHOR): ForgetContextTermResult {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = resolveContextScope(executor, input.scopeRef);
	const existing = getContextTerm(executor, scope.key, term);
	if (!existing) {
		return { context: getContextDetails(executor, { scopeRef: input.scopeRef }).context, term, removed: false };
	}

	assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
	if (existing.tombstone) {
		return {
			context: getContextDetails(executor, { scopeRef: input.scopeRef }).context,
			term,
			removed: false,
			currentRevision: existing.revision,
			currentContentHash: existing.contentHash
		};
	}

	const revision = existing.revision + 1;
	const contentHash = computeContextTermContentHash(existing.term, existing.definition, existing.avoid, true);
	const now = new Date().toISOString();
	executor.drizzle.transaction(() => {
		const result = executor.drizzle.run(sql`UPDATE context_terms SET revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_by = ${actorId}, updated_at = ${now}
			WHERE tenant_id = ${executor.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextTerm(executor, scope.key, term)!;
			throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
		}
		appendContextTermDeltaEntry(executor, scope.key, term, revision, existing, actorId, now);
	});

	return {
		context: getContextDetails(executor, { scopeRef: input.scopeRef }).context,
		term,
		removed: true,
		currentRevision: revision,
		currentContentHash: contentHash
	};
}

export function materializeContextRevision(
	executor: SqliteExecutor,
	input: { scopeRef?: string; revision: number }
): MaterializedContextRevision {
	const scope = resolveContextScope(executor, input.scopeRef);
	const head = executor.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${scope.key}`)[0] as ContextRow | undefined;
	if (!head) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	const rows = executor.drizzle.all(sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM revision_entries
		WHERE tenant_id = ${executor.tenantId}
			AND project_id = ${resolveContextProjectId(executor, scope.key)}
			AND record_kind = 'context'
			AND record_key = ${encodeContextRecordKey(head.id)}
		ORDER BY revision DESC`) as ContextDeltaRow[];
	const result = materializeContextFromPatches(
		{ key: head.key, title: head.title, summary: head.summary, revision: head.revision, createdAt: head.created_at },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.created_at, patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: decodeRevisionPatchHash(row.source_hash), targetHash: decodeRevisionPatchHash(row.target_hash), ...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision }) })),
		input.revision
	);
	recordHistoryMaterialization(executor, "context", result.headRevision, result.targetRevision);
	return result;
}

export function restoreContextRevision(
	executor: SqliteExecutor,
	input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = RESERVED_SYSTEM_AUTHOR
): MaterializedContextRevision {
	const scope = resolveContextScope(executor, input.scopeRef);
	const current = getContextDetails(executor, { scopeRef: input.scopeRef }).context;
	if (!current.exists) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new ContextConflictError(scope.key, current.revision, current.contentHash);
	}
	const source = materializeContextRevision(executor, { scopeRef: input.scopeRef, revision: input.revision });

	return executor.drizzle.transaction(() => {
		const revision = current.revision + 1;
		const contentHash = computeContextContentHash(source.title, source.summary);
		const updatedAt = new Date().toISOString();
		const result = executor.drizzle.run(sql`UPDATE contexts
			SET title = ${source.title}, summary = ${source.summary}, revision = ${revision}, content_hash = ${contentHash}, updated_by = ${actorId}, updated_at = ${updatedAt}
			WHERE tenant_id = ${executor.tenantId} AND key = ${scope.key} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextDetails(executor, { scopeRef: input.scopeRef }).context;
			throw new ContextConflictError(scope.key, fresh.revision, fresh.contentHash);
		}
		appendContextDeltaEntry(executor, scope.key, revision, current.title, current.summary, actorId, updatedAt, input.revision);
		return materializeContextRevision(executor, { scopeRef: input.scopeRef, revision });
	});
}

export function materializeContextTermRevision(
	executor: SqliteExecutor,
	input: { scopeRef?: string; term: string; revision: number }
): MaterializedContextTermRevision {
	const scope = resolveContextScope(executor, input.scopeRef);
	const head = getContextTerm(executor, scope.key, input.term.trim());
	if (!head) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${input.term}`, undefined, input.term);
	}
	const rows = executor.drizzle.all(sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM revision_entries
		WHERE tenant_id = ${executor.tenantId}
			AND record_kind = 'context-term'
			AND record_key = ${encodeContextTermRecordKey(head.id)}
		ORDER BY revision DESC`) as ContextTermDeltaRow[];
	const result = materializeContextTermFromPatches(
		{ id: head.id, contextKey: scope.key, term: head.term, definition: head.definition, avoid: head.avoid, tombstone: head.tombstone, revision: head.revision, createdAt: head.createdAt },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.created_at, patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: decodeRevisionPatchHash(row.source_hash), targetHash: decodeRevisionPatchHash(row.target_hash), ...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision }) })),
		input.revision
	);
	recordHistoryMaterialization(executor, "context-term", result.headRevision, result.targetRevision);
	return result;
}

export function restoreContextTermRevision(
	executor: SqliteExecutor,
	input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = RESERVED_SYSTEM_AUTHOR
): MaterializedContextTermRevision {
	const scope = resolveContextScope(executor, input.scopeRef);
	const term = input.term.trim();
	const current = getContextTerm(executor, scope.key, term);
	if (!current) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
	}
	assertContextTermHead(scope.key, term, current, input.expectedRevision, input.expectedContentHash);
	const source = materializeContextTermRevision(executor, { scopeRef: input.scopeRef, term, revision: input.revision });

	return executor.drizzle.transaction(() => {
		const revision = current.revision + 1;
		const contentHash = computeContextTermContentHash(source.term, source.definition, source.avoid, source.tombstone);
		const updatedAt = new Date().toISOString();
		const result = executor.drizzle.run(sql`UPDATE context_terms
			SET definition = ${source.definition}, avoid_terms = ${JSON.stringify(source.avoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = ${source.tombstone ? 1 : 0}, updated_by = ${actorId}, updated_at = ${updatedAt}
			WHERE tenant_id = ${executor.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if (result.changes === 0) {
			const fresh = getContextTerm(executor, scope.key, term)!;
			throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
		}
		appendContextTermDeltaEntry(executor, scope.key, term, revision, current, actorId, updatedAt, input.revision);
		return materializeContextTermRevision(executor, { scopeRef: input.scopeRef, term, revision });
	});
}


function ensureContextExists(executor: SqliteExecutor, scopeRef?: string, actorId: string = RESERVED_SYSTEM_AUTHOR): ResolvedContextScope {
	const scope = resolveContextScope(executor, scopeRef);
	const existing = executor.drizzle.all(
		sql`SELECT key FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${scope.key}`
	)[0] as { key: string } | undefined;
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	const contentHash = computeContextContentHash(scope.defaultTitle, scope.defaultSummary);
	const identity = generateContextIdentity();
	const shortReference = allocateShortReference(executor, "contexts", "context", identity.stableId);
	executor.drizzle.run(sql`INSERT INTO contexts (tenant_id, id, reference, short_reference, key, created_by, updated_by, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
		VALUES (${executor.tenantId}, ${identity.stableId}, ${identity.reference}, ${shortReference}, ${scope.key}, ${actorId}, ${actorId}, ${scope.scopeEntityId}, ${scope.defaultTitle}, ${scope.defaultSummary}, 1, ${contentHash}, ${now}, ${now})`);
	appendContextDeltaEntry(executor, scope.key, 1, scope.defaultTitle, scope.defaultSummary, actorId, now);

	return scope;
}

function appendContextDeltaEntry(
	executor: SqliteExecutor,
	contextKey: string,
	revision: number,
	priorTitle: string,
	priorSummary: string,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): void {
	const id = randomUUID();
	const authorValue = author?.trim() || RESERVED_SYSTEM_AUTHOR;
	const row = executor.drizzle.all(sql`SELECT id, title, summary FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${contextKey}`)[0] as { id: string; title: string; summary: string } | undefined;
	if (!row) {
		throw new Error(`Cannot append reverse patch for missing context ${contextKey}.`);
	}
	const successor = { title: row.title, summary: row.summary };
	const transition = createReverseFieldPatch(successor, { title: priorTitle, summary: priorSummary }, CONTEXT_REVERSE_PATCH_REGISTRY);
	executor.drizzle.run(
		sql`INSERT INTO revision_entries
			(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
			VALUES (${id}, ${executor.tenantId}, ${resolveContextProjectId(executor, contextKey)}, 'context', ${encodeContextRecordKey(row.id)}, ${revision}, ${authorValue}, ${transition.patchFormat}, ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)}, ${encodeRevisionPatchHash(transition.targetHash)}, ${restoredFromRevision ?? null}, ${createdAt})`
	);
}

function getContextTerm(executor: SqliteExecutor, contextKey: string, term: string): ContextTermHead | null {
	const row = executor.drizzle.all(sql`SELECT id, short_reference, created_by, updated_by, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at
		FROM context_terms
		WHERE tenant_id = ${executor.tenantId} AND context_key = ${contextKey} AND term = ${term}`)[0] as ContextTermRow | undefined;

	return row ? { ...mapContextTermRow(row), tombstone: Boolean(row.tombstone) } : null;
}

function assertContextTermHead(
	contextKey: string,
	term: string,
	existing: ContextTermHead,
	expectedRevision: number | undefined,
	expectedContentHash: string | undefined
): void {
	if (expectedRevision !== existing.revision || expectedContentHash !== existing.contentHash) {
		throw new ContextTermConflictError(contextKey, term, existing.revision, existing.contentHash);
	}
}

function appendContextTermDeltaEntry(
	executor: SqliteExecutor,
	contextKey: string,
	term: string,
	revision: number,
	prior: ContextTermHead,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): void {
	const successor = getContextTerm(executor, contextKey, term)!;
	const transition = createReverseFieldPatch(
		{ term: successor.term, definition: successor.definition, avoid: successor.avoid, tombstone: successor.tombstone },
		{ term: prior.term, definition: prior.definition, avoid: prior.avoid, tombstone: prior.tombstone },
		CONTEXT_TERM_REVERSE_PATCH_REGISTRY
	);
	executor.drizzle.run(sql`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${executor.tenantId}, ${resolveContextProjectId(executor, contextKey)}, 'context-term', ${encodeContextTermRecordKey(successor.id)}, ${revision}, ${author?.trim() || RESERVED_SYSTEM_AUTHOR}, ${transition.patchFormat}, ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)}, ${encodeRevisionPatchHash(transition.targetHash)}, ${restoredFromRevision ?? null}, ${createdAt})`);
}

function resolveContextProjectId(executor: SqliteExecutor, contextKey: string): string {
	const row = executor.drizzle.all(sql`SELECT scope.project_id
		FROM contexts AS context
		LEFT JOIN entities AS scope
			ON scope.tenant_id = context.tenant_id AND scope.id = context.scope_entity_id
		WHERE context.tenant_id = ${executor.tenantId} AND context.key = ${contextKey}`)[0] as { project_id: string | null } | undefined;
	if (!row) {
		throw new Error(`Cannot resolve project for missing context ${contextKey}.`);
	}
	if (row.project_id) {
		return row.project_id;
	}
	if (contextKey === DEFAULT_CONTEXT_KEY) {
		return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	}
	const projectPrefix = `${DEFAULT_CONTEXT_KEY}:`;
	if (contextKey.startsWith(projectPrefix) && contextKey.length > projectPrefix.length) {
		return getEntityOrThrow(executor, contextKey.slice(projectPrefix.length)).id;
	}
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

function createContextRecord(scope: ResolvedContextScope): ContextRecord {
	return {
		id: null,
		reference: null,
		shortReference: null,
		createdBy: null,
		updatedBy: null,
		key: scope.key,
		scopeKind: scope.scopeKind,
		scopeEntityId: scope.scopeEntityId,
		scopeLabel: scope.scopeLabel,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
		revision: 0,
		contentHash: "",
		createdAt: null,
		updatedAt: null,
		exists: false
	};
}

function mapContextRow(row: ContextRow, scope: ResolvedContextScope): ContextRecord {
	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		createdBy: row.created_by ?? null,
		updatedBy: row.updated_by ?? null,
		key: row.key,
		scopeKind: scope.scopeKind,
		scopeEntityId: scope.scopeEntityId,
		scopeLabel: scope.scopeLabel,
		title: row.title,
		summary: row.summary,
		revision: row.revision ?? 1,
		contentHash: row.content_hash ?? "",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		exists: true
	};
}

function mapContextTermRow(row: ContextTermRow): ContextTermRecord {
	return {
		id: row.id,
		reference: encodeCanonicalReference("contextTerm", row.id),
		shortReference: row.short_reference,
		createdBy: row.created_by ?? RESERVED_SYSTEM_AUTHOR,
		updatedBy: row.updated_by ?? RESERVED_SYSTEM_AUTHOR,
		term: row.term,
		definition: row.definition,
		avoid: parseAvoidTerms(row.avoid_terms),
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function allocateShortReference(executor: SqliteExecutor, table: "contexts" | "context_terms", kind: "context" | "contextTerm", id: string): string {
	const baseReference = shortEntityReference({ id, kind });
	let shortReference = baseReference;
	let suffix = 2;

	while (executor.drizzle.all(sql`SELECT id FROM ${sql.raw(table)} WHERE tenant_id = ${executor.tenantId} AND short_reference = ${shortReference}`).length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}

	return shortReference;
}

function parseAvoidTerms(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function normalizeAvoidTerms(avoid: string[], term: string): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const candidate of avoid) {
		const cleaned = candidate.trim();
		if (cleaned.length === 0 || cleaned.toLowerCase() === term.toLowerCase()) {
			continue;
		}

		const key = cleaned.toLowerCase();
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		normalized.push(cleaned);
	}

	return normalized;
}

function resolveContextScope(executor: SqliteExecutor, scopeRef?: string): ResolvedContextScope {
	if (!scopeRef || scopeRef === DEFAULT_CONTEXT_KEY) {
		return getDefaultContextScope(executor);
	}

	const entity = getEntityOrThrow(executor, scopeRef);
	if (entity.kind === "initiative") {
		return createInitiativeScope(entity, getInitiativeContextKey(executor, entity.id));
	}

	if (entity.kind === "project") {
		return createProjectScope(entity);
	}

	const initiative = getOwningInitiativeOrThrow(executor, entity.id);
	return createInitiativeScope(initiative, getInitiativeContextKey(executor, initiative.id));
}

function getInitiativeContextKey(executor: SqliteExecutor, initiativeId: string): string | undefined {
	const row = executor.drizzle.all(sql`SELECT key FROM contexts
		WHERE tenant_id = ${executor.tenantId} AND scope_entity_id = ${initiativeId}`)[0] as { key: string } | undefined;
	return row?.key;
}

/**
 * The tenant's sentinel default scope (`DEFAULT_PROJECT_ID`/"PROJ0"), used
 * both when a workspace's own project IS that sentinel (the common
 * single-project-tenant case, unchanged since before ISS166) and when an
 * explicit `--scope` names that project directly.
 */
function createSentinelDefaultScope(): ResolvedContextScope {
	return {
		key: DEFAULT_CONTEXT_KEY,
		scopeKind: "default",
		scopeEntityId: null,
		scopeLabel: "Shared",
		defaultTitle: DEFAULT_CONTEXT_TITLE,
		defaultSummary: DEFAULT_CONTEXT_SUMMARY
	};
}

/**
 * A specific project's own shared/default context scope (ISS166). Keyed
 * `default:<projectId>` to match exactly what ISS60's tenant-to-project
 * migration already wrote when it namespaced a folded-in legacy tenant's
 * "default" context row to avoid colliding with every other project now
 * sharing this tenant - so those rows become reachable again once
 * `resolveContextScope` resolves this same key.
 */
function createProjectScope(project: EntityRecord): ResolvedContextScope {
	if (project.id === deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId) {
		return createSentinelDefaultScope();
	}

	return {
		key: `${DEFAULT_CONTEXT_KEY}:${project.id}`,
		scopeKind: "project",
		scopeEntityId: project.id,
		scopeLabel: project.title,
		defaultTitle: `${project.title} Context`,
		defaultSummary: `Shared glossary of project-specific domain terms and preferred language for ${project.title}.`
	};
}

/**
 * Bare (no `--scope`) context resolution (ISS166): resolves to the CURRENT
 * workspace's own project's shared glossary - `executor.currentProjectId`,
 * resolved once per open from `currentWorkingDirectory` - instead of the
 * one tenant-wide literal "default" every project used to collide on.
 */
function getDefaultContextScope(executor: SqliteExecutor): ResolvedContextScope {
	const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	const isDefaultProject = executor.currentProjectId === DEFAULT_PROJECT_ID || executor.currentProjectId === defaultProjectId;
	if (isDefaultProject) {
		return createSentinelDefaultScope();
	}

	return createProjectScope(getEntityOrThrow(executor, executor.currentProjectId));
}

function createInitiativeScope(initiative: EntityRecord, contextKey: string = initiative.id): ResolvedContextScope {
	return {
		key: contextKey,
		scopeKind: "initiative",
		scopeEntityId: initiative.id,
		scopeLabel: initiative.title,
		defaultTitle: `${initiative.title} Context`,
		defaultSummary: `Glossary of initiative-specific domain terms for ${initiative.title}.`
	};
}

function createContextListItem(scope: ResolvedContextScope, row: ContextRow | undefined, termCount: number): ContextListItem {
	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		termCount
	};
}

function getContextTermCount(executor: SqliteExecutor, contextKey: string): number {
	const row = executor.drizzle.all(
		sql`SELECT COUNT(*) as count FROM context_terms WHERE tenant_id = ${executor.tenantId} AND context_key = ${contextKey} AND tombstone = FALSE`
	)[0] as { count: number };
	return row.count;
}

type EntityRecord = {
	id: string;
	kind: EntityKind;
	title: string;
	status: string;
	createdAt: string;
	updatedAt: string;
};

function getEntityOrThrow(executor: SqliteExecutor, entityId: string): EntityRecord {
	return mapEntityRow(getSqliteEntityOrThrow(executor, entityId) as unknown as EntityRow);
}

function getOwningInitiativeOrThrow(executor: SqliteExecutor, entityId: string): EntityRecord {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const parents = executor.drizzle.all(sql`SELECT entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${executor.tenantId}
				AND relations.to_id = ${currentId}
				AND relations.type IN ('owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY entities.id`) as EntityRow[];

		if (parents.length === 0) {
			throw new Error(`No owning initiative found for ${entityId}.`);
		}

		if (parents.length > 1) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = mapEntityRow(parents[0]);
		if (seen.has(parent.id)) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because the structural graph contains a cycle.`);
		}

		if (parent.kind === "initiative") {
			return parent;
		}

		seen.add(parent.id);
		currentId = parent.id;
	}
}

function mapEntityRow(row: EntityRow): EntityRecord {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Unexpected entity kind in database: ${row.kind}`);
	}

	return {
		id: row.id,
		kind: row.kind,
		title: row.title,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function tenantParams<T extends Record<string, unknown>>(executor: SqliteExecutor, values: T): T & { tenantId: string } {
	return {
		tenantId: executor.tenantId,
		...values
	};
}

/**
 * The context/glossary feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin, promise-returning
 * wrapper over the executor-holding local free functions above, which
 * `SqliteStore` composes alongside the other three feature classes.
 */
export class LocalContextStore implements ContextStore {
	public constructor(private readonly executor: SqliteExecutor) {}

	public async listContexts(): Promise<ContextListResult> {
		return listContexts(this.executor);
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return getContextDetails(this.executor, input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return getContextDirectory(this.executor);
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult> {
		return queryContextDirectory(this.executor, input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): ReturnType<ContextStore["upsertContext"]> {
		return toContextWriteResult(upsertContext(this.executor, input));
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }): ReturnType<ContextStore["defineContextTerm"]> {
		return toDefineContextTermAcknowledgement(defineContextTerm(this.executor, input));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return forgetContextTerm(this.executor, input);
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }): Promise<MaterializedContextRevision> {
		return materializeContextRevision(this.executor, input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }): Promise<MaterializedContextTermRevision> {
		return materializeContextTermRevision(this.executor, input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextRevision> {
		return restoreContextRevision(this.executor, input);
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextTermRevision> {
		return restoreContextTermRevision(this.executor, input);
	}
}