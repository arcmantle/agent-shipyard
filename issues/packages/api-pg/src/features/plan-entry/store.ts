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
	type PlanEntryScopeDirection,
	type PlanEntryState,
	type UnlinkResult
} from "@agent-issues/core";

import type { TenantExecutor } from "../../db/connection.js";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { PgEntityStore } from "../entity-store/store.js";

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
	tombstone: boolean;
	revision: number;
	content_hash: string;
	created_at: string;
	updated_at: string;
};

type PlanRow = { id: string; status: string };

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

type PlanEntryCursor = Pick<PlanEntryRecord, "createdAt" | "reference">;

type PlanEntryReferenceRow = { plan_entry_id: string; entity_id: string };

type PlanEntrySupersessionRow = { plan_entry_id: string; superseded_entry_id: string };

const DEFAULT_PAGE_SIZE = 50;

export class PgPlanEntryStore {
	public constructor(executor: TenantExecutor) {
		this.executor = executor;
	}

	protected readonly executor: TenantExecutor;

	public async createPlanEntry(input: { planId: string; role: string; body: string; scopeDirection?: PlanEntryScopeDirection; referencedEntityIds?: string[]; supersededEntryIds?: string[] }, actorId: string): Promise<PlanEntrySummary> {
		const plan = await getProjectPlanOrThrow(this.executor, input.planId);
		validateCreateInput(input);
		const referencedEntityIds = await validateReferencedEntityIds(this.executor, input.referencedEntityIds ?? []);
		const supersededEntryIds = await validateSupersededEntryIds(this.executor, plan.id, input.role, input.supersededEntryIds ?? []);
		const hasExistingEntries = (await this.executor.execute(sql`SELECT 1 FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid LIMIT 1`)).rows.length > 0;
		const id = randomUUID();
		const reference = encodeCanonicalReference("planEntry", id);
		const shortReference = await allocateShortReference(this.executor, id);
		const createdAt = await nextPlanEntryCreatedAt(this.executor, plan.id);
		const state: PlanEntryState = { role: input.role, body: input.body, scopeDirection: input.scopeDirection ?? null, referencedEntityIds, supersededEntryIds, tombstone: false };
		const contentHash = computePlanEntryContentHash(state);

		await this.executor.execute(sql`INSERT INTO plan_entries (tenant_id, id, reference, short_reference, plan_id, created_by, updated_by, role, body, scope_direction, revision, content_hash, tombstone, created_at, updated_at)
			VALUES (${this.executor.tenantId}, ${id}::uuid, ${reference}, ${shortReference}, ${plan.id}::uuid, ${actorId}::uuid, ${actorId}::uuid, ${input.role}, ${input.body}, ${state.scopeDirection}, 1, ${contentHash}, FALSE, ${createdAt}, ${createdAt})`);
		await replaceReferences(this.executor, id, referencedEntityIds);
		await replaceSupersessions(this.executor, id, supersededEntryIds);
		await appendPlanEntryDelta(this.executor, id, 1, state, state, actorId, createdAt);
		if (plan.status === "draft" && !hasExistingEntries) {
			await new PgEntityStore(this.executor).updateEntityStatus({ entityId: plan.id, status: "in-progress" }, actorId);
		} else if (plan.status === "ready") {
			await new PgEntityStore(this.executor).updateEntityStatus({ entityId: plan.id, status: "in-progress" }, actorId);
		}
		return toPlanEntrySummary(toPlanEntryRecord({ id, reference, short_reference: shortReference, plan_id: plan.id, created_by: actorId, updated_by: actorId, role: input.role, body: input.body, scope_direction: state.scopeDirection, tombstone: false, revision: 1, content_hash: contentHash, created_at: createdAt, updated_at: createdAt, referencedEntityIds, supersededEntryIds }));
	}

	public async getPlanEntry(input: { entryId: string }): Promise<PlanEntryRecord> {
		return getPlanEntryOrThrow(this.executor, input.entryId);
	}

