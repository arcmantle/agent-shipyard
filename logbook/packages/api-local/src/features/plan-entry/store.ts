import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
	computePlanEntryContentHash,
	createReverseFieldPatch,
	encodeCanonicalReference,
	encodePlanEntryRecordKey,
	isPlanEntryRole,
	isPlanEntryScopeDirection,
	materializePlanEntryFromPatches,
	PLAN_ENTRY_REVERSE_PATCH_REGISTRY,
	PlanEntryConflictError,
	type PlanEntryPage,
	shortEntityReference,
	toPlanEntrySummary,
	type LinkResult,
	type PlanEntryHistoryEntry,
	type PlanEntryRecord,
	type PlanEntrySummary,
	type PlanEntryRevisionPatch,
	type PlanEntryState,
	type PlanEntryScopeDirection,
	type UnlinkResult
} from "@agent-issues/core";
import { getSqliteEntityOrThrow, type SqliteExecutor } from "../../db/sqlite-executor.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { updateEntityStatus } from "../entity-store/store.js";

type PlanEntryRow = {
	id: string;
	reference: string;
	short_reference: string;
	plan_id: string;
	created_by: string;
	updated_by: string;
	role: string;
	body: string;
	scope_direction: PlanEntryScopeDirection | null;
	tombstone: number;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
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

type PlanEntryCursor = Pick<PlanEntryRecord, "createdAt" | "reference">;

const DEFAULT_PAGE_SIZE = 50;

export function createPlanEntry(
	executor: SqliteExecutor,
	input: { planId: string; role: string; body: string; scopeDirection?: PlanEntryScopeDirection; referencedEntityIds?: string[]; supersededEntryIds?: string[] },
	actorId: string
): PlanEntryRecord {
	const plan = getSqliteEntityOrThrow(executor, input.planId);
	if (plan.kind !== "plan" || plan.projectId !== executor.currentProjectId) {
		throw new Error(`Plan not found: ${input.planId}`);
	}
	if (!isPlanEntryRole(input.role)) {
		throw new Error(`Invalid Plan entry role: ${input.role}`);
	}
	if (input.body.trim().length === 0) {
		throw new Error("Plan entry body must not be empty.");
	}
	if (input.role === "scope" && input.scopeDirection === undefined) {
		throw new Error("Scope Plan entries require a scope direction.");
	}
	if (input.scopeDirection !== undefined && !isPlanEntryScopeDirection(input.scopeDirection)) {
		throw new Error(`Invalid Plan entry scope direction: ${input.scopeDirection}`);
	}
	if (input.role !== "scope" && input.scopeDirection !== undefined) {
		throw new Error("Only scope Plan entries can have a scope direction.");
	}

	const hasExistingEntries = executor.drizzle.get(sql`SELECT 1 FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id} LIMIT 1`) !== undefined;
	const id = randomUUID();
	const reference = encodeCanonicalReference("planEntry", id);
	const shortReference = allocateShortReference(executor, id);
	const createdAt = nextPlanEntryCreatedAt(executor, plan.id);
	const referencedEntityIds = validateReferencedEntityIds(executor, input.referencedEntityIds ?? []);
	const supersededEntryIds = validateSupersededEntryIds(executor, plan.id, input.role, input.supersededEntryIds ?? []);
	const scopeDirection = input.scopeDirection ?? null;
	const state: PlanEntryState = {
		role: input.role,
		body: input.body,
		scopeDirection,
		referencedEntityIds,
		supersededEntryIds,
		tombstone: false
	};
	const contentHash = computePlanEntryContentHash(state);
	executor.drizzle.run(sql`INSERT INTO plan_entries (tenant_id, id, reference, short_reference, plan_id, created_by, updated_by, role, body, scope_direction, revision, content_hash, tombstone, created_at, updated_at)
		VALUES (${executor.tenantId}, ${id}, ${reference}, ${shortReference}, ${plan.id}, ${actorId}, ${actorId}, ${input.role}, ${input.body}, ${scopeDirection}, 1, ${contentHash}, 0, ${createdAt}, ${createdAt})`);
	for (const [position, entityId] of referencedEntityIds.entries()) {
		executor.drizzle.run(sql`INSERT INTO plan_entry_references (tenant_id, plan_entry_id, entity_id, position) VALUES (${executor.tenantId}, ${id}, ${entityId}, ${position})`);
	}
	for (const [position, supersededEntryId] of supersededEntryIds.entries()) {
		executor.drizzle.run(sql`INSERT INTO plan_entry_supersessions (tenant_id, plan_entry_id, superseded_entry_id, position) VALUES (${executor.tenantId}, ${id}, ${supersededEntryId}, ${position})`);
	}
	appendPlanEntryDelta(executor, id, 1, state, state, actorId, createdAt);
	if (plan.status === "draft" && !hasExistingEntries) {
		updateEntityStatus(executor, { entityId: plan.id, status: "in-progress" }, actorId);
	} else if (plan.status === "ready") {
		reopenReadyPlan(executor, plan.id, actorId);
	}

	return {
		id,
		reference,
		shortReference,
		planId: plan.id,
		createdBy: actorId,
		updatedBy: actorId,
		role: input.role,
		body: input.body,
		scopeDirection,
		referencedEntityIds,
		supersededEntryIds,
		tombstone: false,
		revision: 1,
		contentHash,
		createdAt,
		updatedAt: createdAt
	};
}

export function listPlanEntries(executor: SqliteExecutor, input: { planId: string }): PlanEntryRecord[] {
	const plan = getSqliteEntityOrThrow(executor, input.planId);
	if (plan.kind !== "plan" || plan.projectId !== executor.currentProjectId) {
		throw new Error(`Plan not found: ${input.planId}`);
	}
	const rows = executor.drizzle.all(sql`SELECT * FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id} ORDER BY created_at, reference`) as PlanEntryRow[];
	return rows.map((row) => toPlanEntryRecord(executor, row));
}

export function listPlanEntryPage(executor: SqliteExecutor, input: { planId: string; before?: string; all?: boolean }): PlanEntryPage {
	const plan = getSqliteEntityOrThrow(executor, input.planId);
	if (plan.kind !== "plan" || plan.projectId !== executor.currentProjectId) {
		throw new Error(`Plan not found: ${input.planId}`);
	}

	const cursor = input.before ? decodeCursor(input.before) : undefined;
	const beforePredicate = cursor
		? sql`AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND reference < ${cursor.reference}))`
		: sql``;
	const availableCount = executor.drizzle.get(sql`SELECT COUNT(*) AS count FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id} ${beforePredicate}`) as { count: number };
	const total = executor.drizzle.get(sql`SELECT COUNT(*) AS count FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id}`) as { count: number };
	const rows = input.all
		? executor.drizzle.all(sql`SELECT * FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id} ${beforePredicate} ORDER BY created_at ASC, reference ASC`) as PlanEntryRow[]
		: executor.drizzle.all(sql`SELECT * FROM (
			SELECT * FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${plan.id} ${beforePredicate}
			ORDER BY created_at DESC, reference DESC LIMIT ${DEFAULT_PAGE_SIZE}
		) ORDER BY created_at ASC, reference ASC`) as PlanEntryRow[];
	const entries = rows.map((row) => toPlanEntryRecord(executor, row));
	const oldest = entries[0];

	return {
		entries,
		total: total.count,
		nextBefore: !input.all && oldest && availableCount.count > entries.length
			? encodeCursor({ createdAt: oldest.createdAt, reference: oldest.reference })
			: null
	};
}

export function updatePlanEntry(
	executor: SqliteExecutor,
	input: { entryId: string; body: string; expectedRevision: number; expectedContentHash: string },
	actorId: string
): PlanEntryRecord {
	const existing = getPlanEntry(executor, input.entryId);
	assertPlanEntryHead(existing, input);
	if (input.body.trim().length === 0) {
		throw new Error("Plan entry body must not be empty.");
	}
	const predecessor = toPlanEntryState(existing);
	const successor = { ...predecessor, body: input.body, tombstone: false };
	const revision = existing.revision + 1;
	const updatedAt = new Date().toISOString();
	const contentHash = computePlanEntryContentHash(successor);
	const result = executor.drizzle.run(sql`UPDATE plan_entries SET body = ${successor.body}, updated_by = ${actorId}, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${existing.id} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = 0`);
	if (result.changes === 0) {
		const current = getPlanEntry(executor, existing.id);
		throw new PlanEntryConflictError(current.id, current.revision, current.contentHash);
	}
	appendPlanEntryDelta(executor, existing.id, revision, successor, predecessor, actorId, updatedAt);
	reopenReadyPlan(executor, existing.planId, actorId);
	return getPlanEntry(executor, existing.id);
}

export function linkPlanEntryEntity(executor: SqliteExecutor, input: { entryId: string; targetId: string }, actorId: string): LinkResult {
	const entry = getPlanEntry(executor, input.entryId);
	assertPlanEntryHead(entry, { entryId: input.entryId, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
	const targetId = getProjectEntityIdOrThrow(executor, input.targetId);
	if (entry.referencedEntityIds.includes(targetId)) {
		return { relation: { fromId: entry.id, toId: targetId, type: "informs", createdBy: entry.updatedBy, createdAt: entry.updatedAt }, created: false };
	}

	const updated = revisePlanEntryReferences(executor, entry, [...entry.referencedEntityIds, targetId], actorId);
	return { relation: { fromId: updated.id, toId: targetId, type: "informs", createdBy: actorId, createdAt: updated.updatedAt }, created: true };
}

export function unlinkPlanEntryEntity(executor: SqliteExecutor, input: { entryId: string; targetId: string }, actorId: string): UnlinkResult {
	const entry = getPlanEntry(executor, input.entryId);
	assertPlanEntryHead(entry, { entryId: input.entryId, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
	const targetId = getProjectEntityIdOrThrow(executor, input.targetId);
	if (!entry.referencedEntityIds.includes(targetId)) {
		return { relation: { fromId: entry.id, toId: targetId, type: "informs", createdBy: entry.updatedBy, createdAt: entry.updatedAt }, removed: false };
	}

	const updated = revisePlanEntryReferences(executor, entry, entry.referencedEntityIds.filter((referencedEntityId) => referencedEntityId !== targetId), actorId);
	return { relation: { fromId: updated.id, toId: targetId, type: "informs", createdBy: actorId, createdAt: updated.updatedAt }, removed: true };
}

export function deletePlanEntry(
	executor: SqliteExecutor,
	input: { entryId: string; expectedRevision: number; expectedContentHash: string },
	actorId: string
): PlanEntryRecord {
	const existing = getPlanEntry(executor, input.entryId);
	assertPlanEntryHead(existing, input);
	const predecessor = toPlanEntryState(existing);
	const successor = { ...predecessor, tombstone: true };
	const revision = existing.revision + 1;
	const updatedAt = new Date().toISOString();
	const contentHash = computePlanEntryContentHash(successor);
	const result = executor.drizzle.run(sql`UPDATE plan_entries SET updated_by = ${actorId}, revision = ${revision}, content_hash = ${contentHash}, tombstone = 1, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${existing.id} AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = 0`);
	if (result.changes === 0) {
		const current = getPlanEntry(executor, existing.id);
		throw new PlanEntryConflictError(current.id, current.revision, current.contentHash);
	}
	appendPlanEntryDelta(executor, existing.id, revision, successor, predecessor, actorId, updatedAt);
	reopenReadyPlan(executor, existing.planId, actorId);
	return getPlanEntry(executor, existing.id);
}

export function listPlanEntryHistory(executor: SqliteExecutor, input: { entryId: string }): PlanEntryHistoryEntry[] {
	const entry = findPlanEntry(executor, input.entryId);
	if (!entry) {
		return [];
	}
	const head = toPlanEntryRecord(executor, entry);
	const headState: PlanEntryState = {
		role: head.role,
		body: entry.body,
		scopeDirection: head.scopeDirection,
		referencedEntityIds: head.referencedEntityIds,
		supersededEntryIds: head.supersededEntryIds,
		tombstone: head.tombstone
	};
	const patches = executor.drizzle.all(sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM revision_entries WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND record_kind = 'plan-entry' AND record_key = ${encodePlanEntryRecordKey(head.id)} ORDER BY revision`) as LedgerRow[];
	const revisionPatches = patches.map(toPlanEntryRevisionPatch);
	return revisionPatches.map((patch): PlanEntryHistoryEntry => {
		const state = materializePlanEntryFromPatches({ ...headState, revision: head.revision, createdAt: head.createdAt }, revisionPatches, patch.revision);
		return {
			entryId: head.id,
			targetRevision: patch.revision,
			headRevision: head.revision,
			...state,
			author: patch.author,
			createdAt: patch.createdAt,
			restoredFromRevision: patch.restoredFromRevision ?? null
		};
	});
}

export class LocalPlanEntryStore {
	public constructor(executor: SqliteExecutor) {
		this.executor = executor;
	}

	protected readonly executor: SqliteExecutor;

	public createPlanEntry(input: { planId: string; role: string; body: string; scopeDirection?: PlanEntryScopeDirection; referencedEntityIds?: string[]; supersededEntryIds?: string[] }, actorId: string): PlanEntrySummary {
		return toPlanEntrySummary(createPlanEntry(this.executor, input, actorId));
	}

	public getPlanEntry(input: { entryId: string }): PlanEntryRecord {
		return getPlanEntry(this.executor, input.entryId);
	}

	public listPlanEntries(input: { planId: string }): PlanEntryRecord[] {
		return listPlanEntries(this.executor, input);
	}

	public listPlanEntryPage(input: { planId: string; before?: string; all?: boolean }): PlanEntryPage {
		return listPlanEntryPage(this.executor, input);
	}

	public updatePlanEntry(input: { entryId: string; body: string; expectedRevision: number; expectedContentHash: string }, actorId: string): PlanEntryRecord {
		return updatePlanEntry(this.executor, input, actorId);
	}

	public deletePlanEntry(input: { entryId: string; expectedRevision: number; expectedContentHash: string }, actorId: string): PlanEntryRecord {
		return deletePlanEntry(this.executor, input, actorId);
	}

	public linkPlanEntryEntity(input: { entryId: string; targetId: string }, actorId: string): LinkResult {
		return linkPlanEntryEntity(this.executor, input, actorId);
	}

	public unlinkPlanEntryEntity(input: { entryId: string; targetId: string }, actorId: string): UnlinkResult {
		return unlinkPlanEntryEntity(this.executor, input, actorId);
	}

	public listPlanEntryHistory(input: { entryId: string }): PlanEntryHistoryEntry[] {
		return listPlanEntryHistory(this.executor, input);
	}
}

function appendPlanEntryDelta(executor: SqliteExecutor, entryId: string, revision: number, successor: PlanEntryState, predecessor: PlanEntryState, author: string, createdAt: string): void {
	const transition = createReverseFieldPatch(successor, predecessor, PLAN_ENTRY_REVERSE_PATCH_REGISTRY);
	executor.drizzle.run(sql`INSERT INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${executor.tenantId}, ${executor.currentProjectId}, 'plan-entry', ${encodePlanEntryRecordKey(entryId)}, ${revision}, ${author}, ${transition.patchFormat}, ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)}, ${encodeRevisionPatchHash(transition.targetHash)}, NULL, ${createdAt})`);
}

function reopenReadyPlan(executor: SqliteExecutor, planId: string, actorId: string): void {
	const plan = getSqliteEntityOrThrow(executor, planId);
	if (plan.status === "ready") {
		updateEntityStatus(executor, { entityId: plan.id, status: "in-progress" }, actorId);
	}
}

function revisePlanEntryReferences(executor: SqliteExecutor, entry: PlanEntryRecord, referencedEntityIds: string[], actorId: string): PlanEntryRecord {
	const predecessor = toPlanEntryState(entry);
	const successor = { ...predecessor, referencedEntityIds };
	const revision = entry.revision + 1;
	const updatedAt = new Date().toISOString();
	const contentHash = computePlanEntryContentHash(successor);
	const result = executor.drizzle.run(sql`UPDATE plan_entries SET updated_by = ${actorId}, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${entry.id} AND revision = ${entry.revision} AND content_hash = ${entry.contentHash} AND tombstone = 0`);
	if (result.changes === 0) {
		const current = getPlanEntry(executor, entry.id);
		throw new PlanEntryConflictError(current.id, current.revision, current.contentHash);
	}

	replaceReferences(executor, entry.id, referencedEntityIds);
	appendPlanEntryDelta(executor, entry.id, revision, successor, predecessor, actorId, updatedAt);
	return getPlanEntry(executor, entry.id);
}

function replaceReferences(executor: SqliteExecutor, entryId: string, referencedEntityIds: string[]): void {
	executor.drizzle.run(sql`DELETE FROM plan_entry_references WHERE tenant_id = ${executor.tenantId} AND plan_entry_id = ${entryId}`);
	for (const [position, entityId] of referencedEntityIds.entries()) {
		executor.drizzle.run(sql`INSERT INTO plan_entry_references (tenant_id, plan_entry_id, entity_id, position) VALUES (${executor.tenantId}, ${entryId}, ${entityId}, ${position})`);
	}
}

function getPlanEntry(executor: SqliteExecutor, entryId: string): PlanEntryRecord {
	const entry = findPlanEntry(executor, entryId);
	if (!entry) {
		throw new Error(`Plan entry not found: ${entryId}`);
	}
	return toPlanEntryRecord(executor, entry);
}

function encodeCursor(cursor: PlanEntryCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): PlanEntryCursor {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PlanEntryCursor>;
		if (typeof cursor.createdAt === "string" && typeof cursor.reference === "string") {
			return { createdAt: cursor.createdAt, reference: cursor.reference };
		}
	} catch {}

	throw new Error("Invalid Plan entry cursor.");
}

function findPlanEntry(executor: SqliteExecutor, entryId: string): PlanEntryRow | undefined {
	return executor.drizzle.all(sql`SELECT plan_entries.* FROM plan_entries
		JOIN entities AS plans ON plans.tenant_id = plan_entries.tenant_id AND plans.id = plan_entries.plan_id
		WHERE plan_entries.tenant_id = ${executor.tenantId} AND plans.project_id = ${executor.currentProjectId}
			AND (plan_entries.id = ${entryId} OR plan_entries.reference = ${entryId} OR plan_entries.short_reference = ${entryId})`)[0] as PlanEntryRow | undefined;
}

function assertPlanEntryHead(entry: PlanEntryRecord, input: { entryId: string; expectedRevision: number; expectedContentHash: string }): void {
	if (entry.tombstone) {
		throw new Error(`Plan entry not found: ${input.entryId}`);
	}
	if (entry.revision !== input.expectedRevision || entry.contentHash !== input.expectedContentHash) {
		throw new PlanEntryConflictError(entry.id, entry.revision, entry.contentHash);
	}
}

function toPlanEntryState(entry: PlanEntryRecord): PlanEntryState {
	if (entry.body === undefined) {
		throw new Error(`Plan entry body is unavailable: ${entry.id}`);
	}
	return {
		role: entry.role,
		body: entry.body,
		scopeDirection: entry.scopeDirection,
		referencedEntityIds: entry.referencedEntityIds,
		supersededEntryIds: entry.supersededEntryIds,
		tombstone: entry.tombstone
	};
}

function toPlanEntryRevisionPatch(row: LedgerRow): PlanEntryRevisionPatch {
	return {
		revision: row.revision,
		author: row.author,
		patchFormat: row.patch_format,
		reversePatch: row.reverse_patch,
		sourceHash: decodeRevisionPatchHash(row.source_hash),
		targetHash: decodeRevisionPatchHash(row.target_hash),
		createdAt: row.created_at,
		...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision })
	};
}

function validateReferencedEntityIds(executor: SqliteExecutor, referencedEntityIds: string[]): string[] {
	const resolvedEntityIds: string[] = [];
	const seenEntityIds = new Set<string>();
	for (const referencedEntityId of referencedEntityIds) {
		const entity = getSqliteEntityOrThrow(executor, referencedEntityId);
		if (entity.projectId !== executor.currentProjectId) {
			throw new Error(`Entity not found: ${referencedEntityId}`);
		}
		if (seenEntityIds.has(entity.id)) {
			throw new Error(`Plan entry references contain duplicate entity: ${entity.id}`);
		}
		seenEntityIds.add(entity.id);
		resolvedEntityIds.push(entity.id);
	}
	return resolvedEntityIds;
}

function getProjectEntityIdOrThrow(executor: SqliteExecutor, entityId: string): string {
	const entity = getSqliteEntityOrThrow(executor, entityId);
	if (entity.projectId !== executor.currentProjectId) {
		throw new Error(`Entity not found: ${entityId}`);
	}
	return entity.id;
}

function validateSupersededEntryIds(executor: SqliteExecutor, planId: string, role: PlanEntryRecord["role"], supersededEntryIds: string[]): string[] {
	const resolvedEntryIds: string[] = [];
	const seenEntryIds = new Set<string>();
	for (const supersededEntryId of supersededEntryIds) {
		const entry = getPlanEntry(executor, supersededEntryId);
		if (entry.planId !== planId || entry.tombstone) {
			throw new Error(`Plan entry not found: ${supersededEntryId}`);
		}
		if (role === "decision" && entry.role !== "question" && entry.role !== "decision") {
			throw new Error("A decision can supersede only question or decision Plan entries.");
		}
		if (seenEntryIds.has(entry.id)) {
			throw new Error(`Plan entry supersessions contain duplicate entry: ${entry.id}`);
		}
		seenEntryIds.add(entry.id);
		resolvedEntryIds.push(entry.id);
	}
	return resolvedEntryIds;
}

function toPlanEntryRecord(executor: SqliteExecutor, row: PlanEntryRow): PlanEntryRecord {
	const referencedEntityIds = executor.drizzle.all(sql`SELECT entity_id FROM plan_entry_references WHERE tenant_id = ${executor.tenantId} AND plan_entry_id = ${row.id} ORDER BY position`).map((reference) => (reference as { entity_id: string }).entity_id);
	const supersededEntryIds = executor.drizzle.all(sql`SELECT superseded_entry_id FROM plan_entry_supersessions WHERE tenant_id = ${executor.tenantId} AND plan_entry_id = ${row.id} ORDER BY position`).map((supersession) => (supersession as { superseded_entry_id: string }).superseded_entry_id);
	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		planId: row.plan_id,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		role: row.role as PlanEntryRecord["role"],
		...(row.tombstone === 0 && { body: row.body }),
		scopeDirection: row.scope_direction,
		referencedEntityIds,
		supersededEntryIds,
		tombstone: row.tombstone !== 0,
		revision: row.revision,
		contentHash: row.content_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function allocateShortReference(executor: SqliteExecutor, id: string): string {
	const baseReference = shortEntityReference({ id, kind: "planEntry" });
	let reference = baseReference;
	let suffix = 2;
	while (executor.drizzle.all(sql`SELECT id FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND short_reference = ${reference}`).length > 0) {
		reference = `${baseReference}-${suffix}`;
		suffix += 1;
	}
	return reference;
}

function nextPlanEntryCreatedAt(executor: SqliteExecutor, planId: string): string {
	const latest = executor.drizzle.all(sql`SELECT created_at FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${planId} ORDER BY created_at DESC, reference DESC LIMIT 1`)[0] as { created_at: string } | undefined;
	const latestTimestamp = latest ? Date.parse(latest.created_at) : Number.NEGATIVE_INFINITY;
	return new Date(Math.max(Date.now(), latestTimestamp + 1)).toISOString();
}