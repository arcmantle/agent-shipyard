import { randomUUID } from "node:crypto";
import { decodeRevisionPatchHash, encodeRevisionPatchHash } from "../../db/revision-patch-hash.js";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
	applyReversePatch,
	type CanonicalIssueCommentChain,
	collectReachableIds,
	compareCodeCompatibility,
	computeEntityContentHash,
	createReverseFieldPatch,
	encodeEntityRecordKey,
	EntityConflictError,
	EntityRevisionError,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	assignEntitiesToProjects,
	deriveEntityStatuses,
	deriveUserIdentity,
	ENTITY_REVERSE_PATCH_REGISTRY,
	ENTITY_KINDS,
	generateCanonicalIdentity,
	getAllowedRelationType,
	getAllowedRelationTypes,
	getActivePlanReferencedEntityIds,
	getArchiveStatus,
	getCodeCompatibility,
	deriveMigratedEntityIdentity,
	deriveVersionCoverage,
	getInitialStatus,
	isAllowedRelation,
	isBodySource,
	isDirectEntitySelector,
	isEntityCategory,
	isEntityKind,
	isEntityPriority,
	isEntityType,
	isInitiativeComplete,
	isStructuralRelationType,
	isValidStatus,
	materializeFromPatches,
	projectPlanEntries,
	RESERVED_SYSTEM_AUTHOR,
	shortEntityReference,
	SYSTEM_AUTHENTICATION_SUBJECT,
	sanitizePathSegment,
	STRUCTURAL_RELATION_TYPES,
	toEntitySummary,
	wouldOrphanSubtree as wouldOrphanSubtreeInGraph,
	type BodySource,
	type CompletionObservation,
	type ContextDetails,
	type DatabaseSnapshot,
	type DeleteResult,
	type EntityDetails,
	type EntityKind,
	type EntityRecord,
	type EntityRelations,
	type EntitySummary,
	type EntityRevisionPatch,
	type EntityStore,
	type HistoryEntryRecord,
	type InitiativeBundle,
	type InitiativeDetail,
	type InitiativeTab,
	type InitiativeTabData,
	type IssueCommentPage,
	type LinkResult,
	type MaterializedEntityRevision,
	type MoveResult,
	type PlanEntryRecord,
	type ProjectDiscovery,
	type ProjectSummary,
	type ProjectSnapshot,
	type QueryEntitiesInput,
	type QueryEntitiesResult,
	type RelationRecord,
	type RelationType,
	type StatusUpdateResult,
	type UnlinkResult
	,type WorkspaceObservation
} from "@agent-issues/core";
import type { TenantExecutor } from "../../db/connection.js";
import { counters, entities, relations, revisionEntries } from "../../schema.js";

import { queryContextDetails, queryProjectContextDetails } from "../context/context-store.js";
import { PgPlanEntryStore } from "../plan-entry/store.js";
import { exportCanonicalChains } from "../synchronize/canonical-chain-store.js";

const SYSTEM_USER_ID = deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id;

export type EntityRow = {
	id: string;
	reference: string;
	short_reference: string;
	created_by?: string | null;
	updated_by?: string | null;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string | null;
	category?: string | null;
	priority?: string | null;
	type?: string | null;
	revision?: number | null;
	content_hash?: string | null;
	tombstone?: boolean | null;
	project_id: string | null;
	created_at: string;
	updated_at: string;
};

type EntitySummaryRow = Omit<EntityRow, "body" | "body_source">;

const ENTITY_SUMMARY_COLUMNS = sql`entities.id, entities.reference, entities.short_reference, entities.created_by, entities.updated_by, entities.kind, entities.title, entities.status, entities.category, entities.priority, entities.type, entities.revision, entities.content_hash, entities.tombstone, entities.project_id, entities.created_at, entities.updated_at`;

export type RelationRow = {
	from_id: string;
	to_id: string;
	type: string;
	created_by?: string | null;
	created_at: string;
};

/**
 * Seeds a fresh cloud tenant (per-kind id counters + the PROJ0/EPIC0
 * sentinels the full-chain invariant requires, ADR7) so `createEntity` has
 * somewhere to attach a parent-less initiative, exactly like the context
 * feature's `getOrCreateProjectByIdentity` and local's `SqliteStore`
 * bootstrap (`ensureTenantCounters` / `ensureFullChainInvariant` in core's
 * `database.ts`). No legacy-data import or backup step applies here: a
 * cloud tenant starts empty.
 */
export async function ensurePgTenant(executor: TenantExecutor): Promise<void> {
	for (const kind of ENTITY_KINDS) {
		await executor.insert(counters).values({ tenantId: executor.tenantId, kind, nextValue: 1 }).onConflictDoNothing();
	}

	const now = new Date().toISOString();
	const projectIdentity = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID);
	const epicIdentity = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID);
	await executor
		.insert(entities)
		.values({
			tenantId: executor.tenantId,
			id: projectIdentity.stableId,
			reference: projectIdentity.reference,
			shortReference: shortEntityReference({ id: projectIdentity.stableId, kind: "project" }),
			kind: "project",
			title: DEFAULT_PROJECT_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_PROJECT_TITLE, ""),
			projectId: projectIdentity.stableId,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await executor
		.insert(entities)
		.values({
			tenantId: executor.tenantId,
			id: epicIdentity.stableId,
			reference: epicIdentity.reference,
			shortReference: shortEntityReference({ id: epicIdentity.stableId, kind: "epic" }),
			kind: "epic",
			title: DEFAULT_EPIC_TITLE,
			status: "active",
			body: "",
			bodySource: "generated",
			revision: 1,
			contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
			projectId: projectIdentity.stableId,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await executor
		.insert(relations)
		.values({ tenantId: executor.tenantId, fromId: projectIdentity.stableId, toId: epicIdentity.stableId, type: "contains", createdAt: now })
		.onConflictDoNothing();
}

/**
 * Every live project in this tenant whose title normalizes to
 * `normalizedTitle`, mirroring local's `findProjectsByNormalizedTitle`. The
 * comparison is normalized rather than exact so `"My Project"` and
 * `"my-project"` name the same project on both drivers - the CLI derives an
 * identity from a repo/folder name, which differs in case and separators from
 * whatever title a human typed.
 */
async function findProjectsByNormalizedTitle(
	executor: TenantExecutor,
	normalizedTitle: string
): Promise<Array<{ id: string; title: string }>> {
	const rows = await executor
		.select({ id: entities.id, title: entities.title })
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.kind, "project"), eq(entities.tombstone, false)))
		.orderBy(asc(entities.id));
	return rows.filter((project) => sanitizePathSegment(project.title) === normalizedTitle);
}

/**
 * The `project` entity this tenant already minted for a executor-resolved
 * `projectIdentity`, or a freshly minted one plus its own epic the first time
 * a request for that identity arrives - `ensurePgTenant`'s
 * project+epic+contains seeding, just per-identity rather than once per
 * tenant. The epic is what keeps ADR7's full-chain invariant true: without it
 * a parent-less initiative created for this identity would attach to the
 * sentinel `EPIC0` and land in Default Project instead.
 *
 * Resolution order mirrors local's `resolveCurrentProjectId` exactly: a
 * direct selector (stable id or Canonical reference) first, then a normalized
 * title match, then registration. Two projects normalizing to the same title
 * is ambiguous and refuses to guess.
 *
 * Shared by the context path and by `resolveProjectIdForWrite`, so a
 * workspace's entities and its glossary always agree on which project they
 * belong to.
 *
 * The advisory lock is transaction-scoped (ADR9 gives every store method
 * exactly one transaction) and keyed by tenant + identity, so two concurrent
 * first-touch requests for the same new workspace take turns instead of both
 * inserting: a duplicate title would make the identity permanently ambiguous,
 * which is worse than either request simply waiting.
 */
export async function getOrCreateProjectByIdentity(
	executor: TenantExecutor,
	projectIdentity: string
): Promise<EntityRecord> {
	// Taken before `ensurePgTenant`, so the whole seed-then-check-then-create
	// sequence is inside the lock rather than only its tail.
	await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${executor.tenantId}), hashtext(${projectIdentity}))`);
	await ensurePgTenant(executor);

	const [direct] = await executor
		.select({ id: entities.id })
		.from(entities)
		.where(
			and(
				eq(entities.tenantId, executor.tenantId),
				eq(entities.kind, "project"),
				eq(entities.tombstone, false),
				// `id::text` rather than `eq(entities.id, ...)`: the column is a
				// uuid, and a repository-style identity like "my-repo" makes
				// Postgres fail the comparison outright (22P02) instead of simply
				// not matching the way SQLite's untyped column does.
				sql`(${entities.id}::text = ${projectIdentity} OR ${entities.reference} = ${projectIdentity})`
			)
		)
		.limit(1);
	if (direct) {
		return getEntityOrThrow(executor, direct.id);
	}

	const matching = await findProjectsByNormalizedTitle(executor, sanitizePathSegment(projectIdentity));
	if (matching.length > 1) {
		throw new Error(`Ambiguous project identity "${projectIdentity}" in tenant ${executor.tenantId}.`);
	}
	if (matching.length === 1) {
		return getEntityOrThrow(executor, matching[0]!.id);
	}
	if (isDirectEntitySelector(projectIdentity)) {
		throw new Error(`Cannot resolve project identity "${projectIdentity}" in tenant ${executor.tenantId}.`);
	}

	const now = new Date().toISOString();
	const project = generateCanonicalIdentity("project");
	const epic = generateCanonicalIdentity("epic");

	await executor.insert(entities).values({
		tenantId: executor.tenantId,
		id: project.stableId,
		reference: project.reference,
		shortReference: await allocateShortReference(executor, "project", project.stableId),
		kind: "project",
		title: projectIdentity,
		status: "active",
		body: "",
		bodySource: "generated",
		revision: 1,
		contentHash: computeEntityContentHash(projectIdentity, ""),
		// A project owns itself, so project-scoped reads and its own revision
		// ledger (which rejects a null `project_id`) both resolve.
		projectId: project.stableId,
		createdAt: now,
		updatedAt: now
	});
	await executor.insert(entities).values({
		tenantId: executor.tenantId,
		id: epic.stableId,
		reference: epic.reference,
		shortReference: await allocateShortReference(executor, "epic", epic.stableId),
		kind: "epic",
		title: DEFAULT_EPIC_TITLE,
		status: "active",
		body: "",
		bodySource: "generated",
		revision: 1,
		contentHash: computeEntityContentHash(DEFAULT_EPIC_TITLE, ""),
		projectId: project.stableId,
		createdAt: now,
		updatedAt: now
	});
	await executor
		.insert(relations)
		.values({ tenantId: executor.tenantId, fromId: project.stableId, toId: epic.stableId, type: "contains", createdAt: now })
		.onConflictDoNothing();

	return getEntityOrThrow(executor, project.stableId);
}

export function mapEntityRow(row: EntityRow): EntityRecord {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Unexpected entity kind in database: ${row.kind}`);
	}

	const bodySource = row.body_source;

	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		createdBy: row.created_by ?? RESERVED_SYSTEM_AUTHOR,
		updatedBy: row.updated_by ?? RESERVED_SYSTEM_AUTHOR,
		kind: row.kind,
		title: row.title,
		status: row.status,
		body: row.body ?? "",
		bodySource: bodySource && isBodySource(bodySource) ? bodySource : "authored",
		category: row.category && isEntityCategory(row.category) ? row.category : null,
		priority: row.priority && isEntityPriority(row.priority) ? row.priority : null,
		type: row.type && isEntityType(row.kind, row.type) ? row.type : null,
		revision: row.revision ?? 1,
		contentHash: row.content_hash ?? "",
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function mapDrizzleEntityRow(row: typeof entities.$inferSelect): EntityRecord {
	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.shortReference,
		createdBy: row.createdBy ?? RESERVED_SYSTEM_AUTHOR,
		updatedBy: row.updatedBy ?? RESERVED_SYSTEM_AUTHOR,
		kind: row.kind as EntityKind,
		title: row.title,
		status: row.status,
		body: row.body,
		bodySource: isBodySource(row.bodySource) ? row.bodySource : "authored",
		category: row.category && isEntityCategory(row.category) ? row.category : null,
		priority: row.priority && isEntityPriority(row.priority) ? row.priority : null,
		type: row.type && isEntityType(row.kind as EntityKind, row.type) ? row.type : null,
		revision: row.revision ?? 1,
		contentHash: row.contentHash ?? "",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export async function getEntityOrThrow(executor: TenantExecutor, entityId: string): Promise<EntityRecord> {
	const row = await resolveEntity(executor, entityId);
	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapDrizzleEntityRow(row);
}

async function getProjectEntityOrThrow(executor: TenantExecutor, entityId: string): Promise<EntityRecord> {
	const row = await resolveEntity(executor, entityId, false, executor.currentProjectId);
	if (!row) {
		throw new Error(`Entity not found: ${entityId}`);
	}

	return mapDrizzleEntityRow(row);
}

async function resolveEntity(
	executor: TenantExecutor,
	entityId: string,
	includeTombstone: boolean = false,
	projectId?: string
): Promise<typeof entities.$inferSelect | undefined> {
	const rows = await resolveEntities(executor, entityId, includeTombstone, projectId);
	if (rows.length > 1) {
		throw new Error(`Ambiguous short entity reference: ${entityId}. Use one of: ${rows.map((row) => row.reference).join(", ")}`);
	}
	return rows[0];
}

async function resolveEntities(
	executor: TenantExecutor,
	entityId: string,
	includeTombstone: boolean = false,
	projectId?: string
): Promise<Array<typeof entities.$inferSelect>> {
	const livePredicate = includeTombstone ? undefined : eq(entities.tombstone, false);
	const projectPredicate = projectId ? eq(entities.projectId, projectId) : undefined;
	let row: typeof entities.$inferSelect | undefined;
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)) {
		[row] = await executor
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entityId), projectPredicate, livePredicate));
	} else {
		[row] = await executor
			.select()
			.from(entities)
			.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.reference, entityId), projectPredicate, livePredicate));
	}

	if (row) {
		return [row];
	}

	return executor
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.shortReference, entityId), projectPredicate, livePredicate));
}