	public async updatePlanEntry(input: { entryId: string; body: string; expectedRevision: number; expectedContentHash: string }, actorId: string): Promise<PlanEntryRecord> {
		const existing = await getPlanEntryOrThrow(this.executor, input.entryId);
		assertPlanEntryHead(existing, input);
		if (input.body.trim().length === 0) {
			throw new Error("Plan entry body must not be empty.");
		}
		const predecessor = toPlanEntryState(existing);
		const successor = { ...predecessor, body: input.body, tombstone: false };
		const revision = existing.revision + 1;
		const updatedAt = new Date().toISOString();
		const contentHash = computePlanEntryContentHash(successor);
		const result = await this.executor.execute(sql`UPDATE plan_entries SET body = ${successor.body}, updated_by = ${actorId}::uuid, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
			WHERE tenant_id = ${this.executor.tenantId} AND id = ${existing.id}::uuid AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = FALSE`);
		if ((result.rowCount ?? 0) === 0) {
			throw await getPlanEntryConflict(this.executor, input.entryId);
		}
		await appendPlanEntryDelta(this.executor, existing.id, revision, successor, predecessor, actorId, updatedAt);
		await this.reopenReadyPlan(existing.planId, actorId);
		return getPlanEntryOrThrow(this.executor, existing.id);
	}

	public async deletePlanEntry(input: { entryId: string; expectedRevision: number; expectedContentHash: string }, actorId: string): Promise<PlanEntryRecord> {
		const existing = await getPlanEntryOrThrow(this.executor, input.entryId);
		assertPlanEntryHead(existing, input);
		const predecessor = toPlanEntryState(existing);
		const successor = { ...predecessor, tombstone: true };
		const revision = existing.revision + 1;
		const updatedAt = new Date().toISOString();
		const contentHash = computePlanEntryContentHash(successor);
		const result = await this.executor.execute(sql`UPDATE plan_entries SET updated_by = ${actorId}::uuid, revision = ${revision}, content_hash = ${contentHash}, tombstone = TRUE, updated_at = ${updatedAt}
			WHERE tenant_id = ${this.executor.tenantId} AND id = ${existing.id}::uuid AND revision = ${input.expectedRevision} AND content_hash = ${input.expectedContentHash} AND tombstone = FALSE`);
		if ((result.rowCount ?? 0) === 0) {
			throw await getPlanEntryConflict(this.executor, input.entryId);
		}
		await appendPlanEntryDelta(this.executor, existing.id, revision, successor, predecessor, actorId, updatedAt);
		await this.reopenReadyPlan(existing.planId, actorId);
		return getPlanEntryOrThrow(this.executor, existing.id);
	}

