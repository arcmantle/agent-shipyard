import { sql } from "drizzle-orm";

import {
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	encodeIssueCommentRecordKey,
	encodeCanonicalReference,
	encodePlanEntryRecordKey,
	DEFAULT_PROJECT_ID,
	deriveMigratedEntityIdentity,
	getAllowedRelationType,
	isBodySource,
	isEntityCategory,
	isEntityKind,
	isEntityPriority,
	isEntityType,
	isPlanEntryRole,
	isPlanEntryScopeDirection,
	isStructuralRelationType,
	mergeCanonicalChainBundles,
	shortEntityReference,
	type CanonicalChainBundle,
	type CanonicalChainImportResult,
	type CanonicalContextChain,
	type CanonicalContextTermChain,
	type CanonicalEntityChain,
	type CanonicalIssueCommentChain,
	type CanonicalPlanEntryChain,
	type CompletionObservation,
	type UserDirectoryRecord,
	type SynchronizeStore
} from "@agent-issues/core";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";

type EntityHeadRow = { id: string; reference: string; short_reference: string; created_by: string; updated_by: string; kind: string; title: string; body: string; body_source: string; category: string | null; priority: string | null; type: string | null; status: string; revision: number; content_hash: string; tombstone: number; project_id: string | null; created_at: string; updated_at: string; parent_id: string | null };
type ContextHeadRow = { id: string; reference: string; short_reference: string; created_by: string; updated_by: string; key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermHeadRow = { id: string; short_reference: string; created_by: string; updated_by: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: number; revision: number; content_hash: string; created_at: string; updated_at: string };
type IssueCommentHeadRow = { id: string; reference: string; short_reference: string; issue_id: string; created_by: string; updated_by: string; body: string; tombstone: number; revision: number; content_hash: string; created_at: string; updated_at: string };
type IssueCommentReferenceRow = { comment_id: string; issue_id: string; position: number };
type PlanEntryHeadRow = { id: string; reference: string; short_reference: string; plan_id: string; created_by: string; updated_by: string; role: string; body: string; scope_direction: string | null; tombstone: number; revision: number; content_hash: string; created_at: string; updated_at: string };
type PlanEntryReferenceRow = { plan_entry_id: string; entity_id: string; position: number };
type PlanEntrySupersessionRow = { plan_entry_id: string; superseded_entry_id: string; position: number };
type CompletionObservationRow = { id: string; issue_id: string; completion_ordinal: number; repository_identity: string | null; commit_sha: string | null; branch: string | null; dirty: number | null; captured_at: string; calculated_version_state: "available" | "unknown"; calculated_version: string | null; diagnostics: string };
type UserRow = { id: string; authentication_subject: string; display_name: string | null; updated_at: string };
type LedgerRow = { id: string; project_id: string; record_kind: string; record_key: string; revision: number; author: string; patch_format: number; reverse_patch: Uint8Array; source_hash: Uint8Array; target_hash: Uint8Array; restored_from_revision: number | null; created_at: string };
type SqliteQuerySurface = Pick<SqliteExecutor["drizzle"], "all" | "run">;

function mapDelta(delta: LedgerRow) {
	return {
		id: delta.id,
		revision: delta.revision,
		author: delta.author,
		createdAt: delta.created_at,
		patchFormat: delta.patch_format,
		reversePatch: delta.reverse_patch,
		sourceHash: decodeRevisionPatchHash(delta.source_hash),
		targetHash: decodeRevisionPatchHash(delta.target_hash),
		...(delta.restored_from_revision !== null && { restoredFromRevision: delta.restored_from_revision })
	};
}

export function exportCanonicalChains(executor: SqliteExecutor): CanonicalChainBundle {
	const entityRows = executor.drizzle.all(sql`SELECT entities.*,
		(SELECT relations.from_id FROM relations WHERE relations.tenant_id = entities.tenant_id AND relations.to_id = entities.id AND relations.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
			ORDER BY relations.created_at, relations.from_id LIMIT 1) AS parent_id
		FROM entities WHERE tenant_id = ${executor.tenantId}`) as EntityHeadRow[];
	const contextRows = executor.drizzle.all(sql`SELECT * FROM contexts WHERE tenant_id = ${executor.tenantId}`) as ContextHeadRow[];
	const termRows = executor.drizzle.all(sql`SELECT * FROM context_terms WHERE tenant_id = ${executor.tenantId}`) as ContextTermHeadRow[];
	const commentRows = executor.drizzle.all(sql`SELECT * FROM issue_comments WHERE tenant_id = ${executor.tenantId}`) as IssueCommentHeadRow[];
	const commentReferenceRows = executor.drizzle.all(sql`SELECT comment_id, issue_id, position FROM issue_comment_references WHERE tenant_id = ${executor.tenantId} ORDER BY comment_id, position`) as IssueCommentReferenceRow[];
	const planEntryRows = executor.drizzle.all(sql`SELECT * FROM plan_entries WHERE tenant_id = ${executor.tenantId}`) as PlanEntryHeadRow[];
	const planEntryReferenceRows = executor.drizzle.all(sql`SELECT plan_entry_id, entity_id, position FROM plan_entry_references WHERE tenant_id = ${executor.tenantId} ORDER BY plan_entry_id, position`) as PlanEntryReferenceRow[];
	const planEntrySupersessionRows = executor.drizzle.all(sql`SELECT plan_entry_id, superseded_entry_id, position FROM plan_entry_supersessions WHERE tenant_id = ${executor.tenantId} ORDER BY plan_entry_id, position`) as PlanEntrySupersessionRow[];
	const completionObservationRows = executor.drizzle.all(sql`SELECT * FROM completion_observations WHERE tenant_id = ${executor.tenantId} ORDER BY issue_id, completion_ordinal`) as CompletionObservationRow[];
	const userRows = executor.drizzle.all(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id = ${executor.tenantId} ORDER BY id`) as UserRow[];
	const ledgerRows = executor.drizzle.all(sql`SELECT * FROM revision_entries
		WHERE tenant_id = ${executor.tenantId}
		ORDER BY project_id, record_kind, record_key, revision`) as LedgerRow[];

	return {
		entities: entityRows.map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) {
				throw new Error(`Cannot export invalid entity ${row.id}.`);
			}
			return {
				head: { id: row.id, reference: row.reference, shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, category: row.category && isEntityCategory(row.category) ? row.category : null, priority: row.priority && isEntityPriority(row.priority) ? row.priority : null, type: row.type && isEntityType(row.kind, row.type) ? row.type : null, status: row.status, parentId: row.parent_id, tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at },
				deltas: ledgerRows.filter((delta) => delta.project_id === row.project_id && delta.record_kind === "entity" && delta.record_key === encodeEntityRecordKey(row.id)).map(mapDelta)
			};
		}),
		contexts: contextRows.map((row): CanonicalContextChain => ({ head: { id: row.id, reference: row.reference, shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context" && delta.record_key === encodeContextRecordKey(row.id)).map(mapDelta) })),
		contextTerms: termRows.map((row): CanonicalContextTermChain => ({ head: { id: row.id, reference: encodeCanonicalReference("contextTerm", row.id), shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context-term" && delta.record_key === encodeContextTermRecordKey(row.id)).map(mapDelta) })),
		issueComments: commentRows.map((row): CanonicalIssueCommentChain => ({ head: { id: row.id, reference: row.reference, shortReference: row.short_reference, issueId: row.issue_id, createdBy: row.created_by, updatedBy: row.updated_by, body: row.body, referencedIssueIds: commentReferenceRows.filter((reference) => reference.comment_id === row.id).map((reference) => reference.issue_id), tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "issue-comment" && delta.record_key === encodeIssueCommentRecordKey(row.id)).map(mapDelta) })),
		planEntries: planEntryRows.map((row): CanonicalPlanEntryChain => {
			if (!isPlanEntryRole(row.role) || (row.scope_direction !== null && !isPlanEntryScopeDirection(row.scope_direction))) {
				throw new Error(`Cannot export invalid Plan entry ${row.id}.`);
			}
			return {
				head: { id: row.id, reference: row.reference, shortReference: row.short_reference, planId: row.plan_id, createdBy: row.created_by, updatedBy: row.updated_by, role: row.role, body: row.body, scopeDirection: row.scope_direction, referencedEntityIds: planEntryReferenceRows.filter((reference) => reference.plan_entry_id === row.id).map((reference) => reference.entity_id), supersededEntryIds: planEntrySupersessionRows.filter((supersession) => supersession.plan_entry_id === row.id).map((supersession) => supersession.superseded_entry_id), tombstone: Boolean(row.tombstone), revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at },
				deltas: ledgerRows.filter((delta) => delta.record_kind === "plan-entry" && delta.record_key === encodePlanEntryRecordKey(row.id)).map(mapDelta)
			};
		}),
		completionObservations: completionObservationRows.map(toCompletionObservation),
		users: userRows.map(toUserDirectoryRecord)
	};
}

export function importCanonicalChains(executor: SqliteExecutor, incoming: CanonicalChainBundle): CanonicalChainImportResult {
	return executor.drizzle.transaction((tx) => {
		const current = exportCanonicalChains(executor);
		const merged = mergeCanonicalChainBundles(current, incoming);
		const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [], issueCommentsCreated: [], issueCommentsAdvanced: [], planEntriesCreated: [], planEntriesAdvanced: [], completionObservationsCreated: [], usersCreated: [], usersUpdated: [] };
		const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.entities) {
			const existing = currentEntities.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeEntity(tx, executor, chain, existing === undefined);
			(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
		}
		rebuildStructuralParents(tx, executor, merged.entities);

		const currentContexts = new Map(current.contexts.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.contexts) {
			const existing = currentContexts.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContext(tx, executor, chain, existing === undefined);
			(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
		}
		const currentTerms = new Map(current.contextTerms.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.contextTerms) {
			const existing = currentTerms.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeContextTerm(tx, executor, chain, existing === undefined);
			(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
		}
		const currentComments = new Map(current.issueComments.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.issueComments) {
			const existing = currentComments.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writeIssueComment(tx, executor, chain, existing === undefined);
			(existing ? result.issueCommentsAdvanced : result.issueCommentsCreated).push(chain.head.id);
		}
		const currentPlanEntries = new Map(current.planEntries.map((chain) => [chain.head.id, chain]));
		for (const chain of merged.planEntries) {
			const existing = currentPlanEntries.get(chain.head.id);
			if (existing?.head.revision === chain.head.revision) continue;
			writePlanEntry(tx, executor, chain, existing === undefined);
			(existing ? result.planEntriesAdvanced : result.planEntriesCreated).push(chain.head.id);
		}
		rebuildPlanEntryLinks(tx, executor, merged.planEntries);
		const currentObservations = new Set((current.completionObservations ?? []).map((observation) => observation.id));
		const completionObservationsCreated: string[] = [];
		for (const observation of merged.completionObservations ?? []) {
			if (currentObservations.has(observation.id)) continue;
			writeCompletionObservation(tx, executor, observation);
			completionObservationsCreated.push(observation.id);
		}
		const currentUsers = new Map(current.users.map((user) => [user.id, user]));
		for (const user of merged.users) {
			const existing = currentUsers.get(user.id);
			if (existing?.displayName === user.displayName && existing.updatedAt === user.updatedAt) continue;
			writeUser(tx, executor, user, existing === undefined);
			(existing ? result.usersUpdated : result.usersCreated).push(user.id);
		}
		return { ...result, completionObservationsCreated };
	});
}

function writeEntity(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalEntityChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO entities (tenant_id, id, reference, short_reference, created_by, updated_by, kind, title, status, body, body_source, category, priority, type, revision, content_hash, tombstone, project_id, created_at, updated_at) VALUES (${executor.tenantId}, ${head.id}, ${head.reference}, ${shortEntityReference(head)}, ${head.createdBy}, ${head.updatedBy}, ${head.kind}, ${head.title}, ${head.status}, ${head.body}, ${head.bodySource}, ${head.category}, ${head.priority}, ${head.type}, ${head.revision}, ${head.contentHash}, ${head.tombstone ? 1 : 0}, ${head.kind === "project" ? head.id : executor.currentProjectId}, ${head.createdAt}, ${head.updatedAt})`);
	else query.run(sql`UPDATE entities SET updated_by=${head.updatedBy}, title=${head.title}, status=${head.status}, body=${head.body}, body_source=${head.bodySource}, category=${head.category}, priority=${head.priority}, type=${head.type}, revision=${head.revision}, content_hash=${head.contentHash}, tombstone=${head.tombstone ? 1 : 0}, updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getEntityProjectId(query, executor, head.id);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at) VALUES (${delta.id}, ${executor.tenantId}, ${projectId}, 'entity', ${encodeEntityRecordKey(head.id)}, ${delta.revision}, ${delta.author}, ${delta.patchFormat}, ${Buffer.from(delta.reversePatch)}, ${encodeRevisionPatchHash(delta.sourceHash)}, ${encodeRevisionPatchHash(delta.targetHash)}, ${delta.restoredFromRevision ?? null}, ${delta.createdAt})`);
}

function rebuildStructuralParents(query: SqliteQuerySurface, executor: SqliteExecutor, chains: CanonicalEntityChain[]): void {
	for (const chain of chains) {
		query.run(sql`DELETE FROM relations WHERE tenant_id=${executor.tenantId} AND to_id=${chain.head.id} AND type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		query.run(sql`INSERT OR IGNORE INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES (${executor.tenantId}, ${parent.id}, ${chain.head.id}, ${relationType}, ${chain.head.updatedAt})`);
		const parentProject = query.all(sql`SELECT project_id FROM entities WHERE tenant_id=${executor.tenantId} AND id=${parent.id}`)[0] as { project_id: string | null } | undefined;
		query.run(sql`UPDATE entities SET project_id=${parent.kind === "project" ? parent.id : parentProject?.project_id ?? executor.currentProjectId} WHERE tenant_id=${executor.tenantId} AND id=${chain.head.id}`);
	}
}

function writeContext(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalContextChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO contexts (tenant_id,id,reference,short_reference,key,created_by,updated_by,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${head.reference},${shortEntityReference({ id: head.id, kind: "context", shortReference: head.shortReference })},${head.key},${head.createdBy},${head.updatedBy},${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE contexts SET updated_by=${head.updatedBy},scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND key=${head.key}`);
	const projectId = getContextProjectId(query, executor, head.key, head.scopeEntityId);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context',${encodeContextRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function writeContextTerm(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalContextTermChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO context_terms (tenant_id,id,short_reference,context_key,created_by,updated_by,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${shortEntityReference({ id: head.id, kind: "contextTerm", shortReference: head.shortReference })},${head.contextKey},${head.createdBy},${head.updatedBy},${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone ? 1 : 0},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE context_terms SET updated_by=${head.updatedBy},context_key=${head.contextKey},term=${head.term},definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone ? 1 : 0},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getContextProjectId(query, executor, head.contextKey);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context-term',${encodeContextTermRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function writeIssueComment(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalIssueCommentChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO issue_comments (tenant_id,id,reference,short_reference,issue_id,created_by,updated_by,body,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${head.reference},${shortEntityReference({ id: head.id, kind: "issueComment", shortReference: head.shortReference })},${head.issueId},${head.createdBy},${head.updatedBy},${head.body},${head.revision},${head.contentHash},${head.tombstone ? 1 : 0},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE issue_comments SET updated_by=${head.updatedBy},body=${head.body},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone ? 1 : 0},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getEntityProjectId(query, executor, head.issueId);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'issue-comment',${encodeIssueCommentRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
	query.run(sql`DELETE FROM issue_comment_references WHERE tenant_id=${executor.tenantId} AND comment_id=${head.id}`);
	head.referencedIssueIds.forEach((issueId, position) => query.run(sql`INSERT INTO issue_comment_references (tenant_id,comment_id,issue_id,position) VALUES (${executor.tenantId},${head.id},${issueId},${position})`));
}

function writePlanEntry(query: SqliteQuerySurface, executor: SqliteExecutor, chain: CanonicalPlanEntryChain, created: boolean): void {
	const head = chain.head;
	if (created) query.run(sql`INSERT INTO plan_entries (tenant_id,id,reference,short_reference,plan_id,created_by,updated_by,role,body,scope_direction,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id},${head.reference},${shortEntityReference({ id: head.id, kind: "planEntry", shortReference: head.shortReference })},${head.planId},${head.createdBy},${head.updatedBy},${head.role},${head.body},${head.scopeDirection},${head.revision},${head.contentHash},${head.tombstone ? 1 : 0},${head.createdAt},${head.updatedAt})`);
	else query.run(sql`UPDATE plan_entries SET updated_by=${head.updatedBy},role=${head.role},body=${head.body},scope_direction=${head.scopeDirection},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone ? 1 : 0},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	const projectId = getEntityProjectId(query, executor, head.planId);
	for (const delta of chain.deltas) query.run(sql`INSERT OR IGNORE INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'plan-entry',${encodePlanEntryRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt})`);
}

function writeCompletionObservation(query: SqliteQuerySurface, executor: SqliteExecutor, observation: CompletionObservation): void {
	query.run(sql`INSERT OR IGNORE INTO completion_observations (tenant_id, id, issue_id, completion_ordinal, repository_identity, commit_sha, branch, dirty, captured_at, calculated_version_state, calculated_version, diagnostics) VALUES (${executor.tenantId}, ${observation.id}, ${observation.issueId}, ${observation.completionOrdinal}, ${observation.repositoryIdentity}, ${observation.commitSha}, ${observation.branch}, ${observation.dirty === null ? null : Number(observation.dirty)}, ${observation.capturedAt}, ${observation.calculatedVersionState}, ${observation.calculatedVersion}, ${JSON.stringify(observation.diagnostics)})`);
}

function rebuildPlanEntryLinks(query: SqliteQuerySurface, executor: SqliteExecutor, chains: CanonicalPlanEntryChain[]): void {
	for (const chain of chains) {
		query.run(sql`DELETE FROM plan_entry_references WHERE tenant_id=${executor.tenantId} AND plan_entry_id=${chain.head.id}`);
		chain.head.referencedEntityIds.forEach((entityId, position) => query.run(sql`INSERT INTO plan_entry_references (tenant_id,plan_entry_id,entity_id,position) VALUES (${executor.tenantId},${chain.head.id},${entityId},${position})`));
		query.run(sql`DELETE FROM plan_entry_supersessions WHERE tenant_id=${executor.tenantId} AND plan_entry_id=${chain.head.id}`);
		chain.head.supersededEntryIds.forEach((entryId, position) => query.run(sql`INSERT INTO plan_entry_supersessions (tenant_id,plan_entry_id,superseded_entry_id,position) VALUES (${executor.tenantId},${chain.head.id},${entryId},${position})`));
	}
}

function writeUser(query: SqliteQuerySurface, executor: SqliteExecutor, user: UserDirectoryRecord, created: boolean): void {
	if (created) query.run(sql`INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at) VALUES (${executor.tenantId}, ${user.id}, ${user.authenticationSubject}, ${user.displayName}, ${user.updatedAt}, ${user.updatedAt})`);
	else query.run(sql`UPDATE users SET display_name=${user.displayName}, updated_at=${user.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${user.id}`);
}

function toUserDirectoryRecord(row: UserRow): UserDirectoryRecord {
	return {
		id: row.id,
		authenticationSubject: row.authentication_subject,
		displayName: row.display_name,
		updatedAt: row.updated_at
	};
}

function toCompletionObservation(row: CompletionObservationRow): CompletionObservation {
	return {
		id: row.id,
		issueId: row.issue_id,
		completionOrdinal: row.completion_ordinal,
		repositoryIdentity: row.repository_identity,
		commitSha: row.commit_sha,
		branch: row.branch,
		dirty: row.dirty === null ? null : row.dirty !== 0,
		capturedAt: row.captured_at,
		calculatedVersionState: row.calculated_version_state,
		calculatedVersion: row.calculated_version,
		diagnostics: JSON.parse(row.diagnostics) as Array<{ code: string; message: string }>
	};
}

function getEntityProjectId(query: SqliteQuerySurface, executor: SqliteExecutor, entityId: string): string {
	const row = query.all(sql`SELECT project_id FROM entities WHERE tenant_id = ${executor.tenantId} AND id = ${entityId}`)[0] as { project_id: string | null } | undefined;
	if (!row?.project_id) throw new Error(`Cannot resolve project for entity ${entityId}.`);
	return row.project_id;
}

function getContextProjectId(query: SqliteQuerySurface, executor: SqliteExecutor, contextKey: string, scopeEntityId?: string | null): string {
	if (scopeEntityId) return getEntityProjectId(query, executor, scopeEntityId);
	if (contextKey === "default") return executor.currentProjectId;
	if (contextKey.startsWith("default:")) {
		const projectReference = contextKey.slice("default:".length);
		if (projectReference === DEFAULT_PROJECT_ID) {
			return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		}
		return projectReference;
	}
	const row = query.all(sql`SELECT scope_entity_id FROM contexts WHERE tenant_id = ${executor.tenantId} AND key = ${contextKey}`)[0] as { scope_entity_id: string | null } | undefined;
	if (row?.scope_entity_id) return getEntityProjectId(query, executor, row.scope_entity_id);
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

/**
 * The synchronize feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin, promise-returning
 * wrapper the executor-holding local free functions above, which
 * `SqliteStore` composes alongside the other three feature classes.
 */
export class LocalSynchronizeStore implements SynchronizeStore {
	public constructor(private readonly executor: SqliteExecutor) {}

	public async exportCanonicalChains(): Promise<CanonicalChainBundle> {
		return exportCanonicalChains(this.executor);
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
		return importCanonicalChains(this.executor, bundle);
	}
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}