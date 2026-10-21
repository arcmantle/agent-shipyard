import {
	computeContextContentHash,
	computeContextTermContentHash,
	deriveUserIdentity,
	deriveMigratedEntityIdentity,
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	encodeCanonicalReference,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	generateContextIdentity,
	generateContextTermId,
	ContextConflictError,
	ContextRevisionError,
	ContextTermConflictError,
	DEFAULT_CONTEXT_KEY,
	DEFAULT_CONTEXT_SUMMARY,
	DEFAULT_CONTEXT_TITLE,
	filterContextDirectory,
	isEntityCategory,
	isEntityPriority,
	mergeContextDirectory,
	materializeContextFromPatches,
	materializeContextTermFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	shortEntityReference,
	SYSTEM_AUTHENTICATION_SUBJECT,
	toContextWriteResult,
	toDefineContextTermAcknowledgement,
	type ContextDetails,
	type ContextDirectory,
	type ContextListResult,
	type ContextRecord,
	type ContextStore,
	type ContextTermRecord,
	type DefineContextTermResult,
	type EntityRecord,
	type ForgetContextTermResult,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision,
	type QueryContextDirectoryInput,
	type QueryContextDirectoryResult
} from "@agent-issues/core";
import { randomUUID } from "node:crypto";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { TenantExecutor } from "../../db/connection.js";
import { contextTerms, contexts, entities, relations, revisionEntries } from "../../schema.js";

import {
	getEntityOrThrow,
	getOrCreateProjectByIdentity,
	mapEntityRow,
	nextEntityId,
	type EntityRow
} from "../entity-store/store.js";

const SYSTEM_USER_ID = deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id;

