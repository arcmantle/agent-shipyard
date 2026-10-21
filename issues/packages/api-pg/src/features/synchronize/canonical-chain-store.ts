import { sql } from "drizzle-orm";

import {
	DEFAULT_PROJECT_ID,
	CompletionObservationConflictError,
	deriveMigratedEntityIdentity,
	encodeCanonicalReference,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	encodeIssueCommentRecordKey,
	encodePlanEntryRecordKey,
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

import type { TenantExecutor } from "../../db/connection.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";

type EntityHeadRow = { id: string; reference: string; short_reference: string; created_by: string; updated_by: string; kind: string; title: string; body: string; body_source: string; category: string | null; priority: string | null; type: string | null; status: string; revision: number; content_hash: string; tombstone: boolean; project_id: string | null; created_at: string; updated_at: string; parent_id: string | null };
type ContextHeadRow = { id: string; reference: string; short_reference: string; created_by: string; updated_by: string; key: string; scope_entity_id: string | null; title: string; summary: string; revision: number; content_hash: string; created_at: string; updated_at: string };
type ContextTermHeadRow = { id: string; short_reference: string; created_by: string; updated_by: string; context_key: string; term: string; definition: string; avoid_terms: string; tombstone: boolean; revision: number; content_hash: string; created_at: string; updated_at: string };
type IssueCommentHeadRow = { id: string; reference: string; short_reference: string; issue_id: string; created_by: string; updated_by: string; body: string; tombstone: boolean; revision: number; content_hash: string; created_at: string; updated_at: string };
type IssueCommentReferenceRow = { comment_id: string; issue_id: string; position: number };
type PlanEntryHeadRow = { id: string; reference: string; short_reference: string; plan_id: string; created_by: string; updated_by: string; role: string; body: string; scope_direction: string | null; tombstone: boolean; revision: number; content_hash: string; created_at: string; updated_at: string };
type PlanEntryReferenceRow = { plan_entry_id: string; entity_id: string; position: number };
type PlanEntrySupersessionRow = { plan_entry_id: string; superseded_entry_id: string; position: number };
type CompletionObservationRow = { id: string; issue_id: string; completion_ordinal: number; repository_identity: string | null; commit_sha: string | null; branch: string | null; dirty: boolean | null; captured_at: string; calculated_version_state: "available" | "unknown"; calculated_version: string | null; diagnostics: string };
type UserRow = { id: string; authentication_subject: string; display_name: string | null; updated_at: string };
type LedgerRow = { id: string; project_id: string; record_kind: string; record_key: string; revision: number; author: string; patch_format: number; reverse_patch: Buffer; source_hash: Buffer; target_hash: Buffer; restored_from_revision: number | null; created_at: string };

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

export async function exportCanonicalChains(executor: TenantExecutor): Promise<CanonicalChainBundle> {
	const entitiesResult = await executor.execute(sql`SELECT entities.*, (SELECT relations.from_id FROM relations WHERE relations.tenant_id=entities.tenant_id AND relations.to_id=entities.id AND relations.type IN ('contains','owns','records','tracks','creates','decomposes') ORDER BY relations.created_at, relations.from_id LIMIT 1) AS parent_id FROM entities WHERE tenant_id=${executor.tenantId}`);
	const contextsResult = await executor.execute(sql`SELECT * FROM contexts WHERE tenant_id=${executor.tenantId}`);
	const termsResult = await executor.execute(sql`SELECT * FROM context_terms WHERE tenant_id=${executor.tenantId}`);
	const commentsResult = await executor.execute(sql`SELECT * FROM issue_comments WHERE tenant_id=${executor.tenantId}`);
	const commentReferencesResult = await executor.execute(sql`SELECT comment_id, issue_id, position FROM issue_comment_references WHERE tenant_id=${executor.tenantId} ORDER BY comment_id, position`);
	const planEntriesResult = await executor.execute(sql`SELECT * FROM plan_entries WHERE tenant_id=${executor.tenantId}`);
	const planEntryReferencesResult = await executor.execute(sql`SELECT plan_entry_id, entity_id, position FROM plan_entry_references WHERE tenant_id=${executor.tenantId} ORDER BY plan_entry_id, position`);
	const planEntrySupersessionsResult = await executor.execute(sql`SELECT plan_entry_id, superseded_entry_id, position FROM plan_entry_supersessions WHERE tenant_id=${executor.tenantId} ORDER BY plan_entry_id, position`);
	const usersResult = await executor.execute(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id=${executor.tenantId} ORDER BY id`);
	const ledgerResult = await executor.execute(sql`SELECT * FROM revision_entries WHERE tenant_id=${executor.tenantId} ORDER BY project_id,record_kind,record_key,revision`);
	const ledgerRows = ledgerResult.rows as LedgerRow[];
	const commentReferenceRows = commentReferencesResult.rows as IssueCommentReferenceRow[];
	const planEntryReferenceRows = planEntryReferencesResult.rows as PlanEntryReferenceRow[];
	const planEntrySupersessionRows = planEntrySupersessionsResult.rows as PlanEntrySupersessionRow[];
	const completionObservationsResult = await executor.execute(sql`SELECT * FROM completion_observations WHERE tenant_id=${executor.tenantId} ORDER BY issue_id, completion_ordinal`);
	return {
		entities: (entitiesResult.rows as EntityHeadRow[]).map((row): CanonicalEntityChain => {
			if (!isEntityKind(row.kind) || !isBodySource(row.body_source)) throw new Error(`Cannot export invalid entity ${row.id}.`);
			return { head: { id: row.id, reference: row.reference, shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, kind: row.kind, title: row.title, body: row.body, bodySource: row.body_source, category: row.category && isEntityCategory(row.category) ? row.category : null, priority: row.priority && isEntityPriority(row.priority) ? row.priority : null, type: row.type && isEntityType(row.kind, row.type) ? row.type : null, status: row.status, parentId: row.parent_id, tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.project_id === row.project_id && delta.record_kind === "entity" && delta.record_key === encodeEntityRecordKey(row.id)).map(mapDelta) };
		}),
		contexts: (contextsResult.rows as ContextHeadRow[]).map((row): CanonicalContextChain => ({ head: { id: row.id, reference: row.reference, shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, key: row.key, scopeEntityId: row.scope_entity_id, title: row.title, summary: row.summary, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context" && delta.record_key === encodeContextRecordKey(row.id)).map(mapDelta) })),
		contextTerms: (termsResult.rows as ContextTermHeadRow[]).map((row): CanonicalContextTermChain => ({ head: { id: row.id, reference: encodeCanonicalReference("contextTerm", row.id), shortReference: row.short_reference, createdBy: row.created_by, updatedBy: row.updated_by, contextKey: row.context_key, term: row.term, definition: row.definition, avoid: parseStringArray(row.avoid_terms), tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "context-term" && delta.record_key === encodeContextTermRecordKey(row.id)).map(mapDelta) })),
		issueComments: (commentsResult.rows as IssueCommentHeadRow[]).map((row): CanonicalIssueCommentChain => ({ head: { id: row.id, reference: row.reference, shortReference: row.short_reference, issueId: row.issue_id, createdBy: row.created_by, updatedBy: row.updated_by, body: row.body, referencedIssueIds: commentReferenceRows.filter((commentReference) => commentReference.comment_id === row.id).map((commentReference) => commentReference.issue_id), tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at }, deltas: ledgerRows.filter((delta) => delta.record_kind === "issue-comment" && delta.record_key === encodeIssueCommentRecordKey(row.id)).map(mapDelta) })),
		planEntries: (planEntriesResult.rows as PlanEntryHeadRow[]).map((row): CanonicalPlanEntryChain => {
			if (!isPlanEntryRole(row.role) || (row.scope_direction !== null && !isPlanEntryScopeDirection(row.scope_direction))) {
				throw new Error(`Cannot export invalid Plan entry ${row.id}.`);
			}
			return {
				head: { id: row.id, reference: row.reference, shortReference: row.short_reference, planId: row.plan_id, createdBy: row.created_by, updatedBy: row.updated_by, role: row.role, body: row.body, scopeDirection: row.scope_direction, referencedEntityIds: planEntryReferenceRows.filter((reference) => reference.plan_entry_id === row.id).map((reference) => reference.entity_id), supersededEntryIds: planEntrySupersessionRows.filter((supersession) => supersession.plan_entry_id === row.id).map((supersession) => supersession.superseded_entry_id), tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at },
				deltas: ledgerRows.filter((delta) => delta.record_kind === "plan-entry" && delta.record_key === encodePlanEntryRecordKey(row.id)).map(mapDelta)
			};
		}),
		completionObservations: (completionObservationsResult.rows as CompletionObservationRow[]).map(toCompletionObservation),
		users: (usersResult.rows as UserRow[]).map(toUserDirectoryRecord)
	};
}

export async function importCanonicalChains(executor: TenantExecutor, incoming: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
	const current = await exportCanonicalChains(executor);
	const merged = mergeCanonicalChainBundles(current, incoming);
	const result: CanonicalChainImportResult = { entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [], issueCommentsCreated: [], issueCommentsAdvanced: [], planEntriesCreated: [], planEntriesAdvanced: [], completionObservationsCreated: [], usersCreated: [], usersUpdated: [] };
	const currentEntities = new Map(current.entities.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.entities) {
		const existing = currentEntities.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeEntity(executor, chain, existing === undefined, resolveCanonicalProjectId(chain, merged.entities));
		(existing ? result.entitiesAdvanced : result.entitiesCreated).push(chain.head.id);
	}
	await rebuildStructuralParents(executor, merged.entities);
	const currentContexts = new Map(current.contexts.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.contexts) {
		const existing = currentContexts.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeContext(executor, chain, existing === undefined);
		(existing ? result.contextsAdvanced : result.contextsCreated).push(chain.head.key);
	}
	const currentTerms = new Map(current.contextTerms.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.contextTerms) {
		const existing = currentTerms.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeTerm(executor, chain, existing === undefined);
		(existing ? result.contextTermsAdvanced : result.contextTermsCreated).push(`${chain.head.contextKey}:${chain.head.term}`);
	}
	const currentComments = new Map(current.issueComments.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.issueComments) {
		const existing = currentComments.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writeIssueComment(executor, chain, existing === undefined);
		(existing ? result.issueCommentsAdvanced : result.issueCommentsCreated).push(chain.head.id);
	}
	const currentPlanEntries = new Map(current.planEntries.map((chain) => [chain.head.id, chain]));
	for (const chain of merged.planEntries) {
		const existing = currentPlanEntries.get(chain.head.id);
		if (existing?.head.revision === chain.head.revision) continue;
		await writePlanEntry(executor, chain, existing === undefined);
		(existing ? result.planEntriesAdvanced : result.planEntriesCreated).push(chain.head.id);
	}
	await rebuildPlanEntryLinks(executor, merged.planEntries);
	const currentObservations = new Set((current.completionObservations ?? []).map((observation) => observation.id));
	const completionObservationsCreated: string[] = [];
	for (const observation of merged.completionObservations ?? []) {
		if (currentObservations.has(observation.id)) continue;
		if (await writeCompletionObservation(executor, observation)) {
			completionObservationsCreated.push(observation.id);
		}
	}
	const currentUsers = new Map(current.users.map((user) => [user.id, user]));
	for (const user of merged.users) {
		const existing = currentUsers.get(user.id);
		if (existing?.displayName === user.displayName && existing.updatedAt === user.updatedAt) continue;
		await writeUser(executor, user, existing === undefined);
		(existing ? result.usersUpdated : result.usersCreated).push(user.id);
	}
	return { ...result, completionObservationsCreated };
}

async function writeEntity(executor: TenantExecutor, chain: CanonicalEntityChain, created: boolean, projectId: string): Promise<void> {
	const head = chain.head;
	if (created) await executor.execute(sql`INSERT INTO entities (tenant_id,id,reference,short_reference,created_by,updated_by,kind,title,status,body,body_source,category,priority,type,revision,content_hash,tombstone,project_id,created_at,updated_at) VALUES (${executor.tenantId},${head.id}::uuid,${head.reference},${shortEntityReference(head)},${head.createdBy}::uuid,${head.updatedBy}::uuid,${head.kind},${head.title},${head.status},${head.body},${head.bodySource},${head.category},${head.priority},${head.type},${head.revision},${head.contentHash},${head.tombstone},${projectId},${head.createdAt},${head.updatedAt})`);
	else await executor.execute(sql`UPDATE entities SET updated_by=${head.updatedBy}::uuid,title=${head.title},status=${head.status},body=${head.body},body_source=${head.bodySource},category=${head.category},priority=${head.priority},type=${head.type},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},project_id=${projectId},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}`);
	for (const delta of chain.deltas) await executor.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'entity',${encodeEntityRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

function resolveCanonicalProjectId(chain: CanonicalEntityChain, chains: CanonicalEntityChain[]): string {
	let current = chain;
	const visited = new Set<string>();
	while (current.head.kind !== "project") {
		if (!current.head.parentId) {
			const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
			const defaultProject = chains.find((candidate) => candidate.head.id === defaultProjectId);
			if (!defaultProject) throw new Error(`Missing canonical default project ${DEFAULT_PROJECT_ID}.`);
			return defaultProject.head.id;
		}
		if (visited.has(current.head.id)) {
			throw new Error(`Cannot resolve canonical project for entity ${chain.head.id}.`);
		}
		visited.add(current.head.id);
		const parent = chains.find((candidate) => candidate.head.id === current.head.parentId);
		if (!parent) throw new Error(`Missing canonical parent ${current.head.parentId} for ${current.head.id}.`);
		current = parent;
	}
	return current.head.id;
}

async function rebuildStructuralParents(executor: TenantExecutor, chains: CanonicalEntityChain[]): Promise<void> {
	for (const chain of chains) {
		await executor.execute(sql`DELETE FROM relations WHERE tenant_id=${executor.tenantId} AND to_id=${chain.head.id} AND type IN ('contains','owns','records','tracks','creates','decomposes')`);
		if (!chain.head.parentId || chain.head.tombstone) continue;
		const parent = chains.find((candidate) => candidate.head.id === chain.head.parentId)?.head;
		if (!parent) throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		const relationType = getAllowedRelationType(parent.kind, chain.head.kind);
		if (!relationType || !isStructuralRelationType(relationType)) throw new Error(`Invalid canonical parent ${parent.id} for ${chain.head.id}.`);
		await executor.execute(sql`INSERT INTO relations (tenant_id,from_id,to_id,type,created_at) VALUES (${executor.tenantId},${parent.id},${chain.head.id},${relationType},${chain.head.updatedAt}) ON CONFLICT DO NOTHING`);
		await executor.execute(sql`UPDATE entities SET project_id=CASE WHEN ${parent.kind}='project' THEN ${parent.id} ELSE (SELECT project_id FROM entities WHERE tenant_id=${executor.tenantId} AND id=${parent.id}) END WHERE tenant_id=${executor.tenantId} AND id=${chain.head.id}`);
	}
}

async function writeContext(executor: TenantExecutor, chain: CanonicalContextChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await executor.execute(sql`INSERT INTO contexts (tenant_id,id,reference,short_reference,key,created_by,updated_by,scope_entity_id,title,summary,revision,content_hash,created_at,updated_at) VALUES (${executor.tenantId},${head.id}::uuid,${head.reference},${shortEntityReference({ id: head.id, kind: "context", shortReference: head.shortReference })},${head.key},${head.createdBy}::uuid,${head.updatedBy}::uuid,${head.scopeEntityId},${head.title},${head.summary},${head.revision},${head.contentHash},${head.createdAt},${head.updatedAt})`);
	else await executor.execute(sql`UPDATE contexts SET updated_by=${head.updatedBy}::uuid,scope_entity_id=${head.scopeEntityId},title=${head.title},summary=${head.summary},revision=${head.revision},content_hash=${head.contentHash},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND key=${head.key}`);
	const projectId = await getContextProjectId(executor, head.key, head.scopeEntityId);
	for (const delta of chain.deltas) await executor.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context',${encodeContextRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

async function writeTerm(executor: TenantExecutor, chain: CanonicalContextTermChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await executor.execute(sql`INSERT INTO context_terms (tenant_id,id,short_reference,context_key,created_by,updated_by,term,definition,avoid_terms,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id}::uuid,${shortEntityReference({ id: head.id, kind: "contextTerm", shortReference: head.shortReference })},${head.contextKey},${head.createdBy}::uuid,${head.updatedBy}::uuid,${head.term},${head.definition},${JSON.stringify(head.avoid)},${head.revision},${head.contentHash},${head.tombstone},${head.createdAt},${head.updatedAt})`);
	else await executor.execute(sql`UPDATE context_terms SET updated_by=${head.updatedBy}::uuid,context_key=${head.contextKey},term=${head.term},definition=${head.definition},avoid_terms=${JSON.stringify(head.avoid)},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}::uuid`);
	const projectId = await getContextProjectId(executor, head.contextKey);
	for (const delta of chain.deltas) await executor.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'context-term',${encodeContextTermRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

async function writeIssueComment(executor: TenantExecutor, chain: CanonicalIssueCommentChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await executor.execute(sql`INSERT INTO issue_comments (tenant_id,id,reference,short_reference,issue_id,created_by,updated_by,body,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id}::uuid,${head.reference},${shortEntityReference({ id: head.id, kind: "issueComment", shortReference: head.shortReference })},${head.issueId}::uuid,${head.createdBy}::uuid,${head.updatedBy}::uuid,${head.body},${head.revision},${head.contentHash},${head.tombstone},${head.createdAt},${head.updatedAt})`);
	else await executor.execute(sql`UPDATE issue_comments SET updated_by=${head.updatedBy}::uuid,body=${head.body},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}::uuid`);
	const projectId = await getEntityProjectId(executor, head.issueId);
	for (const delta of chain.deltas) await executor.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'issue-comment',${encodeIssueCommentRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
	await executor.execute(sql`DELETE FROM issue_comment_references WHERE tenant_id=${executor.tenantId} AND comment_id=${head.id}::uuid`);
	for (const [position, issueId] of head.referencedIssueIds.entries()) {
		await executor.execute(sql`INSERT INTO issue_comment_references (tenant_id,comment_id,issue_id,position) VALUES (${executor.tenantId},${head.id}::uuid,${issueId}::uuid,${position})`);
	}
}

async function writePlanEntry(executor: TenantExecutor, chain: CanonicalPlanEntryChain, created: boolean): Promise<void> {
	const head = chain.head;
	if (created) await executor.execute(sql`INSERT INTO plan_entries (tenant_id,id,reference,short_reference,plan_id,created_by,updated_by,role,body,scope_direction,revision,content_hash,tombstone,created_at,updated_at) VALUES (${executor.tenantId},${head.id}::uuid,${head.reference},${shortEntityReference({ id: head.id, kind: "planEntry", shortReference: head.shortReference })},${head.planId}::uuid,${head.createdBy}::uuid,${head.updatedBy}::uuid,${head.role},${head.body},${head.scopeDirection},${head.revision},${head.contentHash},${head.tombstone},${head.createdAt},${head.updatedAt})`);
	else await executor.execute(sql`UPDATE plan_entries SET updated_by=${head.updatedBy}::uuid,role=${head.role},body=${head.body},scope_direction=${head.scopeDirection},revision=${head.revision},content_hash=${head.contentHash},tombstone=${head.tombstone},updated_at=${head.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${head.id}::uuid`);
	const projectId = await getEntityProjectId(executor, head.planId);
	for (const delta of chain.deltas) await executor.execute(sql`INSERT INTO revision_entries (id,tenant_id,project_id,record_kind,record_key,revision,author,patch_format,reverse_patch,source_hash,target_hash,restored_from_revision,created_at) VALUES (${delta.id},${executor.tenantId},${projectId},'plan-entry',${encodePlanEntryRecordKey(head.id)},${delta.revision},${delta.author},${delta.patchFormat},${Buffer.from(delta.reversePatch)},${encodeRevisionPatchHash(delta.sourceHash)},${encodeRevisionPatchHash(delta.targetHash)},${delta.restoredFromRevision ?? null},${delta.createdAt}) ON CONFLICT (tenant_id,project_id,record_kind,record_key,revision) DO NOTHING`);
}

async function writeCompletionObservation(executor: TenantExecutor, observation: CompletionObservation): Promise<boolean> {
	const insert = await executor.execute(sql`INSERT INTO completion_observations (tenant_id, id, issue_id, completion_ordinal, repository_identity, commit_sha, branch, dirty, captured_at, calculated_version_state, calculated_version, diagnostics) VALUES (${executor.tenantId}, ${observation.id}::uuid, ${observation.issueId}::uuid, ${observation.completionOrdinal}, ${observation.repositoryIdentity}, ${observation.commitSha}, ${observation.branch}, ${observation.dirty}, ${observation.capturedAt}, ${observation.calculatedVersionState}, ${observation.calculatedVersion}, ${JSON.stringify(observation.diagnostics)}) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`);
	if ((insert.rowCount ?? 0) > 0) return true;

	const existing = await readCompletionObservation(executor, observation.id);
	if (existing === undefined || !completionObservationsMatch(existing, observation)) {
		throw new CompletionObservationConflictError(observation.id);
	}
	return false;
}

async function readCompletionObservation(executor: TenantExecutor, observationId: string): Promise<CompletionObservation | undefined> {
	const result = await executor.execute(sql`SELECT * FROM completion_observations WHERE tenant_id = ${executor.tenantId} AND id = ${observationId}::uuid`);
	const row = result.rows[0] as CompletionObservationRow | undefined;
	return row === undefined ? undefined : toCompletionObservation(row);
}

function completionObservationsMatch(left: CompletionObservation, right: CompletionObservation): boolean {
	return left.issueId === right.issueId &&
		left.completionOrdinal === right.completionOrdinal &&
		left.repositoryIdentity === right.repositoryIdentity &&
		left.commitSha === right.commitSha &&
		left.branch === right.branch &&
		left.dirty === right.dirty &&
		left.capturedAt === right.capturedAt &&
		left.calculatedVersionState === right.calculatedVersionState &&
		left.calculatedVersion === right.calculatedVersion &&
		JSON.stringify(left.diagnostics) === JSON.stringify(right.diagnostics);
}

async function rebuildPlanEntryLinks(executor: TenantExecutor, chains: CanonicalPlanEntryChain[]): Promise<void> {
	for (const chain of chains) {
		await executor.execute(sql`DELETE FROM plan_entry_references WHERE tenant_id=${executor.tenantId} AND plan_entry_id=${chain.head.id}::uuid`);
		for (const [position, entityId] of chain.head.referencedEntityIds.entries()) {
			await executor.execute(sql`INSERT INTO plan_entry_references (tenant_id,plan_entry_id,entity_id,position) VALUES (${executor.tenantId},${chain.head.id}::uuid,${entityId}::uuid,${position})`);
		}
		await executor.execute(sql`DELETE FROM plan_entry_supersessions WHERE tenant_id=${executor.tenantId} AND plan_entry_id=${chain.head.id}::uuid`);
		for (const [position, entryId] of chain.head.supersededEntryIds.entries()) {
			await executor.execute(sql`INSERT INTO plan_entry_supersessions (tenant_id,plan_entry_id,superseded_entry_id,position) VALUES (${executor.tenantId},${chain.head.id}::uuid,${entryId}::uuid,${position})`);
		}
	}
}

async function writeUser(executor: TenantExecutor, user: UserDirectoryRecord, created: boolean): Promise<void> {
	if (created) await executor.execute(sql`INSERT INTO users (tenant_id, id, authentication_subject, display_name, created_at, updated_at) VALUES (${executor.tenantId}, ${user.id}::uuid, ${user.authenticationSubject}, ${user.displayName}, ${user.updatedAt}, ${user.updatedAt})`);
	else await executor.execute(sql`UPDATE users SET display_name=${user.displayName}, updated_at=${user.updatedAt} WHERE tenant_id=${executor.tenantId} AND id=${user.id}::uuid`);
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
		dirty: row.dirty,
		capturedAt: row.captured_at,
		calculatedVersionState: row.calculated_version_state,
		calculatedVersion: row.calculated_version,
		diagnostics: JSON.parse(row.diagnostics) as Array<{ code: string; message: string }>
	};
}

async function getEntityProjectId(executor: TenantExecutor, entityId: string): Promise<string> {
	const result = await executor.execute(sql`SELECT project_id FROM entities WHERE tenant_id=${executor.tenantId} AND id=${entityId}`);
	const projectId = (result.rows[0] as { project_id: string | null } | undefined)?.project_id;
	if (!projectId) throw new Error(`Cannot resolve project for entity ${entityId}.`);
	return projectId;
}

async function getContextProjectId(executor: TenantExecutor, contextKey: string, scopeEntityId?: string | null): Promise<string> {
	if (scopeEntityId) return getEntityProjectId(executor, scopeEntityId);
	if (contextKey === "default") return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	if (contextKey.startsWith("default:")) {
		const projectId = contextKey.slice("default:".length);
		return projectId === DEFAULT_PROJECT_ID ? deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId : projectId;
	}
	const result = await executor.execute(sql`SELECT scope_entity_id FROM contexts WHERE tenant_id=${executor.tenantId} AND key=${contextKey}`);
	const storedScope = (result.rows[0] as { scope_entity_id: string | null } | undefined)?.scope_entity_id;
	if (storedScope) return getEntityProjectId(executor, storedScope);
	throw new Error(`Cannot resolve project for context ${contextKey}.`);
}

function parseStringArray(value: string): string[] {
	try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}

/**
 * The synchronize feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin wrapper over the
 * executor-holding free functions above, constructed fresh inside one
 * `PgStore` transaction and composed alongside the other three feature
 * classes.
 */
export class PgSynchronizeStore implements SynchronizeStore {
	public constructor(private readonly executor: TenantExecutor) {}

	public async exportCanonicalChains(): Promise<CanonicalChainBundle> {
		return exportCanonicalChains(this.executor);
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
		return importCanonicalChains(this.executor, bundle);
	}
}