async function allocateShortReference(executor: TenantExecutor, kind: string, id: string): Promise<string> {
	const baseReference = shortEntityReference({ id, kind });
	let shortReference = baseReference;
	let suffix = 2;

	while ((await executor
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.shortReference, shortReference)))
		.limit(1)).length > 0) {
		shortReference = `${baseReference}-${suffix}`;
		suffix += 1;
	}

	return shortReference;
}

async function getStructuralParentRelations(executor: TenantExecutor, entityId: string): Promise<RelationRecord[]> {
	const result = await executor.execute(sql`
		SELECT relations.* FROM relations
		JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId} AND relations.to_id = ${entityId} AND source.tombstone = false
		ORDER BY relations.created_at, relations.from_id, relations.type
	`);
	const rows = result.rows as RelationRow[];

	return rows
		.filter((row) => isStructuralRelationType(row.type))
		.map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdBy: row.created_by ?? SYSTEM_USER_ID, createdAt: row.created_at }));
}

// Walks structural-only parent relations up to the root, mirroring core's
// store.ts getStructuralPath, so handoffs can resolve their owning
// initiative the same way locally and in the cloud.
async function getStructuralPath(
	executor: TenantExecutor,
	entityId: string
): Promise<Array<{ relationType: RelationType; entity: EntityRecord }>> {
	const path: Array<{ relationType: RelationType; entity: EntityRecord }> = [];
	const seen = new Set<string>([entityId]);
	let currentId = entityId;

	while (true) {
		const parents = await getStructuralParentRelations(executor, currentId);

		if (parents.length === 0) {
			return path.reverse();
		}

		if (parents.length > 1) {
			throw new Error(`Cannot build structural path for ${entityId} because ${currentId} has multiple structural parents.`);
		}

		const parent = parents[0]!;
		if (seen.has(parent.fromId)) {
			throw new Error(`Cannot build structural path for ${entityId} because the structural graph contains a cycle.`);
		}

		seen.add(parent.fromId);
		path.push({ relationType: parent.type, entity: await getEntityOrThrow(executor, parent.fromId) });
		currentId = parent.fromId;
	}
}

async function getRelatedPlanEntries(executor: TenantExecutor, issueId: string): Promise<PlanEntryRecord[]> {
	const result = await executor.execute(sql`SELECT DISTINCT plan_entries.plan_id
		FROM plan_entries
		JOIN plan_entry_references ON plan_entry_references.tenant_id = plan_entries.tenant_id AND plan_entry_references.plan_entry_id = plan_entries.id
		JOIN entities AS plans ON plans.tenant_id = plan_entries.tenant_id AND plans.id = plan_entries.plan_id
		WHERE plan_entries.tenant_id = ${executor.tenantId}
			AND plan_entry_references.entity_id = ${issueId}::uuid
			AND plans.project_id = ${executor.currentProjectId}::uuid
			AND plans.kind = 'plan'
			AND plans.tombstone = FALSE
		ORDER BY plan_entries.plan_id`);
	const planStore = new PgPlanEntryStore(executor);
	const entries = await Promise.all((result.rows as Array<{ plan_id: string }>).map(({ plan_id }) => planStore.listPlanEntries({ planId: plan_id })));

	return entries.flat().filter((entry) => entry.referencedEntityIds.includes(issueId));
}

export async function nextEntityId(_client: TenantExecutor, kind: EntityKind): Promise<string> {
	return generateCanonicalIdentity(kind).reference;
}

// Appends a reverse-patch entry (ADR55/ISS257) mirroring appendDeltaEntry in
// core's store.ts. Records the predecessor title/body so ISS261's history
// materializer can walk back from the current head one step at a time.
async function appendDeltaEntry(
	executor: TenantExecutor,
	entityId: string,
	newRevision: number,
	priorTitle: string,
	priorBody: string,
	priorBodySource: string,
	author: string | undefined,
	createdAt: string,
	lifecycle: { priorStatus?: string; priorParentId?: string | null; priorTombstone?: boolean | null; priorCategory?: EntityRecord["category"]; priorPriority?: EntityRecord["priority"]; priorType?: EntityRecord["type"]; restoredFromRevision?: number } = {}
): Promise<void> {
	const [row] = await executor.select().from(entities).where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entityId)));
	if (!row) {
		throw new Error(`Cannot append reverse patch for missing entity ${entityId}.`);
	}
	const successor = {
		title: row.title,
		body: row.body,
		bodySource: row.bodySource,
		category: row.category,
		priority: row.priority,
		type: row.type,
		status: row.status,
		parentId: (await getStructuralParentRelations(executor, entityId))[0]?.fromId ?? null,
		tombstone: row.tombstone
	};
	const predecessor = {
		...successor,
		title: priorTitle,
		body: priorBody,
		bodySource: priorBodySource,
		...(lifecycle.priorStatus !== undefined && { status: lifecycle.priorStatus }),
		...(Object.hasOwn(lifecycle, "priorParentId") && { parentId: lifecycle.priorParentId ?? null }),
		...(Object.hasOwn(lifecycle, "priorCategory") && { category: lifecycle.priorCategory ?? null }),
		...(Object.hasOwn(lifecycle, "priorPriority") && { priority: lifecycle.priorPriority ?? null }),
		...(Object.hasOwn(lifecycle, "priorType") && { type: lifecycle.priorType ?? null }),
		...(lifecycle.priorTombstone != null && { tombstone: lifecycle.priorTombstone })
	};
	const transition = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
	if (!row.projectId) throw new Error(`Cannot append reverse patch for entity ${entityId} without a project.`);
	await executor.insert(revisionEntries).values({ id: randomUUID(), tenantId: executor.tenantId, projectId: row.projectId, recordKind: "entity", recordKey: encodeEntityRecordKey(row.id), revision: newRevision, author: author?.trim() || RESERVED_SYSTEM_AUTHOR, patchFormat: transition.patchFormat, reversePatch: Buffer.from(transition.reversePatch), sourceHash: encodeRevisionPatchHash(transition.sourceHash), targetHash: encodeRevisionPatchHash(transition.targetHash), restoredFromRevision: lifecycle.restoredFromRevision ?? null, createdAt });
}

/**
 * The project every project-scoped read below filters by - the cloud
 * counterpart of local's `db.currentProjectId`, which `ensureDatabase` fills
 * in at open. `PgStore.transaction()` resolves this once per store lifetime
 * and assigns the plain string onto the executor before any of the functions
 * below run, so they read `executor.currentProjectId` directly rather than
 * resolving or memoizing it themselves.
 *
 * Resolution mirrors local's `resolveCurrentProjectId`: a carried identity
 * registers itself on first use, and a tenant with no identity and more than
 * one project refuses to guess which one the caller meant rather than
 * silently blending them.
 */
export async function resolveCurrentProjectId(executor: TenantExecutor, projectIdentity: string | undefined): Promise<string> {
	const selector = projectIdentity?.trim();
	if (selector) {
		return (await getOrCreateProjectByIdentity(executor, selector)).id;
	}

	// No identity resolves to the `PROJ0` sentinel rather than local's literal
	// "refuse when the tenant has more than one project". That refusal is
	// reachable in local only by opening a database that ALREADY holds several
	// projects without saying which you mean; every ordinary local session
	// resolves at open, when the sentinel is the only project, and then keeps
	// it for the session. Cloud has no equivalent open-once moment - the gate
	// builds a fresh store per request - so copying the refusal literally would
	// make an unidentified caller start failing the moment a second project
	// appeared, which is not what the same caller experiences locally.
	await ensurePgTenant(executor);
	return deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
}

/**
 * Runs `fn` with the current project pinned to `projectId`, restoring whatever
 * was resolved before. Mirrors local's `getDatabaseSnapshot` swapping
 * `db.currentProjectId`: it lets an explicitly-selected project reuse the same
 * project-scoped read path instead of needing a parallel set of queries.
 *
 * Save-and-restore around a mutable field only holds for one pin at a time, so
 * this must not be nested or run concurrently with itself on the same executor -
 * two overlapping pins would restore each other's value. There is exactly one
 * call site (`getDatabaseSnapshot` with an explicit project), and nothing it
 * calls pins again.
 */
async function withCurrentProject<T>(executor: TenantExecutor, projectId: string, fn: () => Promise<T>): Promise<T> {
	const previous = executor.currentProjectId;
	executor.currentProjectId = projectId;
	try {
		return await fn();
	} finally {
		executor.currentProjectId = previous;
	}
}

async function getAllEntities(executor: TenantExecutor): Promise<EntityRecord[]> {
	const projectId = executor.currentProjectId;
	const rows = await executor
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.projectId, projectId), eq(entities.tombstone, false)));
	return rows.map(mapDrizzleEntityRow);
}

async function getAllEntitySummaries(executor: TenantExecutor): Promise<EntitySummary[]> {
	const result = await executor.execute(sql`
		SELECT ${ENTITY_SUMMARY_COLUMNS} FROM entities
		WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND tombstone = false
		ORDER BY id
	`);
	return (result.rows as EntitySummaryRow[]).map(mapEntitySummaryRow);
}

async function getAllRelations(executor: TenantExecutor): Promise<RelationRecord[]> {
	const projectId = executor.currentProjectId;
	const result = await executor.execute(sql`
		SELECT relations.* FROM relations
		JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
		JOIN entities AS target ON target.tenant_id = relations.tenant_id AND target.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND source.project_id = ${projectId}
			AND target.project_id = ${projectId}
			AND source.tombstone = false
			AND target.tombstone = false
		ORDER BY relations.from_id, relations.to_id, relations.type
	`);
	return (result.rows as RelationRow[]).map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdBy: row.created_by ?? SYSTEM_USER_ID,
		createdAt: row.created_at
	}));
}

/** Tenant-wide reads, for the callers that legitimately span every project: project discovery and whole-tenant synchronize. Mirrors local's `getTenantEntities`/`getTenantRelations`. */
async function getTenantEntities(executor: TenantExecutor): Promise<EntityRecord[]> {
	const rows = await executor.select().from(entities).where(and(eq(entities.tenantId, executor.tenantId), eq(entities.tombstone, false)));
	return rows.map(mapDrizzleEntityRow);
}

async function getTenantRelations(executor: TenantExecutor): Promise<RelationRecord[]> {
	const result = await executor.execute(sql`
		SELECT relations.* FROM relations
		JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
		JOIN entities AS target ON target.tenant_id = relations.tenant_id AND target.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND source.tombstone = false
			AND target.tombstone = false
		ORDER BY relations.from_id, relations.to_id, relations.type
	`);
	return (result.rows as RelationRow[]).map((row) => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType, createdBy: row.created_by ?? SYSTEM_USER_ID, createdAt: row.created_at }));
}

async function getDerivedStatusMap(executor: TenantExecutor, rootIds?: string[]): Promise<Map<string, string>> {
	if (rootIds?.length === 0) {
		return new Map();
	}
	const result = rootIds
		? await executor.execute(sql`
			WITH RECURSIVE status_entities AS (
				SELECT id, kind, status
				FROM entities
				WHERE tenant_id = ${executor.tenantId}
					AND project_id = ${executor.currentProjectId}
					AND tombstone = false
					AND id IN ${rootIds}
				UNION
				SELECT dependency.id, dependency.kind, dependency.status
				FROM status_entities AS current
				JOIN relations AS dependency_relation ON dependency_relation.tenant_id = ${executor.tenantId}
				JOIN entities AS dependency ON dependency.tenant_id = dependency_relation.tenant_id
					AND dependency.project_id = ${executor.currentProjectId}
					AND dependency.tombstone = false
					AND (
						(current.kind = 'issue' AND dependency_relation.type = 'decomposes' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'userStory' AND dependency_relation.type = 'fixes' AND dependency_relation.to_id = current.id AND dependency.id = dependency_relation.from_id)
						OR (current.kind = 'prd' AND dependency_relation.type = 'creates' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'initiative' AND dependency_relation.type IN ('tracks', 'owns') AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (current.kind = 'adr' AND dependency_relation.type = 'constrains' AND dependency_relation.from_id = current.id AND dependency.id = dependency_relation.to_id)
						OR (dependency_relation.type = 'supersedes' AND dependency_relation.to_id = current.id AND dependency.id = dependency_relation.from_id AND dependency.kind = current.kind)
					)
			)
			SELECT id, kind, status FROM status_entities
		`)
		: await executor.execute(sql`
			SELECT id, kind, status FROM entities
			WHERE tenant_id = ${executor.tenantId}
				AND project_id = ${executor.currentProjectId}
				AND tombstone = false
		`);
	const statusEntities = (result.rows as Array<{ id: string; kind: string; status: string }>).map((row) => ({
		id: row.id,
		reference: "",
		shortReference: "",
		createdBy: RESERVED_SYSTEM_AUTHOR,
		updatedBy: RESERVED_SYSTEM_AUTHOR,
		kind: row.kind as EntityKind,
		title: "",
		status: row.status,
		body: "",
		bodySource: "authored" as const,
		category: null,
		priority: null,
		type: null,
		revision: 1,
		contentHash: "",
		createdAt: "",
		updatedAt: ""
	}));
	const statusEntityIds = statusEntities.map((entity) => entity.id);
	const relationRows = rootIds
		? await executor
			.select()
			.from(relations)
			.where(and(
				eq(relations.tenantId, executor.tenantId),
				inArray(relations.fromId, statusEntityIds),
				inArray(relations.toId, statusEntityIds)
			))
		: undefined;
	const statusRelations = relationRows
		? relationRows.map((row) => ({ fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdBy: row.createdBy ?? SYSTEM_USER_ID, createdAt: row.createdAt }))
		: await getAllRelations(executor);
	const entities = deriveEntityStatuses(statusEntities, statusRelations);
	return new Map(entities.map((entity) => [entity.id, entity.status]));
}

function applyDerivedStatus<T extends EntitySummary>(entity: T, statusMap: ReadonlyMap<string, string>): T {
	const derived = statusMap.get(entity.id);
	return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
}

async function getRelationOrThrow(
	executor: TenantExecutor,
	input: { fromId: string; toId: string; relationType: string }
): Promise<RelationRecord> {
	const [row] = await executor
		.select()
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, executor.tenantId),
				eq(relations.fromId, input.fromId),
				eq(relations.toId, input.toId),
				eq(relations.type, input.relationType)
			)
		);

	if (!row) {
		throw new Error(`Relation not found: ${input.fromId} -> ${input.toId} as ${input.relationType}`);
	}

	return { fromId: row.fromId, toId: row.toId, type: row.type as RelationType, createdBy: row.createdBy ?? SYSTEM_USER_ID, createdAt: row.createdAt };
}