export type ContextRow = {
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

export type ContextTermRow = {
	id: string;
	short_reference: string;
	created_by?: string | null;
	updated_by?: string | null;
	term: string;
	definition: string;
	avoid_terms: string;
	revision: number;
	content_hash: string;
	tombstone: boolean;
	created_at: string;
	updated_at: string;
};

type ContextTermHead = ContextTermRecord & { tombstone: boolean };

// Mirrors context-store.ts's private ResolvedContextScope: the "default" vs.
// "initiative" scope a context key resolves to, plus the default
// title/summary to synthesize when no row has been saved yet.
type ResolvedContextScope = {
	key: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	defaultTitle: string;
	defaultSummary: string;
};

function getDefaultContextScope(): ResolvedContextScope {
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
 * A specific project's own shared/default context scope (ISS183, mirroring
 * core's `context-store.ts` `createProjectScope`). Keyed `default:<projectId>`
 * so this lines up with the exact same key shape local `SqliteStore` uses for
 * a non-sentinel project's default context.
 */
function createProjectScope(project: EntityRecord): ResolvedContextScope {
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
 * Bare (no `--scope`) context resolution (ISS183, mirroring core's
 * project-aware `getDefaultContextScope` from ISS166): resolves to the
 * CURRENT project's own shared glossary when a `projectIdentity` is known
 * for this request, instead of the one tenant-wide sentinel every project
 * in a multi-project tenant would otherwise collide on. Undefined
 * `projectIdentity` (no header sent) keeps today's sentinel-only behavior.
 */
async function resolveDefaultContextScope(executor: TenantExecutor, projectIdentity: string | undefined): Promise<ResolvedContextScope> {
	if (!projectIdentity) {
		return getDefaultContextScope();
	}

	const project = await getOrCreateProjectByIdentity(executor, projectIdentity);
	return createProjectScope(project);
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
		createdBy: row.created_by ?? SYSTEM_USER_ID,
		updatedBy: row.updated_by ?? SYSTEM_USER_ID,
		term: row.term,
		definition: row.definition,
		avoid: parseAvoidTerms(row.avoid_terms),
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
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

// Walks record-to-initiative structural relations from `entityId` up to its
// owning initiative.
async function getOwningInitiativeOrThrow(executor: TenantExecutor, entityId: string): Promise<EntityRecord> {
	let currentId = entityId;
	const seen = new Set<string>([entityId]);

	while (true) {
		const result = await executor.execute(sql`
			SELECT entities.*
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${executor.tenantId}
				AND relations.to_id = ${currentId}
				AND relations.type IN ('owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY entities.id
		`);
		const rows = result.rows as EntityRow[];

		if (rows.length === 0) {
			throw new Error(`No owning initiative found for ${entityId}.`);
		}

		if (rows.length > 1) {
			throw new Error(`Cannot resolve owning initiative for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = mapEntityRow(rows[0]!);
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

async function resolveContextScope(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	scopeRef?: string
): Promise<ResolvedContextScope> {
	if (!scopeRef || scopeRef === DEFAULT_CONTEXT_KEY) {
		return resolveDefaultContextScope(executor, projectIdentity);
	}

	const entity = await getEntityOrThrow(executor, scopeRef);
	if (entity.kind === "initiative") {
		return createInitiativeScope(entity, await getInitiativeContextKey(executor, entity.id));
	}
	if (entity.kind === "project") {
		return createProjectScope(entity);
	}

	const initiative = await getOwningInitiativeOrThrow(executor, entity.id);
	return createInitiativeScope(initiative, await getInitiativeContextKey(executor, initiative.id));
}

async function getInitiativeContextKey(executor: TenantExecutor, initiativeId: string): Promise<string | undefined> {
	const [row] = await executor
		.select({ key: contexts.key })
		.from(contexts)
		.where(and(eq(contexts.tenantId, executor.tenantId), eq(contexts.scopeEntityId, initiativeId)))
		.limit(1);
	return row?.key;
}

async function fetchContextRow(executor: TenantExecutor, key: string): Promise<ContextRow | undefined> {
	const [row] = await executor
		.select()
		.from(contexts)
		.where(and(eq(contexts.tenantId, executor.tenantId), eq(contexts.key, key)))
		.limit(1);
	return row && {
		id: row.id,
		reference: row.reference,
		short_reference: row.shortReference,
		created_by: row.createdBy,
		updated_by: row.updatedBy,
		key: row.key,
		scope_entity_id: row.scopeEntityId,
		title: row.title,
		summary: row.summary,
		revision: row.revision,
		content_hash: row.contentHash,
		created_at: row.createdAt,
		updated_at: row.updatedAt
	};
}

async function fetchContextTermRows(executor: TenantExecutor, key: string): Promise<ContextTermRow[]> {
	const rows = await executor
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, executor.tenantId), eq(contextTerms.contextKey, key), eq(contextTerms.tombstone, false)))
		.orderBy(sql`lower(${contextTerms.term})`, asc(contextTerms.term));
	return rows.map((row) => ({
		id: row.id,
		short_reference: row.shortReference,
		created_by: row.createdBy,
		updated_by: row.updatedBy,
		term: row.term,
		definition: row.definition,
		avoid_terms: row.avoidTerms,
		revision: row.revision,
		content_hash: row.contentHash,
		tombstone: row.tombstone,
		created_at: row.createdAt,
		updated_at: row.updatedAt
	}));
}

async function queryContextDetails(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	scopeRef?: string
): Promise<ContextDetails> {
	const scope = await resolveContextScope(executor, projectIdentity, scopeRef);
	const row = await fetchContextRow(executor, scope.key);
	const termRows = row ? await fetchContextTermRows(executor, scope.key) : [];

	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

export async function queryProjectContextDetails(
	executor: TenantExecutor,
	project: EntityRecord,
	scopeRef?: string
): Promise<ContextDetails> {
	const scope = scopeRef ? await resolveContextScope(executor, undefined, scopeRef) : createProjectScope(project);
	const row = await fetchContextRow(executor, scope.key);
	const termRows = row ? await fetchContextTermRows(executor, scope.key) : [];

	return {
		context: row ? mapContextRow(row, scope) : createContextRecord(scope),
		terms: termRows.map(mapContextTermRow)
	};
}

async function queryContextTermCount(executor: TenantExecutor, contextKey: string): Promise<number> {
	const [result] = await executor
		.select({ count: sql<number>`count(*)` })
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, executor.tenantId), eq(contextTerms.contextKey, contextKey), eq(contextTerms.tombstone, false)));
	return Number(result?.count ?? 0);
}

async function queryListContexts(executor: TenantExecutor, projectIdentity: string | undefined): Promise<ContextListResult> {
	const defaultScope = await resolveDefaultContextScope(executor, projectIdentity);
	const defaultRow = await fetchContextRow(executor, defaultScope.key);
	const contexts = [
		{
			context: defaultRow ? mapContextRow(defaultRow, defaultScope) : createContextRecord(defaultScope),
			termCount: await queryContextTermCount(executor, defaultScope.key)
		}
	];

	const initiativeRows = await executor
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.projectId, executor.currentProjectId), eq(entities.kind, "initiative"), eq(entities.tombstone, false)))
		.orderBy(asc(entities.id));

	for (const initiativeRow of initiativeRows) {
		const initiative = {
			id: initiativeRow.id,
			reference: initiativeRow.reference,
			shortReference: initiativeRow.shortReference,
			createdBy: initiativeRow.createdBy ?? RESERVED_SYSTEM_AUTHOR,
			updatedBy: initiativeRow.updatedBy ?? RESERVED_SYSTEM_AUTHOR,
			kind: "initiative" as const,
			title: initiativeRow.title,
			status: initiativeRow.status,
			body: initiativeRow.body,
			bodySource: initiativeRow.bodySource === "generated" ? ("generated" as const) : ("authored" as const),
			category: initiativeRow.category && isEntityCategory(initiativeRow.category) ? initiativeRow.category : null,
			priority: initiativeRow.priority && isEntityPriority(initiativeRow.priority) ? initiativeRow.priority : null,
			type: null,
			revision: initiativeRow.revision,
			contentHash: initiativeRow.contentHash,
			createdAt: initiativeRow.createdAt,
			updatedAt: initiativeRow.updatedAt
		};
		const scope = createInitiativeScope(initiative, await getInitiativeContextKey(executor, initiative.id));
		const row = await fetchContextRow(executor, scope.key);
		contexts.push({
			context: row ? mapContextRow(row, scope) : createContextRecord(scope),
			termCount: await queryContextTermCount(executor, scope.key)
		});
	}

	return { contexts };
}

async function buildContextDirectory(executor: TenantExecutor, projectIdentity: string | undefined): Promise<ContextDirectory> {
	const shared = await queryContextDetails(executor, projectIdentity);
	const initiativeRows = await executor
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.projectId, executor.currentProjectId), eq(entities.kind, "initiative"), eq(entities.tombstone, false)))
		.orderBy(asc(entities.id));
	const initiatives = await Promise.all(initiativeRows.map((row) => queryContextDetails(executor, projectIdentity, row.id)));

	return mergeContextDirectory(shared, initiatives);
}

async function ensureContextExists(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	scopeRef?: string,
	actorId: string = SYSTEM_USER_ID
): Promise<ResolvedContextScope> {
	const scope = await resolveContextScope(executor, projectIdentity, scopeRef);
	const existing = await fetchContextRow(executor, scope.key);
	if (existing) {
		return scope;
	}

	const now = new Date().toISOString();
	const contentHash = computeContextContentHash(scope.defaultTitle, scope.defaultSummary);
	const identity = generateContextIdentity();
	await executor.insert(contexts).values({
		tenantId: executor.tenantId,
		id: identity.stableId,
		reference: identity.reference,
		shortReference: await allocateContextShortReference(executor, identity.stableId),
		key: scope.key,
		createdBy: actorId,
		updatedBy: actorId,
		scopeEntityId: scope.scopeEntityId,
		title: scope.defaultTitle,
		summary: scope.defaultSummary,
		revision: 1,
		contentHash,
		createdAt: now,
		updatedAt: now
	});
	await appendContextDeltaEntry(executor, scope.key, 1, scope.defaultTitle, scope.defaultSummary, actorId, now);

	return scope;
}

async function getContextTermRecord(executor: TenantExecutor, contextKey: string, term: string): Promise<ContextTermHead | null> {
	const [row] = await executor
		.select()
		.from(contextTerms)
		.where(and(eq(contextTerms.tenantId, executor.tenantId), eq(contextTerms.contextKey, contextKey), eq(contextTerms.term, term)))
		.limit(1);
	return row
		? {
			...mapContextTermRow({
			id: row.id,
			short_reference: row.shortReference,
			created_by: row.createdBy,
			updated_by: row.updatedBy,
			term: row.term,
			definition: row.definition,
			avoid_terms: row.avoidTerms,
			revision: row.revision,
			content_hash: row.contentHash,
			tombstone: row.tombstone,
			created_at: row.createdAt,
			updated_at: row.updatedAt
			}),
			tombstone: row.tombstone
		}
		: null;
}

/**
 * Naming note: this exported function matches `PgStore.getContextDetails`'s
 * method signature exactly (object-shaped `input`), while `queryContextDetails`
 * (exported below) is the internal-shaped helper every other method here
 * (and `getDatabaseSnapshot` in the entity-store feature) calls directly
 * with a raw `scopeRef`.
 */
export async function getContextDetails(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input?: { scopeRef?: string }
): Promise<ContextDetails> {
	return queryContextDetails(executor, projectIdentity, input?.scopeRef);
}

export { queryContextDetails };

export async function listContexts(executor: TenantExecutor, projectIdentity: string | undefined): Promise<ContextListResult> {
	return queryListContexts(executor, projectIdentity);
}

export async function getContextDirectory(executor: TenantExecutor, projectIdentity: string | undefined): Promise<ContextDirectory> {
	return buildContextDirectory(executor, projectIdentity);
}

export async function queryContextDirectory(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: QueryContextDirectoryInput = {}
): Promise<QueryContextDirectoryResult> {
	const directory = await buildContextDirectory(executor, projectIdentity);
	return filterContextDirectory(directory, input);
}

export async function upsertContext(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }
	, actorId: string
): Promise<ContextDetails> {
	const title = input.title.trim();
	const summary = input.summary.trim();

	if (title.length === 0) {
		throw new Error("Context title must not be empty.");
	}

	if (summary.length === 0) {
		throw new Error("Context summary must not be empty.");
	}

	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const existingDetails = await queryContextDetails(executor, projectIdentity, input.scopeRef);
	const existing = existingDetails.context;
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

		const result = await executor.execute(sql`
			UPDATE contexts
			SET title = ${title}, summary = ${summary},
			    revision = ${newRevision}, content_hash = ${newContentHash},
			    updated_by = ${actorId}::uuid,
			    updated_at = ${now}
			WHERE tenant_id = ${executor.tenantId}
			  AND key = ${scope.key}
			  AND revision = ${input.expectedRevision}
			  AND content_hash = ${input.expectedContentHash}
		`);

		if ((result.rowCount ?? 0) === 0) {
			const fresh = await fetchContextRow(executor, scope.key);
			if (!fresh) {
				throw new Error(`Context ${scope.key} disappeared during CAS update.`);
			}
			throw new ContextConflictError(scope.key, fresh.revision, fresh.content_hash);
		}

		await appendContextDeltaEntry(executor, scope.key, newRevision, existing.title, existing.summary, actorId, now);
	} else {
		const identity = generateContextIdentity();
		await executor.insert(contexts).values({
			tenantId: executor.tenantId,
			id: identity.stableId,
			reference: identity.reference,
			shortReference: await allocateContextShortReference(executor, identity.stableId),
			key: scope.key,
			createdBy: actorId,
			updatedBy: actorId,
			scopeEntityId: scope.scopeEntityId,
			title,
			summary,
			revision: 1,
			contentHash: newContentHash,
			createdAt: now,
			updatedAt: now
		});
		await appendContextDeltaEntry(executor, scope.key, 1, title, summary, actorId, now);
	}

	return queryContextDetails(executor, projectIdentity, input.scopeRef);
}

async function appendContextDeltaEntry(
	executor: TenantExecutor,
	contextKey: string,
	revision: number,
	priorTitle: string,
	priorSummary: string,
	author: string | undefined,
	createdAt: string,
	restoredFromRevision?: number
): Promise<void> {
	const id = randomUUID();
	const authorValue = author?.trim() || RESERVED_SYSTEM_AUTHOR;
	const [row] = await executor.select({ id: contexts.id, title: contexts.title, summary: contexts.summary }).from(contexts).where(and(eq(contexts.tenantId, executor.tenantId), eq(contexts.key, contextKey)));
	if (!row) {
		throw new Error(`Cannot append reverse patch for missing context ${contextKey}.`);
	}
	const transition = createReverseFieldPatch({ title: row.title, summary: row.summary }, { title: priorTitle, summary: priorSummary }, CONTEXT_REVERSE_PATCH_REGISTRY);
	await executor.insert(revisionEntries).values({
		id,
		tenantId: executor.tenantId,
		projectId: await resolveContextProjectId(executor, contextKey),
		recordKind: "context",
		recordKey: encodeContextRecordKey(row.id),
		revision,
		author: authorValue,
		patchFormat: transition.patchFormat,
		reversePatch: Buffer.from(transition.reversePatch),
		sourceHash: encodeRevisionPatchHash(transition.sourceHash),
		targetHash: encodeRevisionPatchHash(transition.targetHash),
		restoredFromRevision: restoredFromRevision ?? null,
		createdAt
	});
}

export async function defineContextTerm(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string },
	actorId: string = SYSTEM_USER_ID
): Promise<DefineContextTermResult> {
	const term = input.term.trim();
	const definition = input.definition.trim();

	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	if (definition.length === 0) {
		throw new Error("Context term definition must not be empty.");
	}

	const scope = await ensureContextExists(executor, projectIdentity, input.scopeRef, actorId);
	const normalizedAvoid = normalizeAvoidTerms(input.avoid ?? [], term);
	const existing = await getContextTermRecord(executor, scope.key, term);
	const now = new Date().toISOString();
	const contentHash = computeContextTermContentHash(term, definition, normalizedAvoid, false);

	if (existing) {
		assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
		const revision = existing.revision + 1;
		const result = await executor.execute(sql`UPDATE context_terms SET definition = ${definition}, avoid_terms = ${JSON.stringify(normalizedAvoid)}, revision = ${revision}, content_hash = ${contentHash}, tombstone = FALSE, updated_by = ${actorId}::uuid, updated_at = ${now}
			WHERE tenant_id = ${executor.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
		if ((result.rowCount ?? 0) === 0) {
			const fresh = await getContextTermRecord(executor, scope.key, term);
			throw new ContextTermConflictError(scope.key, term, fresh!.revision, fresh!.contentHash);
		}
		await appendContextTermDeltaEntry(executor, scope.key, term, revision, existing, actorId, now);
	} else {
		const id = generateContextTermId();
		const shortReference = await allocateContextTermShortReference(executor, id);
		await executor.insert(contextTerms).values({
			tenantId: executor.tenantId,
			id,
			shortReference,
			contextKey: scope.key,
			createdBy: actorId,
			updatedBy: actorId,
			term,
			definition,
			avoidTerms: JSON.stringify(normalizedAvoid),
			revision: 1,
			contentHash,
			tombstone: false,
			createdAt: now,
			updatedAt: now
		});
		await appendContextTermDeltaEntry(executor, scope.key, term, 1, { id, reference: encodeCanonicalReference("contextTerm", id), shortReference, createdBy: actorId, updatedBy: actorId, term, definition, avoid: normalizedAvoid, revision: 1, contentHash, createdAt: now, updatedAt: now, tombstone: false }, actorId, now);
	}

	const storedTerm = await getContextTermRecord(executor, scope.key, term);
	if (!storedTerm) {
		throw new Error(`Failed to persist context term: ${term}`);
	}
	const { tombstone: _tombstone, ...publicTerm } = storedTerm;

	return {
		context: (await queryContextDetails(executor, projectIdentity, input.scopeRef)).context,
		term: publicTerm,
		created: existing === null
	};
}

async function allocateContextShortReference(executor: TenantExecutor, id: string): Promise<string> {
	return allocateShortReference(executor, contexts, "context", id);
}

async function allocateContextTermShortReference(executor: TenantExecutor, id: string): Promise<string> {
	return allocateShortReference(executor, contextTerms, "contextTerm", id);
}

async function allocateShortReference(
	executor: TenantExecutor,
	table: typeof contexts | typeof contextTerms,
	kind: "context" | "contextTerm",
	id: string
): Promise<string> {
	const baseReference = shortEntityReference({ id, kind });
	let shortReference = baseReference;
	let suffix = 2;

	while ((await executor
		.select({ id: table.id })
		.from(table)
		.where(and(eq(table.tenantId, executor.tenantId), eq(table.shortReference, shortReference)))
		.limit(1)).length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}

	return shortReference;
}

export async function forgetContextTerm(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string },
	actorId: string = SYSTEM_USER_ID
): Promise<ForgetContextTermResult> {
	const term = input.term.trim();
	if (term.length === 0) {
		throw new Error("Context term must not be empty.");
	}

	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const existing = await getContextTermRecord(executor, scope.key, term);
	if (!existing) {
		return { context: (await queryContextDetails(executor, projectIdentity, input.scopeRef)).context, term, removed: false };
	}
	assertContextTermHead(scope.key, term, existing, input.expectedRevision, input.expectedContentHash);
	if (existing.tombstone) {
		return { context: (await queryContextDetails(executor, projectIdentity, input.scopeRef)).context, term, removed: false, currentRevision: existing.revision, currentContentHash: existing.contentHash };
	}
	const revision = existing.revision + 1;
	const contentHash = computeContextTermContentHash(existing.term, existing.definition, existing.avoid, true);
	const now = new Date().toISOString();
	const result = await executor.execute(sql`UPDATE context_terms SET revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_by = ${actorId}::uuid, updated_at = ${now}
		WHERE tenant_id = ${executor.tenantId} AND context_key = ${scope.key} AND term = ${term} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash}`);
	if ((result.rowCount ?? 0) === 0) {
		const fresh = await getContextTermRecord(executor, scope.key, term);
		throw new ContextTermConflictError(scope.key, term, fresh!.revision, fresh!.contentHash);
	}
	await appendContextTermDeltaEntry(executor, scope.key, term, revision, existing, actorId, now);

	return {
		context: (await queryContextDetails(executor, projectIdentity, input.scopeRef)).context,
		term,
		removed: true,
		currentRevision: revision,
		currentContentHash: contentHash
	};
}

export async function materializeContextRevision(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; revision: number }
): Promise<MaterializedContextRevision> {
	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const head = await fetchContextRow(executor, scope.key);
	if (!head) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	const rows = await executor.select().from(revisionEntries)
		.where(and(eq(revisionEntries.tenantId, executor.tenantId), eq(revisionEntries.projectId, await resolveContextProjectId(executor, scope.key)), eq(revisionEntries.recordKind, "context"), eq(revisionEntries.recordKey, encodeContextRecordKey(head.id))))
		.orderBy(desc(revisionEntries.revision));
	return materializeContextFromPatches(
		{ key: head.key, title: head.title, summary: head.summary, revision: head.revision, createdAt: head.created_at },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.createdAt, patchFormat: row.patchFormat, reversePatch: row.reversePatch, sourceHash: decodeRevisionPatchHash(row.sourceHash), targetHash: decodeRevisionPatchHash(row.targetHash), ...(row.restoredFromRevision !== null && { restoredFromRevision: row.restoredFromRevision }) })),
		input.revision
	);
}

export async function restoreContextRevision(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = SYSTEM_USER_ID
): Promise<MaterializedContextRevision> {
	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const current = (await queryContextDetails(executor, projectIdentity, input.scopeRef)).context;
	if (!current.exists) {
		throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
	}
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new ContextConflictError(scope.key, current.revision, current.contentHash);
	}
	const source = await materializeContextRevision(executor, projectIdentity, { scopeRef: input.scopeRef, revision: input.revision });
	const revision = current.revision + 1;
	const contentHash = computeContextContentHash(source.title, source.summary);
	const updatedAt = new Date().toISOString();
	const [updated] = await executor.update(contexts).set({
		title: source.title,
		summary: source.summary,
		revision,
		contentHash,
		updatedBy: actorId,
		updatedAt
	}).where(and(eq(contexts.tenantId, executor.tenantId), eq(contexts.key, scope.key), eq(contexts.revision, input.expectedRevision), eq(contexts.contentHash, input.expectedContentHash))).returning({ key: contexts.key });
	if (!updated) {
		const fresh = await fetchContextRow(executor, scope.key);
		if (!fresh) {
			throw new ContextRevisionError(scope.key, "context-not-found", `Context not found: ${scope.key}`);
		}
		throw new ContextConflictError(scope.key, fresh.revision, fresh.content_hash);
	}
	await appendContextDeltaEntry(executor, scope.key, revision, current.title, current.summary, actorId, updatedAt, input.revision);
	return materializeContextRevision(executor, projectIdentity, { scopeRef: input.scopeRef, revision });
}

export async function materializeContextTermRevision(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; revision: number }
): Promise<MaterializedContextTermRevision> {
	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const head = await getContextTermRecord(executor, scope.key, input.term.trim());
	if (!head) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${input.term}`, undefined, input.term);
	}
	const rows = await executor.select().from(revisionEntries)
		.where(and(eq(revisionEntries.tenantId, executor.tenantId), eq(revisionEntries.projectId, await resolveContextProjectId(executor, scope.key)), eq(revisionEntries.recordKind, "context-term"), eq(revisionEntries.recordKey, encodeContextTermRecordKey(head.id))))
		.orderBy(desc(revisionEntries.revision));
	return materializeContextTermFromPatches(
		{ id: head.id, contextKey: scope.key, term: head.term, definition: head.definition, avoid: head.avoid, tombstone: head.tombstone, revision: head.revision, createdAt: head.createdAt },
		rows.map((row) => ({ revision: row.revision, author: row.author, createdAt: row.createdAt, patchFormat: row.patchFormat, reversePatch: row.reversePatch, sourceHash: decodeRevisionPatchHash(row.sourceHash), targetHash: decodeRevisionPatchHash(row.targetHash), ...(row.restoredFromRevision !== null && { restoredFromRevision: row.restoredFromRevision }) })),
		input.revision
	);
}

export async function restoreContextTermRevision(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = SYSTEM_USER_ID
): Promise<MaterializedContextTermRevision> {
	const scope = await resolveContextScope(executor, projectIdentity, input.scopeRef);
	const term = input.term.trim();
	const current = await getContextTermRecord(executor, scope.key, term);
	if (!current) {
		throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
	}
	assertContextTermHead(scope.key, term, current, input.expectedRevision, input.expectedContentHash);
	const source = await materializeContextTermRevision(executor, projectIdentity, { scopeRef: input.scopeRef, term, revision: input.revision });
	const revision = current.revision + 1;
	const contentHash = computeContextTermContentHash(source.term, source.definition, source.avoid, source.tombstone);
	const updatedAt = new Date().toISOString();
	const [updated] = await executor.update(contextTerms).set({
		definition: source.definition,
		avoidTerms: JSON.stringify(source.avoid),
		revision,
		contentHash,
		tombstone: source.tombstone,
		updatedBy: actorId,
		updatedAt
	}).where(and(eq(contextTerms.tenantId, executor.tenantId), eq(contextTerms.contextKey, scope.key), eq(contextTerms.term, term), eq(contextTerms.revision, input.expectedRevision), eq(contextTerms.contentHash, input.expectedContentHash))).returning({ term: contextTerms.term });
	if (!updated) {
		const fresh = await getContextTermRecord(executor, scope.key, term);
		if (!fresh) {
			throw new ContextRevisionError(scope.key, "term-not-found", `Context term not found: ${term}`, undefined, term);
		}
		throw new ContextTermConflictError(scope.key, term, fresh.revision, fresh.contentHash);
	}
	await appendContextTermDeltaEntry(executor, scope.key, term, revision, current, actorId, updatedAt, input.revision);
	return materializeContextTermRevision(executor, projectIdentity, { scopeRef: input.scopeRef, term, revision });
}

function assertContextTermHead(contextKey: string, term: string, existing: ContextTermHead, expectedRevision: number | undefined, expectedContentHash: string | undefined): void {
	if (existing.revision !== expectedRevision || existing.contentHash !== expectedContentHash) {
		throw new ContextTermConflictError(contextKey, term, existing.revision, existing.contentHash);
	}
}

async function appendContextTermDeltaEntry(executor: TenantExecutor, contextKey: string, term: string, revision: number, prior: ContextTermHead, author: string | undefined, createdAt: string, restoredFromRevision?: number): Promise<void> {
	const successor = await getContextTermRecord(executor, contextKey, term);
	if (!successor) {
		throw new Error(`Cannot append reverse patch for missing context term ${term}.`);
	}
	const transition = createReverseFieldPatch(
		{ term: successor.term, definition: successor.definition, avoid: successor.avoid, tombstone: successor.tombstone },
		{ term: prior.term, definition: prior.definition, avoid: prior.avoid, tombstone: prior.tombstone },
		CONTEXT_TERM_REVERSE_PATCH_REGISTRY
	);
	await executor.insert(revisionEntries).values({ id: randomUUID(), tenantId: executor.tenantId, projectId: await resolveContextProjectId(executor, contextKey), recordKind: "context-term", recordKey: encodeContextTermRecordKey(successor.id), revision, author: author?.trim() || RESERVED_SYSTEM_AUTHOR, patchFormat: transition.patchFormat, reversePatch: Buffer.from(transition.reversePatch), sourceHash: encodeRevisionPatchHash(transition.sourceHash), targetHash: encodeRevisionPatchHash(transition.targetHash), restoredFromRevision: restoredFromRevision ?? null, createdAt });
}

async function resolveContextProjectId(executor: TenantExecutor, contextKey: string): Promise<string> {
	const result = await executor.execute(sql`SELECT scope.project_id
		FROM contexts AS context
		LEFT JOIN entities AS scope ON scope.tenant_id = context.tenant_id AND scope.id = context.scope_entity_id
		WHERE context.tenant_id = ${executor.tenantId} AND context.key = ${contextKey}`);
	const projectId = (result.rows[0] as { project_id: string | null } | undefined)?.project_id;
	if (projectId) return projectId;
	if (contextKey === DEFAULT_CONTEXT_KEY) return deriveMigratedEntityIdentity("project", "PROJ0").stableId;
	if (contextKey.startsWith(`${DEFAULT_CONTEXT_KEY}:`)) {
		return (await getEntityOrThrow(executor, contextKey.slice(DEFAULT_CONTEXT_KEY.length + 1))).id;
	}
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

/**
 * The context/glossary feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin wrapper over the
 * executor-holding free functions above, constructed fresh inside one
 * `PgStore` transaction and composed alongside the other three feature
 * classes.
 */
export class PgContextStore implements ContextStore {
	public constructor(
		private readonly executor: TenantExecutor,
		private readonly projectIdentity: string | undefined
	) {}

	public async listContexts(): Promise<ContextListResult> {
		return listContexts(this.executor, this.projectIdentity);
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return getContextDetails(this.executor, this.projectIdentity, input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return getContextDirectory(this.executor, this.projectIdentity);
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult> {
		return queryContextDirectory(this.executor, this.projectIdentity, input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }, actorId?: string): ReturnType<ContextStore["upsertContext"]> {
		return toContextWriteResult(await upsertContext(this.executor, this.projectIdentity, input, actorId ?? RESERVED_SYSTEM_AUTHOR));
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }, actorId?: string): ReturnType<ContextStore["defineContextTerm"]> {
		return toDefineContextTermAcknowledgement(await defineContextTerm(this.executor, this.projectIdentity, input, actorId ?? SYSTEM_USER_ID));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }, actorId?: string): Promise<ForgetContextTermResult> {
		return forgetContextTerm(this.executor, this.projectIdentity, input, actorId ?? SYSTEM_USER_ID);
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }): Promise<MaterializedContextRevision> {
		return materializeContextRevision(this.executor, this.projectIdentity, input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }): Promise<MaterializedContextTermRevision> {
		return materializeContextTermRevision(this.executor, this.projectIdentity, input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }, actorId?: string): Promise<MaterializedContextRevision> {
		return restoreContextRevision(this.executor, this.projectIdentity, input, actorId ?? SYSTEM_USER_ID);
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }, actorId?: string): Promise<MaterializedContextTermRevision> {
		return restoreContextTermRevision(this.executor, this.projectIdentity, input, actorId ?? SYSTEM_USER_ID);
	}
}