	public async linkPlanEntryEntity(input: { entryId: string; targetId: string }, actorId: string): Promise<LinkResult> {
		const entry = await getPlanEntryOrThrow(this.executor, input.entryId);
		assertPlanEntryHead(entry, { entryId: input.entryId, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const targetId = await getProjectEntityIdOrThrow(this.executor, input.targetId);
		if (entry.referencedEntityIds.includes(targetId)) {
			return { relation: { fromId: entry.id, toId: targetId, type: "informs", createdBy: entry.updatedBy, createdAt: entry.updatedAt }, created: false };
		}

		const updated = await revisePlanEntryReferences(this.executor, entry, [...entry.referencedEntityIds, targetId], actorId);
		return { relation: { fromId: updated.id, toId: targetId, type: "informs", createdBy: actorId, createdAt: updated.updatedAt }, created: true };
	}

	public async unlinkPlanEntryEntity(input: { entryId: string; targetId: string }, actorId: string): Promise<UnlinkResult> {
		const entry = await getPlanEntryOrThrow(this.executor, input.entryId);
		assertPlanEntryHead(entry, { entryId: input.entryId, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const targetId = await getProjectEntityIdOrThrow(this.executor, input.targetId);
		if (!entry.referencedEntityIds.includes(targetId)) {
			return { relation: { fromId: entry.id, toId: targetId, type: "informs", createdBy: entry.updatedBy, createdAt: entry.updatedAt }, removed: false };
		}

		const updated = await revisePlanEntryReferences(this.executor, entry, entry.referencedEntityIds.filter((referencedEntityId) => referencedEntityId !== targetId), actorId);
		return { relation: { fromId: updated.id, toId: targetId, type: "informs", createdBy: actorId, createdAt: updated.updatedAt }, removed: true };
	}

	public async listPlanEntries(input: { planId: string }): Promise<PlanEntryRecord[]> {
		const plan = await getProjectPlanOrThrow(this.executor, input.planId);
		const result = await this.executor.execute(sql`SELECT * FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid ORDER BY created_at, reference`);
		return toPlanEntryRecordsWithLinks(this.executor, result.rows as PlanEntryRow[]);
	}

	protected async reopenReadyPlan(planId: string, actorId: string): Promise<void> {
		const plan = await getProjectPlanOrThrow(this.executor, planId);
		if (plan.status === "ready") {
			await new PgEntityStore(this.executor).updateEntityStatus({ entityId: plan.id, status: "in-progress" }, actorId);
		}
	}

	public async listPlanEntryPage(input: { planId: string; before?: string; all?: boolean }): Promise<PlanEntryPage> {
		const plan = await getProjectPlanOrThrow(this.executor, input.planId);
		const cursor = input.before ? decodeCursor(input.before) : undefined;
		const beforePredicate = cursor
			? sql`AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND reference < ${cursor.reference}))`
			: sql``;
		const availableCount = await this.executor.execute(sql`SELECT COUNT(*) AS count FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid ${beforePredicate}`);
		const total = await this.executor.execute(sql`SELECT COUNT(*) AS count FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid`);
		const result = input.all
			? await this.executor.execute(sql`SELECT * FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid ${beforePredicate} ORDER BY created_at ASC, reference ASC`)
			: await this.executor.execute(sql`SELECT * FROM (
				SELECT * FROM plan_entries WHERE tenant_id = ${this.executor.tenantId} AND plan_id = ${plan.id}::uuid ${beforePredicate}
				ORDER BY created_at DESC, reference DESC LIMIT ${DEFAULT_PAGE_SIZE}
			) AS page ORDER BY created_at ASC, reference ASC`);
		const entries = await toPlanEntryRecordsWithLinks(this.executor, result.rows as PlanEntryRow[]);
		const oldest = entries[0];

		return {
			entries,
			total: Number((total.rows[0] as { count: string }).count),
			nextBefore: !input.all && oldest && Number((availableCount.rows[0] as { count: string }).count) > entries.length
				? encodeCursor({ createdAt: oldest.createdAt, reference: oldest.reference })
				: null
		};
	}

	public async listPlanEntryHistory(input: { entryId: string }): Promise<PlanEntryHistoryEntry[]> {
		const row = await findPlanEntry(this.executor, input.entryId);
		if (!row) {
			return [];
		}
		const head = await toPlanEntryRecordWithLinks(this.executor, row);
		const ledger = await this.executor.execute(sql`SELECT revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
			FROM revision_entries WHERE tenant_id = ${this.executor.tenantId} AND project_id = ${this.executor.currentProjectId}::uuid AND record_kind = 'plan-entry' AND record_key = ${encodePlanEntryRecordKey(row.id)} ORDER BY revision`);
		const patches = (ledger.rows as LedgerRow[]).map(toPlanEntryRevisionPatch);
		const headState: PlanEntryState = { role: head.role, body: row.body, scopeDirection: head.scopeDirection, referencedEntityIds: head.referencedEntityIds, supersededEntryIds: head.supersededEntryIds, tombstone: head.tombstone };
		return patches.map((patch) => ({ entryId: head.id, targetRevision: patch.revision, headRevision: head.revision, ...materializePlanEntryFromPatches({ ...headState, revision: head.revision, createdAt: head.createdAt }, patches, patch.revision), author: patch.author, createdAt: patch.createdAt, restoredFromRevision: patch.restoredFromRevision ?? null }));
	}
}

function validateCreateInput(input: { role: string; body: string; scopeDirection?: PlanEntryScopeDirection }): asserts input is { role: PlanEntryRecord["role"]; body: string; scopeDirection?: PlanEntryScopeDirection } {
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
}

async function getProjectPlanOrThrow(executor: TenantExecutor, planId: string): Promise<PlanRow> {
	const result = await executor.execute(sql`SELECT id, status FROM entities WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId}::uuid AND kind = 'plan' AND tombstone = FALSE
		AND (id::text = ${planId} OR reference = ${planId} OR short_reference = ${planId})`);
	const plan = result.rows[0] as PlanRow | undefined;
	if (!plan) {
		throw new Error(`Plan not found: ${planId}`);
	}
	return plan;
}

async function findPlanEntry(executor: TenantExecutor, entryId: string): Promise<PlanEntryRow | undefined> {
	const result = await executor.execute(sql`SELECT plan_entries.* FROM plan_entries
		JOIN entities AS plans ON plans.tenant_id = plan_entries.tenant_id AND plans.id = plan_entries.plan_id
		WHERE plan_entries.tenant_id = ${executor.tenantId} AND plans.project_id = ${executor.currentProjectId}::uuid
			AND (plan_entries.id::text = ${entryId} OR plan_entries.reference = ${entryId} OR plan_entries.short_reference = ${entryId})`);
	return result.rows[0] as PlanEntryRow | undefined;
}

async function getPlanEntryOrThrow(executor: TenantExecutor, entryId: string): Promise<PlanEntryRecord> {
	const row = await findPlanEntry(executor, entryId);
	if (!row) {
		throw new Error(`Plan entry not found: ${entryId}`);
	}
	return toPlanEntryRecordWithLinks(executor, row);
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

async function validateReferencedEntityIds(executor: TenantExecutor, referencedEntityIds: string[]): Promise<string[]> {
	const resolved = await Promise.all(referencedEntityIds.map(async (entityId) => {
		const result = await executor.execute(sql`SELECT id FROM entities WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId}::uuid AND tombstone = FALSE
			AND (id::text = ${entityId} OR reference = ${entityId} OR short_reference = ${entityId})`);
		const row = result.rows[0] as { id: string } | undefined;
		if (!row) {
			throw new Error(`Entity not found: ${entityId}`);
		}
		return row.id;
	}));
	if (new Set(resolved).size !== resolved.length) {
		throw new Error("Plan entry references contain duplicate entities.");
	}
	return resolved;
}

async function getProjectEntityIdOrThrow(executor: TenantExecutor, entityId: string): Promise<string> {
	const result = await executor.execute(sql`SELECT id FROM entities WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId}::uuid AND tombstone = FALSE
		AND (id::text = ${entityId} OR reference = ${entityId} OR short_reference = ${entityId})`);
	const entity = result.rows[0] as { id: string } | undefined;
	if (!entity) {
		throw new Error(`Entity not found: ${entityId}`);
	}
	return entity.id;
}

async function validateSupersededEntryIds(executor: TenantExecutor, planId: string, role: PlanEntryRecord["role"], supersededEntryIds: string[]): Promise<string[]> {
	const resolved = await Promise.all(supersededEntryIds.map(async (entryId) => {
		const entry = await getPlanEntryOrThrow(executor, entryId);
		if (entry.planId !== planId || entry.tombstone) {
			throw new Error(`Plan entry not found: ${entryId}`);
		}
		if (role === "decision" && entry.role !== "question" && entry.role !== "decision") {
			throw new Error("A decision can supersede only question or decision Plan entries.");
		}
		return entry.id;
	}));
	if (new Set(resolved).size !== resolved.length) {
		throw new Error("Plan entry supersessions contain duplicate entries.");
	}
	return resolved;
}

async function replaceReferences(executor: TenantExecutor, entryId: string, entityIds: string[]): Promise<void> {
	await executor.execute(sql`DELETE FROM plan_entry_references WHERE tenant_id = ${executor.tenantId} AND plan_entry_id = ${entryId}::uuid`);
	for (const [position, entityId] of entityIds.entries()) {
		await executor.execute(sql`INSERT INTO plan_entry_references (tenant_id, plan_entry_id, entity_id, position) VALUES (${executor.tenantId}, ${entryId}::uuid, ${entityId}::uuid, ${position})`);
	}
}

async function revisePlanEntryReferences(executor: TenantExecutor, entry: PlanEntryRecord, referencedEntityIds: string[], actorId: string): Promise<PlanEntryRecord> {
	const predecessor = toPlanEntryState(entry);
	const successor = { ...predecessor, referencedEntityIds };
	const revision = entry.revision + 1;
	const updatedAt = new Date().toISOString();
	const contentHash = computePlanEntryContentHash(successor);
	const result = await executor.execute(sql`UPDATE plan_entries SET updated_by = ${actorId}::uuid, revision = ${revision}, content_hash = ${contentHash}, updated_at = ${updatedAt}
		WHERE tenant_id = ${executor.tenantId} AND id = ${entry.id}::uuid AND revision = ${entry.revision} AND content_hash = ${entry.contentHash} AND tombstone = FALSE`);
	if ((result.rowCount ?? 0) === 0) {
		throw await getPlanEntryConflict(executor, entry.id);
	}

	await replaceReferences(executor, entry.id, referencedEntityIds);
	await appendPlanEntryDelta(executor, entry.id, revision, successor, predecessor, actorId, updatedAt);
	return getPlanEntryOrThrow(executor, entry.id);
}

async function replaceSupersessions(executor: TenantExecutor, entryId: string, supersededEntryIds: string[]): Promise<void> {
	for (const [position, supersededEntryId] of supersededEntryIds.entries()) {
		await executor.execute(sql`INSERT INTO plan_entry_supersessions (tenant_id, plan_entry_id, superseded_entry_id, position) VALUES (${executor.tenantId}, ${entryId}::uuid, ${supersededEntryId}::uuid, ${position})`);
	}
}

async function toPlanEntryRecordWithLinks(executor: TenantExecutor, row: PlanEntryRow): Promise<PlanEntryRecord> {
	return (await toPlanEntryRecordsWithLinks(executor, [row]))[0]!;
}

async function toPlanEntryRecordsWithLinks(executor: TenantExecutor, rows: PlanEntryRow[]): Promise<PlanEntryRecord[]> {
	if (rows.length === 0) {
		return [];
	}

	const entryIds = rows.map((row) => sql`${row.id}::uuid`);
	const references = await executor.execute(sql`SELECT plan_entry_id, entity_id FROM plan_entry_references
		WHERE tenant_id = ${executor.tenantId} AND plan_entry_id IN (${sql.join(entryIds, sql`, `)}) ORDER BY plan_entry_id, position`);
	const supersessions = await executor.execute(sql`SELECT plan_entry_id, superseded_entry_id FROM plan_entry_supersessions
		WHERE tenant_id = ${executor.tenantId} AND plan_entry_id IN (${sql.join(entryIds, sql`, `)}) ORDER BY plan_entry_id, position`);
	const referencedEntityIds = new Map<string, string[]>();
	const supersededEntryIds = new Map<string, string[]>();

	for (const reference of references.rows as PlanEntryReferenceRow[]) {
		const entryReferences = referencedEntityIds.get(reference.plan_entry_id) ?? [];
		entryReferences.push(reference.entity_id);
		referencedEntityIds.set(reference.plan_entry_id, entryReferences);
	}
	for (const supersession of supersessions.rows as PlanEntrySupersessionRow[]) {
		const entrySupersessions = supersededEntryIds.get(supersession.plan_entry_id) ?? [];
		entrySupersessions.push(supersession.superseded_entry_id);
		supersededEntryIds.set(supersession.plan_entry_id, entrySupersessions);
	}

	return rows.map((row) => toPlanEntryRecord({
		...row,
		referencedEntityIds: referencedEntityIds.get(row.id) ?? [],
		supersededEntryIds: supersededEntryIds.get(row.id) ?? []
	}));
}

function toPlanEntryRecord(row: PlanEntryRow & { referencedEntityIds: string[]; supersededEntryIds: string[] }): PlanEntryRecord {
	return { id: row.id, reference: row.reference, shortReference: row.short_reference, planId: row.plan_id, createdBy: row.created_by, updatedBy: row.updated_by, role: row.role as PlanEntryRecord["role"], ...(!row.tombstone && { body: row.body }), scopeDirection: row.scope_direction, referencedEntityIds: row.referencedEntityIds, supersededEntryIds: row.supersededEntryIds, tombstone: row.tombstone, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toPlanEntryState(entry: PlanEntryRecord): PlanEntryState {
	if (entry.body === undefined) {
		throw new Error(`Plan entry body is unavailable: ${entry.id}`);
	}
	return { role: entry.role, body: entry.body, scopeDirection: entry.scopeDirection, referencedEntityIds: entry.referencedEntityIds, supersededEntryIds: entry.supersededEntryIds, tombstone: entry.tombstone };
}

function assertPlanEntryHead(entry: PlanEntryRecord, input: { entryId: string; expectedRevision: number; expectedContentHash: string }): void {
	if (entry.tombstone) {
		throw new Error(`Plan entry not found: ${input.entryId}`);
	}
	if (entry.revision !== input.expectedRevision || entry.contentHash !== input.expectedContentHash) {
		throw new PlanEntryConflictError(entry.id, entry.revision, entry.contentHash);
	}
}

async function getPlanEntryConflict(executor: TenantExecutor, entryId: string): Promise<PlanEntryConflictError> {
	const current = await getPlanEntryOrThrow(executor, entryId);
	return new PlanEntryConflictError(current.id, current.revision, current.contentHash);
}

async function appendPlanEntryDelta(executor: TenantExecutor, entryId: string, revision: number, successor: PlanEntryState, predecessor: PlanEntryState, author: string, createdAt: string): Promise<void> {
	const transition = createReverseFieldPatch(successor, predecessor, PLAN_ENTRY_REVERSE_PATCH_REGISTRY);
	await executor.execute(sql`INSERT INTO revision_entries (id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at)
		VALUES (${randomUUID()}, ${executor.tenantId}, ${executor.currentProjectId}::uuid, 'plan-entry', ${encodePlanEntryRecordKey(entryId)}, ${revision}, ${author}, ${transition.patchFormat}, ${Buffer.from(transition.reversePatch)}, ${encodeRevisionPatchHash(transition.sourceHash)}, ${encodeRevisionPatchHash(transition.targetHash)}, NULL, ${createdAt})`);
}

function toPlanEntryRevisionPatch(row: LedgerRow): PlanEntryRevisionPatch {
	return { revision: row.revision, author: row.author, patchFormat: row.patch_format, reversePatch: row.reverse_patch, sourceHash: decodeRevisionPatchHash(row.source_hash), targetHash: decodeRevisionPatchHash(row.target_hash), createdAt: row.created_at, ...(row.restored_from_revision !== null && { restoredFromRevision: row.restored_from_revision }) };
}

async function allocateShortReference(executor: TenantExecutor, id: string): Promise<string> {
	const baseReference = shortEntityReference({ id, kind: "planEntry" });
	let shortReference = baseReference;
	let suffix = 2;
	while ((await executor.execute(sql`SELECT id FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND short_reference = ${shortReference}`)).rows.length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}
	return shortReference;
}

async function nextPlanEntryCreatedAt(executor: TenantExecutor, planId: string): Promise<string> {
	const result = await executor.execute(sql`SELECT created_at FROM plan_entries WHERE tenant_id = ${executor.tenantId} AND plan_id = ${planId}::uuid ORDER BY created_at DESC, reference DESC LIMIT 1`);
	const latest = result.rows[0] as { created_at: string } | undefined;
	const latestTimestamp = latest ? Date.parse(latest.created_at) : Number.NEGATIVE_INFINITY;
	return new Date(Math.max(Date.now(), latestTimestamp + 1)).toISOString();
}