async function insertRelation(executor: TenantExecutor, relation: RelationRecord): Promise<{ inserted: boolean }> {
	const inserted = await executor
		.insert(relations)
		.values({ tenantId: executor.tenantId, fromId: relation.fromId, toId: relation.toId, type: relation.type, createdBy: relation.createdBy ?? SYSTEM_USER_ID, createdAt: relation.createdAt })
		.onConflictDoNothing()
		.returning({ fromId: relations.fromId });

	return { inserted: inserted.length > 0 };
}

// Reconciles `entityId`'s structural parent relation to `newParentId` (see
// core's `reconcileStructuralParent` for the full rationale).
async function reconcileStructuralParent(
	executor: TenantExecutor,
	entityId: string,
	kind: EntityKind,
	newParentId: string | null
): Promise<void> {
	const currentParents = await getStructuralParentRelations(executor, entityId);
	const currentParentId = currentParents[0]?.fromId ?? null;

	if (currentParentId === newParentId) {
		return;
	}

	for (const relation of currentParents) {
		await executor
			.delete(relations)
			.where(
				and(
					eq(relations.tenantId, executor.tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, entityId),
					eq(relations.type, relation.type)
				)
			);
	}

	if (!newParentId) {
		return;
	}

	const parent = await getEntityOrThrow(executor, newParentId);
	const relationType = getAllowedRelationType(parent.kind, kind);
	if (!relationType) {
		throw new Error(`Cannot resolve ${entityId} under ${parent.kind} via synchronize: no allowed relation from ${parent.kind} to ${kind}.`);
	}

	await insertRelation(executor, { fromId: parent.id, toId: entityId, type: relationType, createdBy: SYSTEM_USER_ID, createdAt: new Date().toISOString() });
}

async function hasTypedPath(executor: TenantExecutor, startId: string, targetId: string, relationType: string): Promise<boolean> {
	const relations = (await getAllRelations(executor)).filter((relation) => relation.type === relationType);
	return collectReachableIds(relations, startId).has(targetId);
}

async function hasStructuralPath(executor: TenantExecutor, startId: string, targetId: string): Promise<boolean> {
	const relations = (await getAllRelations(executor)).filter((relation) => isStructuralRelationType(relation.type));
	return collectReachableIds(relations, startId).has(targetId);
}

async function wouldOrphanSubtree(executor: TenantExecutor, relation: RelationRecord): Promise<boolean> {
	const [relations, entities] = await Promise.all([getAllRelations(executor), getAllEntities(executor)]);
	return wouldOrphanSubtreeInGraph(entities, relations, relation);
}

// Mirrors `wouldBreakFullChainInvariant` in core's `store.ts`: blocks
// unlinking a "contains" relation that is the sole remaining structural
// parent of an epic or initiative (ADR7's full-chain invariant).
async function wouldBreakFullChainInvariant(executor: TenantExecutor, relation: RelationRecord): Promise<boolean> {
	if (relation.type !== "contains") {
		return false;
	}

	const target = await getEntityOrThrow(executor, relation.toId);
	if (target.kind !== "epic" && target.kind !== "initiative") {
		return false;
	}

	const [result] = await executor
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(
			and(
				eq(relations.tenantId, executor.tenantId),
				eq(relations.toId, relation.toId),
				eq(relations.type, "contains"),
				sql`${relations.fromId} <> ${relation.fromId}`
			)
		);

	return Number(result?.count ?? 0) === 0;
}

async function getActiveBlockingIssues(executor: TenantExecutor, entityId: string): Promise<EntityRecord[]> {
	const result = await executor.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.type = 'blocks'
			AND relations.to_id = ${entityId}
			AND entities.tombstone = false
			AND entities.status != 'done'
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[]).map(mapEntityRow);
}

async function getOpenSubIssues(executor: TenantExecutor, issueId: string): Promise<EntityRecord[]> {
	const statusMap = await getDerivedStatusMap(executor);
	const result = await executor.execute(sql`
		SELECT entities.*
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.from_id = ${issueId}
			AND relations.type = 'decomposes'
			AND entities.tombstone = false
		ORDER BY entities.id
	`);

	return (result.rows as EntityRow[])
		.map(mapEntityRow)
		.map((entity) => applyDerivedStatus(entity, statusMap))
		.filter((entity) => entity.status !== "done" && entity.status !== "deferred");
}

async function getFixingIssueStatuses(executor: TenantExecutor, storyId: string): Promise<string[]> {
	const result = await executor.execute(sql`
		SELECT entities.status
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.type = 'fixes'
			AND relations.to_id = ${storyId}
			AND entities.kind = 'issue'
			AND entities.tombstone = false
	`);
	return (result.rows as Array<{ status: string }>).map((row) => row.status);
}

async function getCreatedStoryStatuses(executor: TenantExecutor, prdId: string): Promise<string[]> {
	const statusMap = await getDerivedStatusMap(executor);
	const result = await executor.execute(sql`
		SELECT entities.id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.type = 'creates'
			AND relations.from_id = ${prdId}
			AND entities.kind = 'userStory'
			AND entities.tombstone = false
	`);

	return (result.rows as Array<{ id: string }>).map((row) => statusMap.get(row.id) ?? "");
}

async function getSupersedingEntityId(
	executor: TenantExecutor,
	entityId: string,
	kind: "prd" | "userStory" | "adr"
): Promise<string | undefined> {
	const result = await executor.execute(sql`
		SELECT entities.id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.type = 'supersedes'
			AND relations.to_id = ${entityId}
			AND entities.kind = ${kind}
			AND entities.tombstone = false
		LIMIT 1
	`);

	return (result.rows[0] as { id: string } | undefined)?.id;
}

async function getInitiativeChildStatuses(
	executor: TenantExecutor,
	initiativeId: string
): Promise<{ trackedIssueStatuses: string[]; ownedPrdStatuses: string[] }> {
	const statusMap = await getDerivedStatusMap(executor);
	const structuralRelations = (await getAllRelations(executor)).filter((relation) => isStructuralRelationType(relation.type));
	const reachableIds = collectReachableIds(structuralRelations, initiativeId);
	reachableIds.delete(initiativeId);
	const entities = await getAllEntities(executor);

	return {
		trackedIssueStatuses: entities
			.filter((entity) => entity.kind === "issue" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? ""),
		ownedPrdStatuses: entities
			.filter((entity) => entity.kind === "prd" && reachableIds.has(entity.id))
			.map((entity) => statusMap.get(entity.id) ?? "")
	};
}

async function getAllDerivedEntities(executor: TenantExecutor): Promise<EntityRecord[]> {
	return deriveEntityStatuses(await getAllEntities(executor), await getAllRelations(executor));
}

export async function createEntity(
	executor: TenantExecutor,
	input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		category?: string;
		priority?: string;
		type?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	},
	projectIdentity?: string,
	actorId: string = SYSTEM_USER_ID
): Promise<EntityRecord> {
	if (!isEntityKind(input.kind)) {
		throw new Error(`Unknown entity kind: ${input.kind}`);
	}

	const kind = input.kind;
	const title = input.title.trim();
	if (title.length === 0) {
		throw new Error("Entity title must not be empty.");
	}
	const body = input.body ?? "";
	const bodySource: BodySource = "authored";
	const requestedStatus = input.status ?? getInitialStatus(kind);
	const status = kind === "plan" ? getInitialStatus(kind) : requestedStatus;
	const category = input.category;
	const priority = input.priority;
	const entityType = input.type ?? null;

	if (!isValidStatus(kind, requestedStatus)) {
		throw new Error(`Invalid status for ${kind}: ${requestedStatus}`);
	}
	if (category !== undefined && !isEntityCategory(category)) {
		throw new Error(`Invalid entity category: ${category}`);
	}
	if (priority !== undefined && !isEntityPriority(priority)) {
		throw new Error(`Invalid entity priority: ${priority}`);
	}
	if (entityType !== null && !isEntityType(kind, entityType)) {
		throw new Error(`Invalid entity type: ${entityType}`);
	}
	if (kind === "debt" && (category === undefined || priority === undefined)) {
		throw new Error("Debt requires category and priority.");
	}

	// Idempotent (ON CONFLICT DO NOTHING); simplifies this slice by not
	// requiring a separate tenant-bootstrap lifecycle step. SqliteStore
	// bootstraps once at open() instead - worth converging on later.
	await ensurePgTenant(executor);

	const now = new Date().toISOString();
	const parentId = input.parentId ?? (kind === "initiative" ? await resolveDefaultEpicId(executor, projectIdentity) : undefined);
	const parent = parentId ? await getEntityOrThrow(executor, parentId) : null;
	const relationType = parent ? getAllowedRelationType(parent.kind, kind) : null;
	if (kind === "debt" && !parent) {
		throw new Error("Debt requires a project, epic, initiative, or issue owner.");
	}
	if (kind === "plan" && parent?.kind !== "initiative") {
		throw new Error("Plan requires an initiative parent.");
	}

	if (parent && !relationType) {
		throw new Error(`Cannot create ${kind} under ${parent.kind}.`);
	}
	if (entityType === "pioneer-map" && parent?.kind !== "initiative") {
		throw new Error("pioneer-map requires an initiative parent.");
	}
	if (entityType === "pioneer-ticket" && (parent?.kind !== "issue" || parent.type !== "pioneer-map")) {
		throw new Error("pioneer-ticket requires a pioneer-map parent.");
	}

	const identity = generateCanonicalIdentity(kind);
	const id = identity.stableId;
	const shortReference = await allocateShortReference(executor, kind, id);
	// Resolved lazily per branch rather than up front: a project owns itself,
	// and asking `resolveProjectIdForWrite` for its owning project would mint a
	// second project under the same identity before this one is even inserted.
	// A parent predating the project backfill can still carry a null
	// `project_id`, so that case falls through to the request's own project
	// (matching local) rather than inserting a null the revision ledger rejects.
	const projectId =
		kind === "project"
			? id
			: ((parent ? await getEntityProjectId(executor, parent.id) : null) ??
				(await resolveProjectIdForWrite(executor, projectIdentity)));
	const contentHash = computeEntityContentHash(title, body);
	await executor.insert(entities).values({
		tenantId: executor.tenantId,
		id,
		reference: identity.reference,
		shortReference,
		createdBy: actorId,
		updatedBy: actorId,
		kind,
		title,
		status,
		body,
		bodySource,
		category: category ?? null,
		priority: priority ?? null,
		type: entityType,
		revision: 1,
		contentHash,
		projectId,
		createdAt: now,
		updatedAt: now
	});

	if (parent && relationType) {
		await executor
			.insert(relations)
			.values({ tenantId: executor.tenantId, fromId: parent.id, toId: id, type: relationType, createdAt: now })
			.onConflictDoNothing();
	}

	for (const link of input.links ?? []) {
		await linkEntities(executor, { fromId: identity.stableId, relationType: link.relationType, toId: link.targetId });
	}

	// Write the baseline revision-1 entry: a no-op patch (predecessor ==
	// successor) so listEntityHistory always has a real revision_entries row
	// for every revision in the chain, including the initial one.
	await appendDeltaEntry(executor, id, 1, title, body, bodySource, actorId, now);

	return getEntityOrThrow(executor, id);
}

export async function getEntityDetails(executor: TenantExecutor, entityId: string, projectScoped: boolean = false): Promise<EntityDetails> {
	const entity = await getEntityOrThrow(executor, entityId);
	const incomingProjectFilter = projectScoped
		? sql`AND (entities.project_id = ${executor.currentProjectId} OR (entities.id = ${executor.currentProjectId} AND relations.type IN ${STRUCTURAL_RELATION_TYPES}))`
		: sql``;
	const outgoingProjectFilter = projectScoped ? sql`AND entities.project_id = ${executor.currentProjectId}` : sql``;

	const incomingResult = await executor.execute(sql`
		SELECT relations.type AS relation_type, ${ENTITY_SUMMARY_COLUMNS}
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId} AND relations.to_id = ${entity.id}
			${incomingProjectFilter}
			AND entities.tombstone = false
		ORDER BY entities.id
	`);
	const outgoingResult = await executor.execute(sql`
		SELECT relations.type AS relation_type, ${ENTITY_SUMMARY_COLUMNS}
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId} AND relations.from_id = ${entity.id}
			${outgoingProjectFilter}
			AND entities.tombstone = false
		ORDER BY entities.id
	`);

	const statusMap = await getDerivedStatusMap(executor);
	const completionObservations = entity.kind === "issue" ? await listCompletionObservations(executor, entity.id) : [];
	const activePlanIssueIds = entity.kind === "plan"
		? (await Promise.all(
			getActivePlanReferencedEntityIds(await new PgPlanEntryStore(executor).listPlanEntries({ planId: entity.id }))
				.map(async (entityId) => {
					const referencedEntity = await getEntityOrThrow(executor, entityId);
					return referencedEntity.kind === "issue" ? referencedEntity.id : undefined;
				})
		)).filter((issueId): issueId is string => issueId !== undefined)
		: [];
	const versionCoverage = deriveVersionCoverage((await Promise.all(activePlanIssueIds.map((issueId) => listCompletionObservations(executor, issueId)))).flat());

	return {
		entity: applyDerivedStatus(entity, statusMap),
		incoming: (incomingResult.rows as Array<EntityRow & { relation_type: string }>).map((row) => ({
			relationType: row.relation_type as RelationType,
			entity: applyDerivedStatus(mapEntitySummaryRow(row), statusMap)
		})),
		outgoing: (outgoingResult.rows as Array<EntityRow & { relation_type: string }>).map((row) => ({
			relationType: row.relation_type as RelationType,
			entity: applyDerivedStatus(mapEntitySummaryRow(row), statusMap)
		})),
		planEntries: entity.kind === "issue" ? await getRelatedPlanEntries(executor, entity.id) : [],
		completionObservations,
		currentCompletionObservation: completionObservations.at(-1) ?? null,
		versionCoverage
	};
}

export async function queryEntityRelations(
	executor: TenantExecutor,
	input: { entityId: string; direction?: "incoming" | "outgoing" | "both"; types?: RelationType[] },
	projectScoped: boolean = false
): Promise<EntityRelations> {
	const entity = await getProjectEntityOrThrow(executor, input.entityId);
	const incomingProjectFilter = projectScoped
		? sql`AND (entities.project_id = ${executor.currentProjectId} OR (entities.id = ${executor.currentProjectId} AND relations.type IN ${STRUCTURAL_RELATION_TYPES}))`
		: sql``;
	const outgoingProjectFilter = projectScoped ? sql`AND entities.project_id = ${executor.currentProjectId}` : sql``;
	const typeFilter = input.types?.length ? sql`AND relations.type IN ${input.types}` : sql``;
	const includeIncoming = input.direction === undefined || input.direction === "both" || input.direction === "incoming";
	const includeOutgoing = input.direction === undefined || input.direction === "both" || input.direction === "outgoing";
	const incomingResult = includeIncoming
		? await executor.execute(sql`
			SELECT relations.type AS relation_type, ${ENTITY_SUMMARY_COLUMNS}
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.from_id
			WHERE relations.tenant_id = ${executor.tenantId} AND relations.to_id = ${entity.id}
				${incomingProjectFilter}
				AND entities.tombstone = false ${typeFilter}
			ORDER BY entities.id
		`)
		: { rows: [] };
	const outgoingResult = includeOutgoing
		? await executor.execute(sql`
			SELECT relations.type AS relation_type, ${ENTITY_SUMMARY_COLUMNS}
			FROM relations
			JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
			WHERE relations.tenant_id = ${executor.tenantId} AND relations.from_id = ${entity.id}
				${outgoingProjectFilter}
				AND entities.tombstone = false ${typeFilter}
			ORDER BY entities.id
		`)
		: { rows: [] };
	const relatedIds = [
		entity.id,
		...(incomingResult.rows as EntitySummaryRow[]).map((row) => row.id),
		...(outgoingResult.rows as EntitySummaryRow[]).map((row) => row.id)
	];
	const statusMap = await getDerivedStatusMap(executor, relatedIds);

	return {
		entity: toEntitySummary(applyDerivedStatus(entity, statusMap)),
		incoming: (incomingResult.rows as Array<EntitySummaryRow & { relation_type: string }>).map((row) => ({
			relationType: row.relation_type as RelationType,
			entity: applyDerivedStatus(mapEntitySummaryRow(row), statusMap)
		})),
		outgoing: (outgoingResult.rows as Array<EntitySummaryRow & { relation_type: string }>).map((row) => ({
			relationType: row.relation_type as RelationType,
			entity: applyDerivedStatus(mapEntitySummaryRow(row), statusMap)
		})),
		planEntries: entity.kind === "issue" ? await getRelatedPlanEntries(executor, entity.id) : []
	};
}

export async function listEntities(executor: TenantExecutor, kind: string): Promise<EntitySummary[]> {
	if (!isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = deriveEntityStatuses(await getAllEntitySummaries(executor), await getAllRelations(executor));
	return entities.filter((entity) => entity.kind === kind);
}

export async function queryEntities(
	executor: TenantExecutor,
	input: QueryEntitiesInput
): Promise<QueryEntitiesResult> {
	if (!isEntityKind(input.kind)) {
		throw new Error(`Unknown entity kind: ${input.kind}`);
	}

	let parentIds: string[] | undefined;
	let parents: Array<typeof entities.$inferSelect> | undefined;
	if (input.parentId) {
		const parentRows = await resolveEntities(executor, input.parentId, false, executor.currentProjectId);
		if (parentRows.length === 0) {
			return { entities: [], total: 0, openBlockers: input.kind === "issue" ? {} : undefined };
		}
		parents = parentRows;
		parentIds = parentRows.map((parent) => parent.id);
	}
	const candidateResult = parentIds
		? await executor.execute(sql`
			SELECT entity.id
			FROM entities AS entity
			JOIN relations AS parent_relation
				ON parent_relation.tenant_id = entity.tenant_id AND parent_relation.to_id = entity.id
			WHERE entity.tenant_id = ${executor.tenantId}
				AND entity.project_id = ${executor.currentProjectId}
				AND entity.tombstone = false
				AND entity.kind = ${input.kind}
				AND parent_relation.from_id IN ${parentIds}
				AND parent_relation.type IN ${STRUCTURAL_RELATION_TYPES}
			ORDER BY entity.id
		`)
		: await executor.execute(sql`
			SELECT id FROM entities
			WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND tombstone = false AND kind = ${input.kind}
			ORDER BY id
		`);
	let selectedIds = (candidateResult.rows as Array<{ id: string }>).map((row) => row.id);
	let statusMap: Map<string, string>;
	if (input.statuses?.length) {
		statusMap = await getDerivedStatusMap(executor, selectedIds);
		const statuses = new Set(input.statuses);
		selectedIds = selectedIds.filter((entityId) => statuses.has(statusMap.get(entityId) ?? ""));
	} else {
		statusMap = await getDerivedStatusMap(executor, selectedIds);
	}
	const total = selectedIds.length;
	const compatibilityByEntityId = new Map<string, EntitySummary["codeCompatibility"]>();
	if (input.kind === "issue" && input.retrievalContext !== undefined && selectedIds.length > 0) {
		const retrievalContext = input.retrievalContext;
		const selectedResult = await executor.execute(sql`
			SELECT ${ENTITY_SUMMARY_COLUMNS} FROM entities
			WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND id IN ${selectedIds}
		`);
		const selectedById = new Map((selectedResult.rows as EntitySummaryRow[]).map((row) => [row.id, applyDerivedStatus(mapEntitySummaryRow(row), statusMap)]));
		const completedIssues = await Promise.all(selectedIds
			.map((entityId) => selectedById.get(entityId)!)
			.filter((entity) => entity.status === "done")
			.map(async (entity) => ({
				entity,
				codeCompatibility: getCodeCompatibility((await listCompletionObservations(executor, entity.id)).at(-1) ?? {
					repositoryIdentity: null,
					commitSha: null,
					calculatedVersionState: "unknown" as const,
					calculatedVersion: null
				}, retrievalContext)
			})));
		for (const { entity, codeCompatibility } of completedIssues) {
			compatibilityByEntityId.set(entity.id, codeCompatibility);
		}
		if (retrievalContext.diagnostics.length === 0) {
			completedIssues.sort((left, right) => compareCodeCompatibility(left.codeCompatibility, right.codeCompatibility));
		}
		let completedIssueIndex = 0;
		selectedIds = selectedIds.map((entityId) => {
			const entity = selectedById.get(entityId)!;
			return entity.status === "done" ? completedIssues[completedIssueIndex++]!.entity.id : entityId;
		});
	}
	const limitedIds = input.limit === undefined ? selectedIds : selectedIds.slice(0, input.limit);
	if (limitedIds.length === 0) {
		return { entities: [], total, openBlockers: input.kind === "issue" ? {} : undefined };
	}
	const selectedResult = await executor.execute(sql`
		SELECT ${ENTITY_SUMMARY_COLUMNS} FROM entities
		WHERE tenant_id = ${executor.tenantId} AND project_id = ${executor.currentProjectId} AND id IN ${limitedIds}
	`);
	const selectedById = new Map((selectedResult.rows as EntitySummaryRow[]).map((row) => {
		const entity = applyDerivedStatus(mapEntitySummaryRow(row), statusMap);
		const codeCompatibility = compatibilityByEntityId.get(entity.id);
		return [entity.id, codeCompatibility === undefined ? entity : { ...entity, codeCompatibility }];
	}));
	const resultEntities = limitedIds.map((entityId) => selectedById.get(entityId)!);
	const parentGroups = parents
		&& parents.length > 1
		? await Promise.all(parents.map(async (parent) => {
			const childResult = await executor.execute(sql`
				SELECT to_id FROM relations
				WHERE tenant_id = ${executor.tenantId}
					AND from_id = ${parent.id}
					AND type IN ${STRUCTURAL_RELATION_TYPES}
			`);
			const childIds = new Set((childResult.rows as Array<{ to_id: string }>).map((row) => row.to_id));
			return { parent: toEntitySummary(mapDrizzleEntityRow(parent)), entities: resultEntities.filter((entity) => childIds.has(entity.id)) };
		}))
		: undefined;

	return {
		entities: resultEntities,
		total,
		...(input.retrievalContext ? { retrievalDiagnostics: input.retrievalContext.diagnostics } : {}),
		...(parentGroups ? { parentGroups } : {}),
		openBlockers: input.kind === "issue" ? await getOpenBlockers(executor, resultEntities) : undefined
	};
}
/**
 * Maps each of `issues`' canonical references to the references of its open
 * (not-`done`) `blocks` sources, so `queryEntities` can report blocked-status
 * inline instead of making a caller issue one `queryEntityRelations` call
 * per candidate. Keyed and valued by reference, not internal id, so callers
 * never have to resolve a raw id back to something they can pass to another
 * command.
 */
async function getOpenBlockers(executor: TenantExecutor, issues: EntitySummary[]): Promise<Record<string, string[]>> {
	const openBlockers: Record<string, string[]> = {};
	const referenceById = new Map(issues.map((entity) => [entity.id, entity.reference]));
	for (const entity of issues) {
		openBlockers[entity.reference] = [];
	}
	if (issues.length === 0) {
		return openBlockers;
	}

	const issueIds = issues.map((entity) => entity.id);
	const blockRows = (await executor.execute(sql`
		SELECT relations.from_id, relations.to_id
		FROM relations
		JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.type = 'blocks'
			AND relations.to_id IN ${issueIds}
			AND source.project_id = ${executor.currentProjectId}
			AND source.tombstone = false
	`)).rows as Array<{ from_id: string; to_id: string }>;
	if (blockRows.length === 0) {
		return openBlockers;
	}

	const sourceIds = Array.from(new Set(blockRows.map((row) => row.from_id)));
	const statusMap = await getDerivedStatusMap(executor, sourceIds);
	const missingReferenceIds = sourceIds.filter((id) => !referenceById.has(id));
	if (missingReferenceIds.length > 0) {
		const sourceReferenceRows = (await executor.execute(sql`
			SELECT id, reference FROM entities
			WHERE tenant_id = ${executor.tenantId}
				AND project_id = ${executor.currentProjectId}
				AND id IN ${missingReferenceIds}
		`)).rows as Array<{ id: string; reference: string }>;
		for (const row of sourceReferenceRows) {
			referenceById.set(row.id, row.reference);
		}
	}

	for (const row of blockRows) {
		const sourceStatus = statusMap.get(row.from_id);
		if (sourceStatus && sourceStatus !== "done") {
			const targetReference = referenceById.get(row.to_id)!;
			openBlockers[targetReference]!.push(referenceById.get(row.from_id)!);
		}
	}

	return openBlockers;
}

function mapEntitySummaryRow(row: EntitySummaryRow): EntitySummary {
	if (!isEntityKind(row.kind)) {
		throw new Error(`Unexpected entity kind in database: ${row.kind}`);
	}

	return {
		id: row.id,
		reference: row.reference,
		shortReference: row.short_reference,
		createdBy: row.created_by ?? RESERVED_SYSTEM_AUTHOR,
		updatedBy: row.updated_by ?? RESERVED_SYSTEM_AUTHOR,
		kind: row.kind,
		title: row.title,
		status: row.status,
		category: row.category && isEntityCategory(row.category) ? row.category : null,
		priority: row.priority && isEntityPriority(row.priority) ? row.priority : null,
		type: row.type && isEntityType(row.kind, row.type) ? row.type : null,
		revision: row.revision ?? 1,
		contentHash: row.content_hash ?? "",
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function listEntityHistory(executor: TenantExecutor, entityId: string): Promise<HistoryEntryRecord[]> {
	const row = await resolveEntity(executor, entityId, true);
	if (!row) {
		return [];
	}

	const headRevision = row.revision ?? 1;
	const currentParentIds = (await getStructuralParentRelations(executor, row.id)).map((relation) => relation.fromId);

	const deltaRows = await executor
		.select()
		.from(revisionEntries)
		.where(
			and(
				eq(revisionEntries.tenantId, executor.tenantId),
				eq(revisionEntries.recordKind, "entity"),
				eq(revisionEntries.recordKey, encodeEntityRecordKey(row.id))
			)
		)
		.orderBy(desc(revisionEntries.revision));

	const patchByRevision = new Map(deltaRows.map((d) => [d.revision, d]));
	const newestPatch = patchByRevision.get(headRevision);
	const headState = {
		title: row.title,
		body: row.body,
		bodySource: isBodySource(row.bodySource) ? (row.bodySource as BodySource) : "authored",
		category: row.category && isEntityCategory(row.category) ? row.category : null,
		priority: row.priority && isEntityPriority(row.priority) ? row.priority : null,
		type: row.type && isEntityType(row.kind as EntityKind, row.type) ? row.type : null,
		status: row.status,
		tombstone: row.tombstone
	};
	const currentParentId = resolveRevisionHeadParentId(row.id, headState, currentParentIds, newestPatch?.sourceHash);

	let state: { title: string; body: string; bodySource: BodySource; category: EntityRecord["category"]; priority: EntityRecord["priority"]; type: EntityRecord["type"]; status: string; parentId: string | null; tombstone: boolean | null } = {
		...headState,
		parentId: currentParentId,
	};

	const entries: HistoryEntryRecord[] = [];

	for (let revision = headRevision; revision >= 1; revision--) {
		const patch = patchByRevision.get(revision);
		if (!patch) {
			throw new EntityRevisionError(row.id, "broken-chain", `Missing revision_entries row for entity ${row.id} at revision ${revision}`, headRevision);
		}
		entries.push({
			id: patch.id,
			entityId: row.id,
			version: revision,
			author: patch.author,
			title: state.title,
			body: state.body,
			bodySource: state.bodySource,
			type: state.type,
			status: state.status,
			parentId: state.parentId,
			createdAt: patch.createdAt
		});
		if (revision > 1) {
			state = applyReversePatch(state, {
				revision: patch.revision,
				author: patch.author,
				createdAt: patch.createdAt,
				patchFormat: patch.patchFormat,
				reversePatch: patch.reversePatch,
				sourceHash: decodeRevisionPatchHash(patch.sourceHash),
				targetHash: decodeRevisionPatchHash(patch.targetHash)
			});
		}
	}

	return entries.reverse();
}

function resolveRevisionHeadParentId(
	entityId: string,
	state: { title: string; body: string; bodySource: BodySource; category: EntityRecord["category"]; priority: EntityRecord["priority"]; type: EntityRecord["type"]; status: string; tombstone: boolean | null },
	parentIds: string[],
	sourceHash: Uint8Array | undefined
): string | null {
	if (!sourceHash) {
		return parentIds[0] ?? null;
	}
	const expectedHash = decodeRevisionPatchHash(sourceHash);
	const matches = [...new Set<string | null>([null, ...parentIds])].filter((parentId) =>
		createReverseFieldPatch({ ...state, parentId }, { ...state, parentId }, ENTITY_REVERSE_PATCH_REGISTRY).sourceHash === expectedHash
	);
	if (matches.length !== 1) {
		throw new EntityRevisionError(entityId, "broken-chain", `Cannot uniquely resolve revision head parent for entity ${entityId}`);
	}
	return matches[0]!;
}

// Relations are an idempotent key union after canonical heads import. This
// includes structural rows: the canonical parent is already present and is a
// no-op, while additional structural-type annotations must still transfer.
export async function listAllRelations(executor: TenantExecutor): Promise<RelationRecord[]> {
	const result = await executor.execute(sql`
		SELECT relations.* FROM relations
		JOIN entities AS source ON source.tenant_id = relations.tenant_id AND source.id = relations.from_id
		JOIN entities AS target ON target.tenant_id = relations.tenant_id AND target.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND source.project_id = ${executor.currentProjectId}
			AND target.project_id = ${executor.currentProjectId}
			AND source.tombstone = false
			AND target.tombstone = false
		ORDER BY relations.from_id, relations.to_id, relations.type
	`);
	return (result.rows as RelationRow[]).map((row) => ({
		fromId: row.from_id,
		toId: row.to_id,
		type: row.type as RelationType,
		createdBy: row.created_by ?? SYSTEM_USER_ID,
		createdAt: row.created_at
	}));
}

// The write half of the relations sync seam (ISS60/ADR16): idempotent via
// `insertRelation`'s own `ON CONFLICT DO NOTHING`, keyed on the table's
// primary key (tenant_id, from_id, to_id, type).
export async function applyRelations(executor: TenantExecutor, relations: RelationRecord[]): Promise<{ inserted: number }> {
	let inserted = 0;
	for (const relation of relations) {
		const from = await getEntityOrThrow(executor, relation.fromId);
		const to = await getEntityOrThrow(executor, relation.toId);
		const createdBy = relation.createdBy === RESERVED_SYSTEM_AUTHOR ? SYSTEM_USER_ID : relation.createdBy ?? SYSTEM_USER_ID;
		const { inserted: wasInserted } = await insertRelation(executor, { ...relation, fromId: from.id, toId: to.id, createdBy });
		if (wasInserted) {
			inserted += 1;
		}
	}
	return { inserted };
}

export async function linkEntities(
	executor: TenantExecutor,
	input: { fromId: string; toId: string; relationType: string },
	actorId: string = SYSTEM_USER_ID
): Promise<LinkResult> {
	if (input.fromId === input.toId) {
		throw new Error("Cannot create a relation from an entity to itself.");
	}

	const from = await getEntityOrThrow(executor, input.fromId);
	const to = await getEntityOrThrow(executor, input.toId);

	if (!isAllowedRelation(from.kind, to.kind, input.relationType)) {
		throw new Error(`Relation ${input.relationType} is not allowed from ${from.kind} to ${to.kind}. Valid relation types: ${getAllowedRelationTypes(from.kind, to.kind).join(", ") || "none"}.`);
	}
	if (to.kind === "debt" && isStructuralRelationType(input.relationType)) {
		const structuralParents = await getStructuralParentRelations(executor, to.id);
		if (structuralParents.some((relation) => relation.fromId !== from.id || relation.type !== input.relationType)) {
			throw new Error(`Debt ${to.id} already has a structural owner.`);
		}
	}

	if (
		(input.relationType === "blocks" || input.relationType === "supersedes") &&
		(await hasTypedPath(executor, to.id, from.id, input.relationType))
	) {
		throw new Error(`Linking ${from.id} -> ${to.id} as ${input.relationType} would create a cycle.`);
	}

	if (input.relationType === "supersedes" && to.kind === "adr" && to.status === "archived") {
		await updateEntityStatus(executor, { entityId: to.id, status: "current" });
	}

	const createdAt = new Date().toISOString();
	const relation: RelationRecord = { fromId: from.id, toId: to.id, type: input.relationType as RelationType, createdBy: actorId, createdAt };
	const { inserted } = await insertRelation(executor, relation);

	return { relation, created: inserted };
}

export async function unlinkEntities(
	executor: TenantExecutor,
	input: { fromId: string; toId: string; relationType: string }
): Promise<UnlinkResult> {
	const relation = await getRelationOrThrow(executor, input);

	if (await wouldOrphanSubtree(executor, relation)) {
		throw new Error(
			`Unlinking ${relation.fromId} -> ${relation.toId} as ${relation.type} would orphan a subtree. Relink or delete descendants first.`
		);
	}

	if (await wouldBreakFullChainInvariant(executor, relation)) {
		const target = await getEntityOrThrow(executor, relation.toId);
		throw new Error(
			`Cannot unlink ${relation.fromId} -> ${relation.toId} as ${relation.type}: it is the only remaining structural parent, and every ${target.kind} must have one.`
		);
	}

	const removed = await executor
		.delete(relations)
		.where(
			and(
				eq(relations.tenantId, executor.tenantId),
				eq(relations.fromId, relation.fromId),
				eq(relations.toId, relation.toId),
				eq(relations.type, relation.type)
			)
		)
		.returning({ fromId: relations.fromId });

	return { relation, removed: removed.length > 0 };
}

export async function updateEntityStatus(
	executor: TenantExecutor,
	input: { entityId: string; status: string; author?: string; workspaceObservation?: WorkspaceObservation },
	actorId: string = SYSTEM_USER_ID
): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(executor, input.entityId);

	if (!isValidStatus(entity.kind, input.status)) {
		throw new Error(`Invalid status for ${entity.kind}: ${input.status}`);
	}

	if ((entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") && input.status === "superseded") {
		throw new Error(`${entity.id} status is derived (superseded); link a replacement record with supersedes instead.`);
	}

	if (entity.kind === "prd" || entity.kind === "userStory" || entity.kind === "adr") {
		const supersedingEntityId = await getSupersedingEntityId(executor, entity.id, entity.kind);
		if (supersedingEntityId !== undefined) {
			throw new Error(`${entity.id} status is derived (superseded) because ${supersedingEntityId} supersedes it.`);
		}
	}

	if (entity.kind === "userStory") {
		const fixingIssueStatuses = await getFixingIssueStatuses(executor, entity.id);
		if (fixingIssueStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its fixing issues; update those issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "prd") {
		const createdStoryStatuses = await getCreatedStoryStatuses(executor, entity.id);
		if (createdStoryStatuses.length > 0) {
			throw new Error(`${entity.id} status is derived from its user stories; update the underlying issues instead of setting it directly.`);
		}
	}

	if (entity.kind === "initiative") {
		const { trackedIssueStatuses, ownedPrdStatuses } = await getInitiativeChildStatuses(executor, entity.id);
		if (isInitiativeComplete(trackedIssueStatuses, ownedPrdStatuses)) {
			throw new Error(`${entity.id} status is derived (done) from its tracked issues and PRDs; reopen a child to change it.`);
		}
		if (input.status === "done" && trackedIssueStatuses.length > 0) {
			throw new Error(
				`${entity.id} cannot be marked done while tracked issues remain open; it completes automatically when they are all done.`
			);
		}
	}

	if (entity.kind === "issue" && (input.status === "in-progress" || input.status === "done")) {
		const openSubIssues = await getOpenSubIssues(executor, entity.id);
		if (openSubIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while sub-issues remain open: ${openSubIssues.map((issue) => issue.id).join(", ")}.`
			);
		}

		const blockingIssues = await getActiveBlockingIssues(executor, entity.id);
		if (blockingIssues.length > 0) {
			throw new Error(
				`Cannot set ${entity.id} to ${input.status} while blocked by ${blockingIssues.map((issue) => issue.id).join(", ")}.`
			);
		}

	}

	const previousStatus = entity.status;
	const updatedAt = new Date().toISOString();
	const newRevision = entity.revision + 1;

	const updated = await executor
		.update(entities)
		.set({ status: input.status, revision: newRevision, updatedBy: actorId, updatedAt })
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(executor, entity.id);
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	await appendDeltaEntry(executor, entity.id, newRevision, entity.title, entity.body, entity.bodySource, actorId, updatedAt, {
		priorStatus: entity.status
	});
	if (entity.kind === "issue" && entity.status !== "done" && input.status === "done" && input.workspaceObservation) {
		await insertCompletionObservation(executor, entity.id, input.workspaceObservation);
	}

	return {
		entity: toEntitySummary({ ...entity, status: input.status, revision: newRevision, updatedBy: actorId, updatedAt }),
		previousStatus
	};
}

async function insertCompletionObservation(executor: TenantExecutor, issueId: string, observation: WorkspaceObservation): Promise<void> {
	const id = randomUUID();
	const result = await executor.execute(sql`SELECT COALESCE(MAX(completion_ordinal), 0) + 1 AS completion_ordinal
		FROM completion_observations WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issueId}::uuid`);
	const ordinal = Number((result.rows[0] as { completion_ordinal: number | string }).completion_ordinal);
	const diagnostics = observation.state === "unknown" ? observation.diagnostics : observation.calculatedVersion.state === "unknown" ? observation.calculatedVersion.diagnostics : [];
	const available = observation.state === "available" ? observation : undefined;
	const calculatedVersionState = available?.calculatedVersion.state ?? "unknown";
	const calculatedVersion = available?.calculatedVersion.state === "available" ? available.calculatedVersion.version : null;
	await executor.execute(sql`INSERT INTO completion_observations (
		tenant_id, id, issue_id, completion_ordinal, repository_identity, commit_sha, branch, dirty, captured_at, calculated_version_state, calculated_version, diagnostics
	) VALUES (
		${executor.tenantId}, ${id}::uuid, ${issueId}::uuid, ${ordinal}, ${available?.repositoryIdentity ?? null}, ${available?.commitSha ?? null}, ${available?.branch ?? null}, ${available?.dirty ?? null}, ${observation.capturedAt}, ${calculatedVersionState}, ${calculatedVersion}, ${JSON.stringify(diagnostics)}
	)`);
}

async function listCompletionObservations(executor: TenantExecutor, issueId: string): Promise<CompletionObservation[]> {
	const result = await executor.execute(sql`SELECT * FROM completion_observations
		WHERE tenant_id = ${executor.tenantId} AND issue_id = ${issueId}::uuid
		ORDER BY completion_ordinal`);
	return (result.rows as Array<{
		id: string;
		issue_id: string;
		completion_ordinal: number;
		repository_identity: string | null;
		commit_sha: string | null;
		branch: string | null;
		dirty: boolean | null;
		captured_at: string;
		calculated_version_state: "available" | "unknown";
		calculated_version: string | null;
		diagnostics: string;
	}>).map((row) => ({
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
	}));
}

export async function setEntityBody(
	executor: TenantExecutor,
	input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = SYSTEM_USER_ID
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(executor, input.entityId);

	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}

	const updatedAt = new Date().toISOString();
	const bodySource = input.bodySource ?? "authored";
	const newRevision = current.revision + 1;
	const newContentHash = computeEntityContentHash(current.title, input.body);

	const [guard] = await executor
		.update(entities)
		.set({ body: input.body, bodySource, revision: newRevision, contentHash: newContentHash, updatedBy: actorId, updatedAt })
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(executor, current.id);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(executor, current.id, newRevision, current.title, current.body, current.bodySource, actorId, updatedAt);
	if (current.kind === "plan" && current.status === "ready" && current.body !== input.body) {
		await updateEntityStatus(executor, { entityId: current.id, status: "in-progress" }, actorId);
	}
	return getEntityOrThrow(executor, current.id);
}

export async function updateEntity(
	executor: TenantExecutor,
	input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; category?: string; priority?: string; type?: string | null; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string
): Promise<EntityRecord> {
	const current = await getEntityOrThrow(executor, input.entityId);
	if (input.title === undefined && input.body === undefined && input.category === undefined && input.priority === undefined && input.type === undefined) {
		throw new Error("Entity edit requires --title, --body, --category, --priority, or --type.");
	}
	if (input.category !== undefined && !isEntityCategory(input.category)) {
		throw new Error(`Invalid entity category: ${input.category}`);
	}
	if (input.priority !== undefined && !isEntityPriority(input.priority)) {
		throw new Error(`Invalid entity priority: ${input.priority}`);
	}

	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}

	const title = input.title === undefined ? current.title : input.title.trim();
	if (title.length === 0) {
		throw new Error("Entity title must not be empty.");
	}
	const body = input.body ?? current.body;
	const bodySource = input.body === undefined ? current.bodySource : input.bodySource ?? "authored";
	const category = input.category ?? current.category;
	const priority = input.priority ?? current.priority;
	const entityType = input.type === undefined ? current.type : input.type;
	if (entityType !== null && !isEntityType(current.kind, entityType)) {
		throw new Error(`Invalid entity type: ${entityType}`);
	}
	const parentId = (await getStructuralParentRelations(executor, current.id))[0]?.fromId;
	const parent = parentId ? await getEntityOrThrow(executor, parentId) : null;
	if (current.type === "pioneer-map" && entityType !== "pioneer-map" && (await getEntityDetails(executor, current.id)).outgoing.some(({ entity, relationType }) => relationType === "decomposes" && entity.type === "pioneer-ticket")) {
		throw new Error("Cannot remove pioneer-map type while it has pioneer-ticket children.");
	}
	if (entityType === "pioneer-map" && parent?.kind !== "initiative") {
		throw new Error("pioneer-map requires an initiative parent.");
	}
	if (entityType === "pioneer-ticket" && (parent?.kind !== "issue" || parent.type !== "pioneer-map")) {
		throw new Error("pioneer-ticket requires a pioneer-map parent.");
	}
	const newRevision = current.revision + 1;
	const newContentHash = computeEntityContentHash(title, body);
	const updatedAt = new Date().toISOString();

	const [guard] = await executor
		.update(entities)
		.set({ title, body, bodySource, category, priority, type: entityType, revision: newRevision, contentHash: newContentHash, updatedBy: actorId, updatedAt })
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash)))
		.returning({ id: entities.id });

	if (!guard) {
		const fresh = await getEntityOrThrow(executor, current.id);
		throw new EntityConflictError(input.entityId, fresh.revision, fresh.contentHash);
	}

	await appendDeltaEntry(executor, current.id, newRevision, current.title, current.body, current.bodySource, actorId, updatedAt, {
		...(input.category !== undefined && { priorCategory: current.category }),
		...(input.priority !== undefined && { priorPriority: current.priority }),
		...(input.type !== undefined && { priorType: current.type })
	});
	if (current.kind === "plan" && current.status === "ready" && (current.title !== title || current.body !== body)) {
		await updateEntityStatus(executor, { entityId: current.id, status: "in-progress" }, actorId);
	}
	return getEntityOrThrow(executor, current.id);
}

export async function materializeEntityRevision(
	executor: TenantExecutor,
	input: { entityId: string; revision: number }
): Promise<MaterializedEntityRevision> {
	const row = await resolveEntity(executor, input.entityId, true);
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}

	const entity = mapDrizzleEntityRow(row);
	const deltaRows = await executor
		.select()
		.from(revisionEntries)
		.where(and(eq(revisionEntries.tenantId, executor.tenantId), eq(revisionEntries.recordKind, "entity"), eq(revisionEntries.recordKey, encodeEntityRecordKey(row.id))))
		.orderBy(desc(revisionEntries.revision));
	const patches: EntityRevisionPatch[] = deltaRows.map((delta) => ({
		revision: delta.revision,
		author: delta.author,
		createdAt: delta.createdAt,
		patchFormat: delta.patchFormat,
		reversePatch: delta.reversePatch,
		sourceHash: decodeRevisionPatchHash(delta.sourceHash),
		targetHash: decodeRevisionPatchHash(delta.targetHash),
		...(delta.restoredFromRevision !== null && { restoredFromRevision: delta.restoredFromRevision })
	}));
	const headRevision = entity.revision ?? 1;
	const parentId = resolveRevisionHeadParentId(
		entity.id,
		{
			title: entity.title,
			body: entity.body,
			bodySource: entity.bodySource,
			category: entity.category,
			priority: entity.priority,
			type: entity.type,
			status: entity.status,
			tombstone: row.tombstone
		},
		(await getStructuralParentRelations(executor, entity.id)).map((relation) => relation.fromId),
		deltaRows.find((delta) => delta.revision === headRevision)?.sourceHash
	);

	return materializeFromPatches(
		entity.id,
		{
			id: entity.id,
			title: entity.title,
			body: entity.body,
			bodySource: entity.bodySource,
			category: entity.category,
			priority: entity.priority,
			type: entity.type,
			status: entity.status,
			parentId,
			revision: headRevision,
			createdAt: entity.createdAt,
			tombstone: row.tombstone
		},
		patches,
		input.revision
	);
}

export async function restoreEntityRevision(
	executor: TenantExecutor,
	input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string },
	actorId: string = SYSTEM_USER_ID
): Promise<MaterializedEntityRevision> {
	const row = await resolveEntity(executor, input.entityId, true);
	if (!row) {
		throw new EntityRevisionError(input.entityId, "entity-not-found", `Entity not found: ${input.entityId}`);
	}
	const current = mapDrizzleEntityRow(row);
	if (current.revision !== input.expectedRevision || current.contentHash !== input.expectedContentHash) {
		throw new EntityConflictError(input.entityId, current.revision, current.contentHash);
	}
	const source = await materializeEntityRevision(executor, { entityId: current.id, revision: input.revision });
	const currentParentId = (await getStructuralParentRelations(executor, current.id))[0]?.fromId ?? null;
	let restoredParent: EntityRecord | null = null;
	let restoredRelationType: RelationType | null = null;
	if (!source.tombstone && source.parentId) {
		restoredParent = await getEntityOrThrow(executor, source.parentId);
		restoredRelationType = getAllowedRelationType(restoredParent.kind, current.kind);
		if (!restoredRelationType || !isStructuralRelationType(restoredRelationType)) {
			throw new Error(`Cannot restore ${current.kind} under ${restoredParent.kind}.`);
		}
		if (await hasStructuralPath(executor, current.id, restoredParent.id)) {
			throw new Error(`Cannot restore ${current.id} under ${restoredParent.id} because that would create a cycle.`);
		}
	}
	if (source.type === "pioneer-map" && restoredParent?.kind !== "initiative") {
		throw new Error("pioneer-map requires an initiative parent.");
	}
	if (source.type === "pioneer-ticket" && (restoredParent?.kind !== "issue" || restoredParent.type !== "pioneer-map")) {
		throw new Error("pioneer-ticket requires a pioneer-map parent.");
	}
	if (current.type === "pioneer-map" && source.type !== "pioneer-map" && (await getEntityDetails(executor, current.id)).outgoing.some(({ entity, relationType }) => relationType === "decomposes" && entity.type === "pioneer-ticket")) {
		throw new Error("Cannot remove pioneer-map type while it has pioneer-ticket children.");
	}

	const updatedAt = new Date().toISOString();
	const newRevision = current.revision + 1;
	const [guard] = await executor.update(entities).set({
		title: source.title,
		body: source.body,
		bodySource: source.bodySource,
		type: source.type,
		status: source.status,
		revision: newRevision,
		contentHash: computeEntityContentHash(source.title, source.body),
		tombstone: source.tombstone === true,
		updatedBy: actorId,
		updatedAt
	}).where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, current.id), eq(entities.revision, input.expectedRevision), eq(entities.contentHash, input.expectedContentHash))).returning({ id: entities.id });
	if (!guard) {
		const [freshRow] = await executor.select().from(entities).where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, current.id)));
		const fresh = mapDrizzleEntityRow(freshRow!);
		throw new EntityConflictError(current.id, fresh.revision, fresh.contentHash);
	}

	for (const relation of await getStructuralParentRelations(executor, current.id)) {
		await executor.delete(relations).where(and(eq(relations.tenantId, executor.tenantId), eq(relations.fromId, relation.fromId), eq(relations.toId, relation.toId), eq(relations.type, relation.type)));
	}
	if (restoredParent && restoredRelationType) {
		await insertRelation(executor, { fromId: restoredParent.id, toId: current.id, type: restoredRelationType, createdBy: actorId, createdAt: updatedAt });
	}
	await refreshProjectAssignments(executor);

	await appendDeltaEntry(executor, current.id, newRevision, current.title, current.body, current.bodySource, actorId, updatedAt, {
		priorStatus: current.status,
		priorType: current.type,
		priorParentId: currentParentId,
		priorTombstone: row.tombstone,
		restoredFromRevision: input.revision
	});
	return materializeEntityRevision(executor, { entityId: current.id, revision: newRevision });
}

export async function archiveEntity(executor: TenantExecutor, input: { entityId: string }, actorId: string = SYSTEM_USER_ID): Promise<StatusUpdateResult> {
	const entity = await getEntityOrThrow(executor, input.entityId);
	return updateEntityStatus(executor, { entityId: input.entityId, status: getArchiveStatus(entity.kind) }, actorId);
}

export async function moveEntity(
	executor: TenantExecutor,
	input: { entityId: string; newParentId: string; author?: string },
	actorId: string = SYSTEM_USER_ID
): Promise<MoveResult> {
	if (input.entityId === input.newParentId) {
		throw new Error("Cannot move an entity under itself.");
	}

	const entity = await getEntityOrThrow(executor, input.entityId);
	const newParent = await getEntityOrThrow(executor, input.newParentId);

	const relationType = getAllowedRelationType(newParent.kind, entity.kind);
	if (!relationType || !isStructuralRelationType(relationType)) {
		throw new Error(`Cannot move ${entity.kind} under ${newParent.kind}.`);
	}
	if (entity.type === "pioneer-map" && newParent.kind !== "initiative") {
		throw new Error("pioneer-map requires an initiative parent.");
	}
	if (entity.type === "pioneer-ticket" && (newParent.kind !== "issue" || newParent.type !== "pioneer-map")) {
		throw new Error("pioneer-ticket requires a pioneer-map parent.");
	}

	const currentParentRelations = await getStructuralParentRelations(executor, entity.id);
	if (currentParentRelations.length > 1) {
		throw new Error(`Cannot move ${entity.id} because it has multiple structural parents.`);
	}

	if (await hasStructuralPath(executor, entity.id, newParent.id)) {
		throw new Error(`Cannot move ${entity.id} under ${newParent.id} because that would create a cycle.`);
	}

	const previousParentId = currentParentRelations[0]?.fromId ?? null;
	if (previousParentId === newParent.id && currentParentRelations[0]?.type === relationType) {
		return { entity: toEntitySummary(entity), previousParentId, newParentId: newParent.id, relationType };
	}

	const updatedAt = new Date().toISOString();
	const newRevision = entity.revision + 1;

	for (const relation of currentParentRelations) {
		await executor
			.delete(relations)
			.where(
				and(
					eq(relations.tenantId, executor.tenantId),
					eq(relations.fromId, relation.fromId),
					eq(relations.toId, relation.toId),
					eq(relations.type, relation.type)
				)
			);
	}

	await insertRelation(executor, { fromId: newParent.id, toId: entity.id, type: relationType, createdBy: actorId, createdAt: updatedAt });
	await refreshProjectAssignments(executor);

	const updated = await executor
		.update(entities)
		.set({ revision: newRevision, updatedBy: actorId, updatedAt })
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, entity.id), eq(entities.revision, entity.revision)))
		.returning({ id: entities.id });
	if (updated.length === 0) {
		const current = await getEntityOrThrow(executor, entity.id);
		throw new EntityConflictError(entity.id, current.revision, current.contentHash);
	}

	await appendDeltaEntry(executor, entity.id, newRevision, entity.title, entity.body, entity.bodySource, actorId, updatedAt, {
		priorParentId: previousParentId
	});

	return {
		entity: toEntitySummary({ ...entity, revision: newRevision, updatedBy: actorId, updatedAt }),
		previousParentId,
		newParentId: newParent.id,
		relationType
	};
}

export async function deleteEntity(executor: TenantExecutor, input: { entityId: string }, actorId: string = SYSTEM_USER_ID): Promise<DeleteResult> {
	const entity = await getEntityOrThrow(executor, input.entityId);
	const previousParentId = (await getStructuralParentRelations(executor, entity.id))[0]?.fromId ?? null;
	const dependentHandoffRows = await executor
		.select({ id: entities.id })
		.from(entities)
		.innerJoin(relations, and(eq(relations.tenantId, entities.tenantId), eq(relations.fromId, entities.id)))
		.where(
			and(
				eq(entities.tenantId, executor.tenantId),
				eq(entities.kind, "handoff"),
				eq(entities.tombstone, false),
				eq(relations.toId, entity.id),
				eq(relations.type, "handsOff")
			)
		);
	for (const { id: handoffId } of dependentHandoffRows) {
		const handoff = await getEntityOrThrow(executor, handoffId);
		const handoffUpdatedAt = new Date().toISOString();
		const handoffRevision = handoff.revision + 1;
		await executor
			.delete(relations)
			.where(and(eq(relations.tenantId, executor.tenantId), or(eq(relations.fromId, handoff.id), eq(relations.toId, handoff.id))));
		await executor
			.update(entities)
			.set({ tombstone: true, revision: handoffRevision, updatedBy: actorId, updatedAt: handoffUpdatedAt })
			.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.id, handoff.id), eq(entities.tombstone, false)));
		await appendDeltaEntry(executor, handoff.id, handoffRevision, handoff.title, handoff.body, handoff.bodySource, actorId, handoffUpdatedAt, {
			priorTombstone: false
		});
	}

	const [outgoingResult] = await executor
		.select({ count: sql<number>`count(*)` })
		.from(relations)
		.where(and(eq(relations.tenantId, executor.tenantId), eq(relations.fromId, entity.id)));
	if (Number(outgoingResult?.count ?? 0) > 0) {
		throw new Error(`Cannot delete ${entity.id} while it still has outgoing relations. Unlink or delete dependents first.`);
	}

	const updatedAt = new Date().toISOString();
	const newRevision = entity.revision + 1;
	await executor
		.delete(relations)
		.where(and(eq(relations.tenantId, executor.tenantId), or(eq(relations.fromId, entity.id), eq(relations.toId, entity.id))));
	const removed = await executor
		.update(entities)
		.set({ tombstone: true, revision: newRevision, updatedBy: actorId, updatedAt })
		.where(
			and(
				eq(entities.tenantId, executor.tenantId),
				eq(entities.id, entity.id),
				eq(entities.tombstone, false),
				eq(entities.revision, entity.revision)
			)
		)
		.returning({ id: entities.id });
	if (removed.length === 0) {
		const current = await getEntityOrThrow(executor, entity.id);
		throw new EntityConflictError(entity.id, current.revision, current.contentHash);
	}
	await appendDeltaEntry(executor, entity.id, newRevision, entity.title, entity.body, entity.bodySource, actorId, updatedAt, {
		priorParentId: previousParentId,
		priorTombstone: false
	});

	return {
		entity: toEntitySummary({ ...entity, revision: newRevision, updatedBy: actorId, updatedAt }),
		removed: removed.length > 0
	};
}

export async function listOrphans(executor: TenantExecutor, kind?: string): Promise<EntityRecord[]> {
	if (kind && !isEntityKind(kind)) {
		throw new Error(`Unknown entity kind: ${kind}`);
	}

	const entities = await getAllEntities(executor);
	const relations = await getAllRelations(executor);
	const reachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(relations, entity.id)) {
			reachable.add(id);
		}
	}

	const statusMap = await getDerivedStatusMap(executor);
	return entities
		.filter((entity) => {
			if (entity.kind === "initiative" || entity.kind === "adr" || entity.kind === "project" || entity.kind === "epic") {
				return false;
			}

			if (kind && entity.kind !== kind) {
				return false;
			}

			return !reachable.has(entity.id);
		})
		.map((entity) => applyDerivedStatus(entity, statusMap));
}

export async function listProjectAdrs(executor: TenantExecutor, projectId?: string): Promise<EntityRecord[]> {
	const entityRecords = await getAllEntities(executor);
	const relations = await getAllRelations(executor);
	const kindById = new Map(entityRecords.map((entity) => [entity.id, entity.kind]));
	const initiativeAdrIds = new Set(
		relations
			.filter((relation) => relation.type === "records" && kindById.get(relation.fromId) === "initiative")
			.map((relation) => relation.toId)
	);

	if (!projectId) {
		return entityRecords.filter((entity) => entity.kind === "adr" && !initiativeAdrIds.has(entity.id));
	}

	const rows = await executor
		.select()
		.from(entities)
		.where(and(eq(entities.tenantId, executor.tenantId), eq(entities.kind, "adr"), eq(entities.projectId, projectId), eq(entities.tombstone, false)))
		.orderBy(asc(entities.id));
	return rows.map(mapDrizzleEntityRow).filter((entity) => !initiativeAdrIds.has(entity.id));
}

export async function getInitiativeBundle(
	executor: TenantExecutor,
	initiativeId: string,
	allowedIds?: ReadonlySet<string>,
	statusMap?: ReadonlyMap<string, string>
): Promise<InitiativeBundle> {
	const initiative = await getEntityOrThrow(executor, initiativeId);
	if (initiative.kind !== "initiative") {
		throw new Error(`${initiativeId} is not an initiative.`);
	}

	const reachableResult = await executor.execute(sql`
		WITH RECURSIVE reachable(id) AS (
			SELECT ${initiative.id}::uuid
			UNION
			SELECT CASE
				WHEN relations.from_id = reachable.id THEN relations.to_id
				ELSE relations.from_id
			END
			FROM reachable
			JOIN relations ON (
				relations.from_id = reachable.id
				OR (relations.type = 'handsOff' AND relations.to_id = reachable.id)
			)
			JOIN entities AS next_entity ON next_entity.tenant_id = relations.tenant_id
				AND next_entity.id = CASE
					WHEN relations.from_id = reachable.id THEN relations.to_id
					ELSE relations.from_id
				END
			WHERE relations.tenant_id = ${executor.tenantId} AND next_entity.tombstone = false
		)
		SELECT id FROM reachable
	`);
	const reachableIds = (reachableResult.rows as Array<{ id: string }>).map((row) => row.id);
	const selectedIds = new Set(reachableIds.filter((id) => !allowedIds || allowedIds.has(id)));

	const entityResult = await executor.execute(sql`
		SELECT * FROM entities
		WHERE tenant_id = ${executor.tenantId} AND tombstone = false AND id = ANY(ARRAY[${sql.join([...selectedIds], sql`, `)}]::uuid[])
		ORDER BY id
	`);
	const relationResult = await executor.execute(sql`SELECT * FROM relations WHERE tenant_id = ${executor.tenantId}`);
	const entityRows = entityResult.rows as EntityRow[];
	const relationRows = relationResult.rows as RelationRow[];

	const entities = entityRows.map(mapEntityRow);
	const selectedEntityIds = new Set(entities.map((entity) => entity.id));
	const selectedRelations = relationRows.filter(
		(relation) => selectedEntityIds.has(relation.from_id) && selectedEntityIds.has(relation.to_id)
	);
	const derivedStatusMap = statusMap ?? (await getDerivedStatusMap(executor));
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, derivedStatusMap));
	const entityById = new Map(derivedEntities.map((entity) => [entity.id, entity]));
	const issues = derivedEntities.filter((entity) => entity.kind === "issue");

	return {
		initiative: applyDerivedStatus(initiative, derivedStatusMap),
		entities: derivedEntities,
		prds: derivedEntities.filter((entity) => entity.kind === "prd"),
		userStories: derivedEntities.filter((entity) => entity.kind === "userStory"),
		adrs: derivedEntities.filter((entity) => entity.kind === "adr"),
		issues,
		fixLinks: selectedRelations
			.filter((relation) => relation.type === "fixes")
			.map((relation) => ({ issue: entityById.get(relation.from_id)!, userStory: entityById.get(relation.to_id)! })),
		subIssueLinks: selectedRelations
			.filter((relation) => relation.type === "decomposes")
			.map((relation) => ({ parent: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
		blockerLinks: selectedRelations
			.filter((relation) => relation.type === "blocks")
			.map((relation) => ({ source: entityById.get(relation.from_id)!, target: entityById.get(relation.to_id)! })),
		constrainsLinks: selectedRelations
			.filter((relation) => relation.type === "constrains")
			.map((relation) => ({ adr: entityById.get(relation.from_id)!, issue: entityById.get(relation.to_id)! })),
		versionCoverage: deriveVersionCoverage((await Promise.all(issues.map((issue) => listCompletionObservations(executor, issue.id)))).flat())
	};
}

export async function getInitiativeDetail(
	executor: TenantExecutor,
	input: { initiativeId: string }
): Promise<InitiativeDetail> {
	const initiative = await getEntityOrThrow(executor, input.initiativeId);
	if (initiative.kind !== "initiative") {
		throw new Error(`${input.initiativeId} is not an initiative.`);
	}

	return { initiative: applyDerivedStatus(initiative, await getDerivedStatusMap(executor)) };
}

export async function getInitiativeTab(
	executor: TenantExecutor,
	input: { initiativeId: string; tab: InitiativeTab }
): Promise<InitiativeTabData> {
	const bundle = await getInitiativeBundle(executor, input.initiativeId);
	let records: EntityRecord[];
	switch (input.tab) {
		case "overview":
			return {
				tab: input.tab,
				records: [],
				relations: [],
				rollup: {
					initiative: toEntitySummary(bundle.initiative),
					adrCount: bundle.adrs.length,
					contextTermCount: (await queryProjectContextDetails(executor, bundle.initiative, bundle.initiative.id)).terms.length,
					debtCount: bundle.entities.filter((entity) => entity.kind === "debt").length,
					issueCount: bundle.issues.filter((issue) => issue.status !== "deferred").length,
					totalIssueCount: bundle.issues.length,
					completedIssueCount: bundle.issues.filter((issue) => issue.status === "done").length,
					planCount: bundle.entities.filter((entity) => entity.kind === "plan").length,
					prdCount: bundle.prds.length,
					userStoryCount: bundle.userStories.length
				}
			};
		case "context":
			return {
				tab: input.tab,
				records: [],
				relations: [],
				context: await queryProjectContextDetails(executor, bundle.initiative, bundle.initiative.id)
			};
		case "issues":
			records = bundle.issues;
			break;
		case "plans":
			records = bundle.entities.filter((entity) => entity.kind === "plan");
			break;
		case "prds":
			records = bundle.prds;
			break;
		case "adrs":
			records = bundle.adrs;
			break;
		case "userStories":
			records = [...bundle.userStories, ...bundle.issues];
			break;
		case "debt":
			records = bundle.entities.filter((entity) => entity.kind === "debt");
			break;
		case "graph":
			records = bundle.entities;
			break;
		default:
			throw new Error(`Initiative tab ${input.tab} is not supported.`);
	}

	const recordIds = new Set(records.map((record) => record.id));
	return {
		tab: input.tab,
		records,
		relations: (await listAllRelations(executor)).filter(
			(relation) => recordIds.has(relation.fromId) && recordIds.has(relation.toId)
		)
	};
}

export async function getDatabaseSnapshot(executor: TenantExecutor, projectIdentity: string | undefined): Promise<DatabaseSnapshot>;
export async function getDatabaseSnapshot(executor: TenantExecutor, projectIdentity: string | undefined, input: { projectId: string }): Promise<ProjectSnapshot>;
export async function getDatabaseSnapshot(
	executor: TenantExecutor,
	projectIdentity: string | undefined,
	input?: { projectId: string }
): Promise<DatabaseSnapshot | ProjectSnapshot> {
	if (input?.projectId) {
		const discovery = await getProjectDiscovery(executor, input);
		if (discovery.kind === "unavailable") {
			return { kind: "unavailable" };
		}

		const project = discovery.projects.find((entry) => entry.project.id === input.projectId)!.project;
		const snapshot = await withCurrentProject(executor, project.id, () => getProjectSnapshot(executor, project));
		return { kind: "available", snapshot };
	}

	const entities = await getAllDerivedEntities(executor);
	const relations = await getAllRelations(executor);
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const statusMap = new Map(entities.map((entity) => [entity.id, entity.status]));

	const orphans = await listOrphans(executor);
	const projectAdrs = await listProjectAdrs(executor);
	const initiativeBundles = await Promise.all(
		initiatives.map((entity) => getInitiativeBundle(executor, entity.id, undefined, statusMap))
	);

	const sharedContext: ContextDetails = await queryContextDetails(executor, projectIdentity);
	const initiativeContexts = await Promise.all(
		initiatives.map((entity) => queryContextDetails(executor, projectIdentity, entity.id))
	);

	return {
		generatedAt: new Date().toISOString(),
		users: await getTenantUserDirectory(executor),
		issueComments: await getIssueCommentPages(executor, entities),
		planEntries: await listSnapshotPlanEntries(executor, entities),
		entities,
		relations,
		orphans,
		projectAdrs,
		initiatives: initiativeBundles,
		contexts: {
			shared: sharedContext,
			initiatives: initiativeContexts
		}
	};
}

async function getProjectSnapshot(executor: TenantExecutor, project: EntityRecord): Promise<DatabaseSnapshot> {
	const allEntities = await getAllDerivedEntities(executor);
	const allRelations = await getAllRelations(executor);
	const selectedIds = collectReachableIds(allRelations.filter((relation) => isStructuralRelationType(relation.type)), project.id);
	const entities = allEntities.filter((entity) => selectedIds.has(entity.id));
	const relations = allRelations.filter((relation) => selectedIds.has(relation.fromId) && selectedIds.has(relation.toId));
	const initiatives = entities.filter((entity) => entity.kind === "initiative");
	const structuralRelations = allRelations.filter((relation) => isStructuralRelationType(relation.type));
	const statusMap = new Map(allEntities.map((entity) => [entity.id, entity.status]));
	const projectAdrs = await listProjectAdrs(executor, project.id);

	return {
		generatedAt: new Date().toISOString(),
		users: await getTenantUserDirectory(executor),
		issueComments: await getIssueCommentPages(executor, entities),
		planEntries: await listSnapshotPlanEntries(executor, entities),
		entities,
		relations,
		orphans: [],
		projectAdrs,
		initiatives: await Promise.all(
			initiatives.map((entity) =>
				getInitiativeBundle(executor, entity.id, collectReachableIds(structuralRelations, entity.id), statusMap)
			)
		),
		contexts: {
			shared: await queryProjectContextDetails(executor, project),
			initiatives: await Promise.all(initiatives.map((entity) => queryProjectContextDetails(executor, project, entity.id)))
		}
	};
}

async function listSnapshotPlanEntries(executor: TenantExecutor, entities: EntityRecord[]): Promise<PlanEntryRecord[]> {
	const store = new PgPlanEntryStore(executor);
	const entryLists = await Promise.all(
		entities
			.filter((entity) => entity.kind === "plan")
			.map((plan) => store.listPlanEntries({ planId: plan.id }))
	);
	return entryLists.flat();
}

async function getTenantUserDirectory(executor: TenantExecutor) {
	const result = await executor.execute(sql`SELECT id, authentication_subject, display_name, updated_at FROM users WHERE tenant_id = ${executor.tenantId} ORDER BY id`);
	return (result.rows as Array<{ id: string; authentication_subject: string; display_name: string | null; updated_at: string }>).map((row) => ({
		id: row.id,
		authenticationSubject: row.authentication_subject,
		displayName: row.display_name,
		updatedAt: row.updated_at
	}));
}

async function getIssueCommentPages(executor: TenantExecutor, entities: EntityRecord[]): Promise<Record<string, IssueCommentPage>> {
	const chains = (await exportCanonicalChains(executor)).issueComments;
	const users = await getTenantUserDirectory(executor);
	return Object.fromEntries(
		entities
			.filter((entity) => entity.kind === "issue")
			.map((issue) => [issue.id, getIssueCommentPage(chains, issue.id, users)])
	);
}

function getIssueCommentPage(
	chains: CanonicalIssueCommentChain[],
	issueId: string,
	users: Awaited<ReturnType<typeof getTenantUserDirectory>>
): IssueCommentPage {
	const comments = chains
		.filter((chain) => chain.head.issueId === issueId)
		.map((chain) => ({
			id: chain.head.id,
			reference: chain.head.reference,
			shortReference: shortEntityReference({ id: chain.head.id, kind: "issueComment", shortReference: chain.head.shortReference }),
			issueId: chain.head.issueId,
			createdBy: chain.head.createdBy,
			updatedBy: chain.head.updatedBy,
			...(!chain.head.tombstone && { body: chain.head.body }),
			referencedIssueIds: chain.head.referencedIssueIds,
			tombstone: chain.head.tombstone,
			revision: chain.head.revision,
			contentHash: chain.head.contentHash,
			createdAt: chain.head.createdAt,
			updatedAt: chain.head.updatedAt
		}))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reference.localeCompare(right.reference));
	const page = comments.slice(-50);
	const userIds = new Set(page.flatMap((comment) => [comment.createdBy, comment.updatedBy]));
	const oldest = page[0];

	return {
		comments: page,
		users: users.filter((user) => userIds.has(user.id)),
		total: comments.length,
		nextBefore: comments.length > page.length && oldest
			? Buffer.from(JSON.stringify({ createdAt: oldest.createdAt, reference: oldest.reference })).toString("base64url")
			: null
	};
}

async function getEntityProjectId(executor: TenantExecutor, entityId: string): Promise<string | null> {
	const result = await executor.execute(sql`
		SELECT project_id FROM entities WHERE tenant_id = ${executor.tenantId} AND id = ${entityId}
	`);
	return (result.rows as Array<{ project_id: string | null }>)[0]?.project_id ?? null;
}

/**
 * The epic a parent-less initiative attaches to, mirroring local's own
 * `resolveDefaultEpicId`: this request's project's epic, so an initiative
 * created from a workspace lands in that workspace's project rather than in
 * the tenant-wide `PROJ0`/`EPIC0` sentinel pair. Falls back to the sentinel
 * epic for a request carrying no identity at all, or for a project that
 * somehow has no epic of its own.
 */
async function resolveDefaultEpicId(executor: TenantExecutor, projectIdentity: string | undefined): Promise<string> {
	const sentinelEpicId = deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId;
	if (!projectIdentity) {
		return sentinelEpicId;
	}

	const projectId = await resolveProjectIdForWrite(executor, projectIdentity);
	const result = await executor.execute(sql`
		SELECT entities.id AS id
		FROM relations
		JOIN entities ON entities.tenant_id = relations.tenant_id AND entities.id = relations.to_id
		WHERE relations.tenant_id = ${executor.tenantId}
			AND relations.from_id = ${projectId}
			AND relations.type = 'contains'
			AND entities.kind = 'epic'
		ORDER BY entities.id
		LIMIT 1
	`);
	return (result.rows as Array<{ id: string }>)[0]?.id ?? sentinelEpicId;
}

/**
 * The project a write lands in when it has no parent to inherit from. A
 * request that carries a `projectIdentity` gets that identity's own project,
 * minted on first use (`getOrCreateProjectByIdentity`) - previously this
 * silently fell back to the `PROJ0` sentinel instead, so a fresh workspace's
 * first issue landed in Default Project while its context landed in a
 * correctly-minted project of its own. Only a request with no identity at all
 * (the tenant-wide backfill in `refreshProjectAssignments`) still resolves to
 * the sentinel, which is the only project it can mean.
 */
async function resolveProjectIdForWrite(executor: TenantExecutor, projectIdentity: string | undefined): Promise<string> {
	if (projectIdentity) {
		return (await getOrCreateProjectByIdentity(executor, projectIdentity)).id;
	}

	return (await getEntityOrThrow(executor, deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId)).id;
}

async function refreshProjectAssignments(executor: TenantExecutor, projectIdentity?: string): Promise<void> {
	const entityResult = await executor.execute(sql`SELECT id, kind FROM entities WHERE tenant_id = ${executor.tenantId}`);
	const relationResult = await executor.execute(sql`
		SELECT from_id, to_id, type FROM relations WHERE tenant_id = ${executor.tenantId}
	`);
	const entities = entityResult.rows as Array<{ id: string; kind: string }>;
	const relations = relationResult.rows as Array<{ from_id: string; to_id: string; type: string }>;
	const assignment = assignEntitiesToProjects(
		entities,
		relations.map((relation) => ({ fromId: relation.from_id, toId: relation.to_id, type: relation.type })),
		deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId
	);
	const fallbackProjectId = await resolveProjectIdForWrite(executor, projectIdentity);

	for (const entity of entities) {
		const projectId = entity.kind === "project" ? entity.id : (assignment.get(entity.id) ?? fallbackProjectId);
		await executor.execute(sql`
			UPDATE entities SET project_id = ${projectId} WHERE tenant_id = ${executor.tenantId} AND id = ${entity.id}
		`);
	}
}

export async function getProjectDiscovery(
	executor: TenantExecutor,
	input?: { projectId?: string }
): Promise<ProjectDiscovery> {
	// Deliberately tenant-wide (as local's is): this is the call that tells a
	// caller which projects exist, so it cannot itself require knowing one.
	const entities = await getTenantEntities(executor);
	const relations = await getTenantRelations(executor);
	const statusMap = new Map(deriveEntityStatuses(entities, relations).map((entity) => [entity.id, entity.status]));
	const derivedEntities = entities.map((entity) => applyDerivedStatus(entity, statusMap));
	const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	const projects = derivedEntities.filter((entity) => entity.kind === "project" && entity.id !== defaultProjectId);
	if (input?.projectId && !projects.some((project) => project.id === input.projectId)) {
		return { kind: "unavailable" };
	}

	return {
		kind: "available",
		projects: projects.map((project) => {
			const epicIds = new Set(
				relations
					.filter((relation) => relation.type === "contains" && relation.fromId === project.id)
					.map((relation) => relation.toId)
			);
			const initiatives = derivedEntities.filter(
				(entity) =>
					entity.kind === "initiative" &&
					relations.some((relation) => relation.type === "contains" && epicIds.has(relation.fromId) && relation.toId === entity.id)
			);

			return {
				project,
				epicCount: epicIds.size,
				initiativeCount: initiatives.length,
				completedInitiativeCount: initiatives.filter((initiative) => initiative.status === "done").length
			};
		})
	};
}

export async function getProjectSummary(executor: TenantExecutor, input: { projectId: string }): Promise<ProjectSummary> {
	const discovery = await getProjectDiscovery(executor, input);
	if (discovery.kind === "unavailable") {
		return discovery;
	}

	const project = discovery.projects.find((entry) => entry.project.id === input.projectId)!.project;
	return withCurrentProject(executor, project.id, async () => {
		const entities = await getAllDerivedEntities(executor);
		const relations = await getAllRelations(executor);
		const contextTermCounts = await executor.execute(sql`SELECT contexts.scope_entity_id AS initiative_id, COUNT(context_terms.id) AS term_count
			FROM contexts
			LEFT JOIN context_terms ON context_terms.tenant_id = contexts.tenant_id AND context_terms.context_key = contexts.key AND context_terms.tombstone = FALSE
			WHERE contexts.tenant_id = ${executor.tenantId} AND contexts.scope_entity_id IS NOT NULL
			GROUP BY contexts.scope_entity_id`);
		const contextTermCountByInitiativeId = new Map(
			(contextTermCounts.rows as Array<{ initiative_id: string; term_count: string }>).map((row) => [row.initiative_id, Number(row.term_count)])
		);
		const structuralRelations = relations.filter((relation) => isStructuralRelationType(relation.type));
		const projectEpicIds = new Set(
			relations
				.filter((relation) => relation.type === "contains" && relation.fromId === project.id)
				.map((relation) => relation.toId)
		);
		const epics = entities.filter((entity) => entity.kind === "epic" && projectEpicIds.has(entity.id));
		const initiativeGroups = epics.map((epic) => ({
			epic: toEntitySummary(epic),
			initiatives: entities
				.filter((entity) => entity.kind === "initiative" && relations.some((relation) => relation.type === "contains" && relation.fromId === epic.id && relation.toId === entity.id))
				.map((initiative) => {
					const reachableIds = collectReachableIds(structuralRelations, initiative.id);
					const reachableEntities = entities.filter((entity) => reachableIds.has(entity.id));
					const issues = entities.filter((entity) => entity.kind === "issue" && reachableIds.has(entity.id));
					return {
						initiative: toEntitySummary(initiative),
						adrCount: reachableEntities.filter((entity) => entity.kind === "adr").length,
						contextTermCount: contextTermCountByInitiativeId.get(initiative.id) ?? 0,
						debtCount: reachableEntities.filter((entity) => entity.kind === "debt").length,
						issueCount: issues.filter((issue) => issue.status !== "deferred").length,
						totalIssueCount: issues.length,
						completedIssueCount: issues.filter((issue) => issue.status === "done").length,
						planCount: reachableEntities.filter((entity) => entity.kind === "plan").length,
						prdCount: reachableEntities.filter((entity) => entity.kind === "prd").length,
						userStoryCount: reachableEntities.filter((entity) => entity.kind === "userStory").length
					};
				})
		}));
		const initiatives = initiativeGroups.flatMap((group) => group.initiatives);

		return {
			kind: "available",
			project: toEntitySummary(project),
			epics: initiativeGroups,
			counts: {
				epics: epics.length,
				initiatives: initiatives.length,
				completedInitiatives: initiatives.filter((initiative) => initiative.initiative.status === "done").length
			}
		};
	});
}

// A cheap aggregate signature of this tenant's own data (ISS191): unlike
// SqliteStore's whole-file stat (one sqlite file can span tenants),
// Postgres RLS already scopes every query below to this tenant alone, so
// count + max(updated_at) per table is both cheap and sufficient - any
// entity/context/term write bumps one of these, and cloud's site never
// actually polls this today (it relies on `change-events.ts`'s push
// broadcast instead), so this exists purely to satisfy the shared seam.
//
// `relations` is the exception: the table has no `updated_at` (a relation is
// never updated - the primary key covers every column but `created_at`, so a
// change is a delete plus an insert), and `created_at` is copied verbatim from
// the incoming payload on synchronize rather than being a local write clock.
// Count alone therefore misses a swap - unlink one relation, link another, and
// the total is unchanged. Summing a hash of each row's identity closes that:
// it is order-independent, so it needs no sort, and constant-memory, so it
// costs one extra aggregate over a scan `count(*)` was doing anyway rather
// than building a digest string proportional to the relation count.
export async function getSnapshotSignature(executor: TenantExecutor): Promise<string> {
	const result = await executor.execute(sql`
		SELECT
			(SELECT count(*) FROM entities WHERE tenant_id = ${executor.tenantId}) AS entity_count,
			(SELECT max(updated_at) FROM entities WHERE tenant_id = ${executor.tenantId}) AS entity_max_updated,
			(SELECT count(*) FROM relations WHERE tenant_id = ${executor.tenantId}) AS relation_count,
			(SELECT sum(hashtext(from_id::text || to_id::text || type)::bigint) FROM relations WHERE tenant_id = ${executor.tenantId}) AS relation_digest,
			(SELECT count(*) FROM contexts WHERE tenant_id = ${executor.tenantId}) AS context_count,
			(SELECT max(updated_at) FROM contexts WHERE tenant_id = ${executor.tenantId}) AS context_max_updated,
			(SELECT count(*) FROM context_terms WHERE tenant_id = ${executor.tenantId}) AS term_count,
			(SELECT max(updated_at) FROM context_terms WHERE tenant_id = ${executor.tenantId}) AS term_max_updated
	`);
	const row = (result.rows as Array<{
		entity_count: string;
		entity_max_updated: string | null;
		relation_count: string;
		relation_digest: string | null;
		context_count: string;
		context_max_updated: string | null;
		term_count: string;
		term_max_updated: string | null;
	}>)[0]!;
	return [
		`entities:${row.entity_count}:${row.entity_max_updated}`,
		`relations:${row.relation_count}:${row.relation_digest}`,
		`contexts:${row.context_count}:${row.context_max_updated}`,
		`terms:${row.term_count}:${row.term_max_updated}`
	].join("|");
}

/**
 * The entity/relation feature class (ADR "Backends mirror one another per
 * feature, behind all-async feature interfaces"): a thin wrapper over the
 * executor-holding free functions above, constructed fresh inside one
 * `PgStore` transaction and composed alongside the other three feature
 * classes.
 */
export class PgEntityStore implements EntityStore {
	public constructor(
		private readonly executor: TenantExecutor,
		private readonly projectIdentity?: string
	) {}

	public async createEntity(input: {
		kind: string;
		title: string;
		parentId?: string;
		status?: string;
		body?: string;
		category?: string;
		priority?: string;
		type?: string;
		author?: string;
		links?: Array<{ relationType: string; targetId: string }>;
	}, actorId?: string): Promise<EntitySummary> {
		return toEntitySummary(await createEntity(this.executor, input, this.projectIdentity, actorId));
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		return getEntityDetails(this.executor, entityId, this.projectIdentity !== undefined);
	}

	public async queryEntityRelations(input: Parameters<EntityStore["queryEntityRelations"]>[0]): ReturnType<EntityStore["queryEntityRelations"]> {
		return queryEntityRelations(this.executor, input, this.projectIdentity !== undefined);
	}

	public async listEntities(kind: string): ReturnType<EntityStore["listEntities"]> {
		return listEntities(this.executor, kind);
	}

	public async queryEntities(input: Parameters<EntityStore["queryEntities"]>[0]) {
		return queryEntities(this.executor, input);
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return listEntityHistory(this.executor, entityId);
	}

	public async listAllRelations(): Promise<RelationRecord[]> {
		return listAllRelations(this.executor);
	}

	public async applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return applyRelations(this.executor, relations);
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		return listOrphans(this.executor, kind);
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return listProjectAdrs(this.executor);
	}

	public async updateEntityStatus(input: Parameters<EntityStore["updateEntityStatus"]>[0], actorId?: string): Promise<StatusUpdateResult> {
		return updateEntityStatus(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; category?: string; priority?: string; type?: string | null; author?: string; expectedRevision: number; expectedContentHash: string }, actorId?: string): Promise<EntityRecord> {
		return updateEntity(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }, actorId?: string): Promise<EntityRecord> {
		return setEntityBody(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }): Promise<MaterializedEntityRevision> {
		return materializeEntityRevision(this.executor, input);
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }, actorId?: string): Promise<MaterializedEntityRevision> {
		return restoreEntityRevision(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async archiveEntity(input: { entityId: string }, actorId?: string): Promise<StatusUpdateResult> {
		return archiveEntity(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async deleteEntity(input: { entityId: string }, actorId?: string): Promise<DeleteResult> {
		return deleteEntity(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }, actorId?: string): Promise<MoveResult> {
		return moveEntity(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }, actorId?: string): Promise<LinkResult> {
		return linkEntities(this.executor, input, actorId ?? SYSTEM_USER_ID);
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return unlinkEntities(this.executor, input);
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		if (input) {
			return getDatabaseSnapshot(this.executor, this.projectIdentity, input);
		}

		return getDatabaseSnapshot(this.executor, this.projectIdentity);
	}

	public async getProjectSummary(input: { projectId: string }): Promise<ProjectSummary> {
		return getProjectSummary(this.executor, input);
	}

	public async getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return getProjectDiscovery(this.executor, input);
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return getInitiativeBundle(this.executor, initiativeId);
	}

	public async getInitiativeDetail(input: { initiativeId: string }): Promise<InitiativeDetail> {
		return getInitiativeDetail(this.executor, input);
	}

	public async getInitiativeTab(input: { initiativeId: string; tab: InitiativeTab }): Promise<InitiativeTabData> {
		return getInitiativeTab(this.executor, input);
	}

	public async getSnapshotSignature(): Promise<string> {
		return getSnapshotSignature(this.executor);
	}
}
