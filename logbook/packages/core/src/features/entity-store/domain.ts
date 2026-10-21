import { createHash } from "node:crypto";
import type { ReverseFieldPatchTransition } from "../reverse-field-patch/reverse-field-patch.js";
import type { CodeCompatibility } from "../workspace-observation/workspace-observation.js";

export const ENTITY_KINDS = ["project", "epic", "version", "initiative", "prd", "userStory", "adr", "issue", "debt", "handoff", "plan"] as const;

export const ENTITY_CATEGORIES = ["technical", "product", "operational", "security", "process", "other"] as const;

export const ENTITY_PRIORITIES = ["low", "medium", "high", "critical"] as const;

export const ENTITY_TYPES = {
	issue: ["pioneer-map", "pioneer-ticket"]
} as const;

export const BODY_SOURCES = ["authored", "generated"] as const;

export const STATUS_FLOW = {
	project: ["draft", "active", "paused", "done"],
	epic: ["draft", "active", "paused", "done"],
	version: ["draft", "active", "paused", "done"],
	initiative: ["draft", "active", "paused", "done"],
	prd: ["draft", "in-progress", "approved", "superseded"],
	userStory: ["draft", "ready", "in-progress", "done", "superseded"],
	adr: ["current", "superseded", "archived"],
	issue: ["todo", "in-progress", "blocked", "deferred", "done"],
	debt: ["open", "resolved", "archived"],
	handoff: ["active", "done"],
	plan: ["draft", "in-progress", "ready", "superseded"]
} as const;

export const ID_PREFIX = {
	project: "PROJ",
	epic: "EPIC",
	version: "VER",
	initiative: "INIT",
	prd: "PRD",
	userStory: "US",
	adr: "ADR",
	issue: "ISS",
	debt: "DEBT",
	handoff: "HO",
	plan: "PLAN"
} as const;

export const ALLOWED_RELATIONS = [
	{ fromKind: "project", toKind: "epic", type: "contains" },
	{ fromKind: "epic", toKind: "initiative", type: "contains" },
	{ fromKind: "project", toKind: "version", type: "owns" },
	{ fromKind: "initiative", toKind: "version", type: "taggedWith" },
	{ fromKind: "issue", toKind: "version", type: "taggedWith" },
	{ fromKind: "initiative", toKind: "initiative", type: "supersedes" },
	{ fromKind: "initiative", toKind: "prd", type: "owns" },
	{ fromKind: "initiative", toKind: "plan", type: "owns" },
	{ fromKind: "prd", toKind: "prd", type: "supersedes" },
	{ fromKind: "plan", toKind: "prd", type: "informs" },
	{ fromKind: "project", toKind: "adr", type: "records" },
	{ fromKind: "epic", toKind: "adr", type: "records" },
	{ fromKind: "initiative", toKind: "adr", type: "records" },
	{ fromKind: "project", toKind: "debt", type: "records" },
	{ fromKind: "epic", toKind: "debt", type: "records" },
	{ fromKind: "initiative", toKind: "debt", type: "records" },
	{ fromKind: "issue", toKind: "debt", type: "records" },
	{ fromKind: "initiative", toKind: "issue", type: "tracks" },
	{ fromKind: "prd", toKind: "userStory", type: "creates" },
	{ fromKind: "userStory", toKind: "userStory", type: "supersedes" },
	{ fromKind: "issue", toKind: "issue", type: "decomposes" },
	{ fromKind: "issue", toKind: "userStory", type: "fixes" },
	{ fromKind: "adr", toKind: "issue", type: "constrains" },
	{ fromKind: "epic", toKind: "debt", type: "resolves" },
	{ fromKind: "initiative", toKind: "debt", type: "resolves" },
	{ fromKind: "issue", toKind: "debt", type: "resolves" },
	{ fromKind: "adr", toKind: "adr", type: "supersedes" },
	{ fromKind: "issue", toKind: "issue", type: "blocks" },
	{ fromKind: "debt", toKind: "project", type: "relatesTo" },
	{ fromKind: "debt", toKind: "epic", type: "relatesTo" },
	{ fromKind: "debt", toKind: "version", type: "relatesTo" },
	{ fromKind: "debt", toKind: "initiative", type: "relatesTo" },
	{ fromKind: "debt", toKind: "prd", type: "relatesTo" },
	{ fromKind: "debt", toKind: "userStory", type: "relatesTo" },
	{ fromKind: "debt", toKind: "adr", type: "relatesTo" },
	{ fromKind: "debt", toKind: "issue", type: "relatesTo" },
	{ fromKind: "debt", toKind: "debt", type: "relatesTo" },
	{ fromKind: "handoff", toKind: "initiative", type: "handsOff" },
	{ fromKind: "handoff", toKind: "prd", type: "handsOff" },
	{ fromKind: "handoff", toKind: "userStory", type: "handsOff" },
	{ fromKind: "handoff", toKind: "adr", type: "handsOff" },
	{ fromKind: "handoff", toKind: "issue", type: "handsOff" },
	{ fromKind: "handoff", toKind: "debt", type: "handsOff" },
] as const;

export const STRUCTURAL_RELATION_TYPES = ["contains", "owns", "records", "tracks", "creates", "decomposes"] as const;

/**
 * Per-tenant sentinel project/epic synthesized so every initiative always
 * resolves a complete tenant>project>epic>initiative chain (the "full-chain
 * invariant", ADR7). IDs bypass the per-kind counter (which starts at 1), so
 * they can never collide with a counter-allocated id.
 */
export const DEFAULT_PROJECT_ID = "PROJ0";
export const DEFAULT_EPIC_ID = "EPIC0";
export const DEFAULT_PROJECT_TITLE = "Default Project";
export const DEFAULT_EPIC_TITLE = "Default Epic";

/**
 * Derives a human-readable display name from a tenant/legacy-tenant id
 * (e.g. `payments-team` -> `Payments Team`, stripping a trailing 12-hex-char
 * workspace-path hash if present). Pure and dependency-free so both
 * `database.ts` (tenant listing/rename/delete) and the
 * `consolidate-legacy-tenant` migration module (packages/core/src/migrations,
 * ISS180) can title a freshly-minted project without either one importing
 * the other (migrations must not import from database.ts, which already
 * imports from them).
 */
export function formatTenantDisplayName(tenantId: string): string {
	const withoutHashSuffix = tenantId.replace(/-[0-9a-f]{12}$/i, "");
	return withoutHashSuffix
		.split(/[-_]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
		.join(" ");
}

export type EntityKind = (typeof ENTITY_KINDS)[number];
export type EntityCategory = (typeof ENTITY_CATEGORIES)[number];
export type EntityPriority = (typeof ENTITY_PRIORITIES)[number];
export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES][number];
export type BodySource = (typeof BODY_SOURCES)[number];
export type EntityStatus<K extends EntityKind = EntityKind> = (typeof STATUS_FLOW)[K][number];
export type RelationType = (typeof ALLOWED_RELATIONS)[number]["type"];
export type StructuralRelationType = (typeof STRUCTURAL_RELATION_TYPES)[number];

export type EntityRecord = {
	id: string;
	reference: string;
	shortReference: string;
	createdBy: string;
	updatedBy: string;
	kind: EntityKind;
	title: string;
	status: string;
	body: string;
	bodySource: BodySource;
	category: EntityCategory | null;
	priority: EntityPriority | null;
	type: EntityType | null;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
};

export type EntitySummary = Omit<EntityRecord, "body" | "bodySource"> & {
	codeCompatibility?: CodeCompatibility;
};

export function toEntitySummary(entity: EntityRecord): EntitySummary {
	return {
		id: entity.id,
		reference: entity.reference,
		shortReference: entity.shortReference,
		createdBy: entity.createdBy,
		updatedBy: entity.updatedBy,
		kind: entity.kind,
		title: entity.title,
		status: entity.status,
		category: entity.category,
		priority: entity.priority,
		type: entity.type,
		revision: entity.revision,
		contentHash: entity.contentHash,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt
	};
}

/**
 * Computes the canonical content hash for an entity's mutable title and body
 * (ADR55/ISS257). Used to populate `EntityRecord.contentHash` on creation and
 * to validate `expectedContentHash` on generic title/body edits.
 */
export function computeEntityContentHash(title: string, body: string): string {
	return createHash("sha256").update(`${title}\n\n${body}`).digest("hex");
}

/**
 * The typed reverse-patch record stored in `entity_delta_entries`
 * (ADR55/ISS257/ISS261). Each row represents one edit that advanced the entity
 * by one revision. Applying `prior_*` values to the current head walks state
 * back one step. The `status`, `parentId`, and `tombstone` predecessor fields
 * are optional until ISS258 writes lifecycle deltas; parent and tombstone may
 * also explicitly be `null` in a historical state.
 */
export type EntityRevisionPatch = ReverseFieldPatchTransition & {
	revision: number;
	author: string;
	createdAt: string;
	restoredFromRevision?: number;
};

/**
 * Returned by `StorageDriver.materializeEntityRevision` (ISS261). Contains the
 * reconstructed entity facts at `targetRevision` plus the current
 * `headRevision` so callers can see how stale their view is. `status`,
 * `parentId`, and `tombstone` are best-effort from the current head until
 * ISS258 adds lifecycle deltas.
 */
export type MaterializedEntityRevision = {
	entityId: string;
	targetRevision: number;
	headRevision: number;
	title: string;
	body: string;
	bodySource: BodySource;
	category: EntityCategory | null;
	priority: EntityPriority | null;
	type: EntityType | null;
	status: string;
	parentId: string | null;
	tombstone: boolean | null;
	author: string;
	createdAt: string;
	restoredFromRevision: number | null;
};

export type EntityRevisionErrorReason = "entity-not-found" | "revision-out-of-range" | "broken-chain";

/**
 * Thrown when `materializeEntityRevision` cannot satisfy the request
 * (ISS261). The `reason` discriminant lets callers handle each case without
 * parsing the message string.
 */
export class EntityRevisionError extends Error {
	public readonly entityId: string;
	public readonly reason: EntityRevisionErrorReason;
	public readonly headRevision: number | undefined;

	public constructor(entityId: string, reason: EntityRevisionErrorReason, message: string, headRevision?: number) {
		super(message);
		this.name = "EntityRevisionError";
		this.entityId = entityId;
		this.reason = reason;
		this.headRevision = headRevision;
	}
}

/**
 * Thrown when a title/body edit presents a stale `expectedRevision` or
 * `expectedContentHash` that does not match the entity's current head
 * (ADR55/ISS257). Carries the current head's revision and hash so the caller
 * can surface them in a "refresh and retry" error message.
 */
export class EntityConflictError extends Error {
	public readonly entityId: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;

	public constructor(entityId: string, currentRevision: number, currentContentHash: string) {
		super(
			`Stale edit for ${entityId}: expected a matching revision/hash but current revision is ${currentRevision}.`
		);
		this.name = "EntityConflictError";
		this.entityId = entityId;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}
}

export type RelationRecord = {
	fromId: string;
	toId: string;
	type: RelationType;
	createdBy: string;
	createdAt: string;
};

// Reserved author identity for history entries with no real human/agent
// author: seeded backfill entries (ADR8 "history seed") and, until a real
// identity source (e.g. the future auth seam) is wired up, any new write
// that does not supply one.
export const RESERVED_SYSTEM_AUTHOR = "system";

// A materialized entry in an entity's append-only revision history. The
// storage layer reconstructs these facts from `revision_entries` plus the
// current head. `version` is the per-entity revision counter, unrelated to
// the `version` entity kind.
export type HistoryEntryRecord = {
	id: string;
	entityId: string;
	version: number;
	author: string;
	title: string;
	body: string;
	bodySource: BodySource;
	type: EntityType | null;
	status: string;
	parentId: string | null;
	createdAt: string;
};

export function isEntityKind(value: string): value is EntityKind {
	return ENTITY_KINDS.includes(value as EntityKind);
}

export function isEntityCategory(value: string): value is EntityCategory {
	return ENTITY_CATEGORIES.includes(value as EntityCategory);
}

export function isEntityPriority(value: string): value is EntityPriority {
	return ENTITY_PRIORITIES.includes(value as EntityPriority);
}

export function isEntityType(kind: EntityKind, value: string): value is EntityType {
	const allowedTypes = ENTITY_TYPES[kind as keyof typeof ENTITY_TYPES] as readonly string[] | undefined;
	return allowedTypes?.includes(value) ?? false;
}

export function isBodySource(value: string): value is BodySource {
	return BODY_SOURCES.includes(value as BodySource);
}

export function getInitialStatus(kind: EntityKind): EntityStatus {
	return STATUS_FLOW[kind][0];
}

export function isValidStatus(kind: EntityKind, status: string): boolean {
	return (STATUS_FLOW[kind] as readonly string[]).includes(status);
}

export function getAllowedRelationType(fromKind: EntityKind, toKind: EntityKind): RelationType | null {
	const match = ALLOWED_RELATIONS.find((relation) => relation.fromKind === fromKind && relation.toKind === toKind);
	return match?.type ?? null;
}

export function getAllowedRelationTypes(fromKind: EntityKind, toKind: EntityKind): RelationType[] {
	return ALLOWED_RELATIONS
		.filter((relation) => relation.fromKind === fromKind && relation.toKind === toKind)
		.map((relation) => relation.type);
}

export function isAllowedRelation(fromKind: EntityKind, toKind: EntityKind, relationType: string): relationType is RelationType {
	return ALLOWED_RELATIONS.some(
		(relation) =>
			relation.fromKind === fromKind && relation.toKind === toKind && relation.type === relationType
	);
}

export function isStructuralRelationType(relationType: string): relationType is StructuralRelationType {
	return STRUCTURAL_RELATION_TYPES.includes(relationType as StructuralRelationType);
}

export function getArchiveStatus(kind: EntityKind): EntityStatus {
	switch (kind) {
		case "project":
			return "done";
		case "epic":
			return "done";
		case "version":
			return "done";
		case "initiative":
			return "done";
		case "prd":
			return "approved";
		case "userStory":
			return "done";
		case "adr":
			return "archived";
		case "issue":
			return "done";
		case "debt":
			return "archived";
		case "handoff":
			return "done";
		case "plan":
			return "superseded";
	}
}

export function deriveUserStoryStatus(storedStatus: string, fixingIssueStatuses: string[]): string {
	if (fixingIssueStatuses.length === 0) {
		return storedStatus;
	}

	if (fixingIssueStatuses.every((status) => status === "done" || status === "deferred")) {
		return "done";
	}

	if (fixingIssueStatuses.some((status) => status === "in-progress" || status === "blocked" || status === "done")) {
		return "in-progress";
	}

	return "ready";
}

export function isInitiativeComplete(trackedIssueStatuses: string[], ownedPrdStatuses: string[]): boolean {
	if (trackedIssueStatuses.length === 0) {
		return false;
	}

	return (
		trackedIssueStatuses.every((status) => status === "done" || status === "deferred") &&
		ownedPrdStatuses.every((status) => status === "approved" || status === "superseded")
	);
}

/**
 * Whether any of an initiative's tracked issues or owned PRDs shows signs
 * of started work: a tracked issue that has left its initial `todo` status,
 * or an owned PRD that has left its initial `draft` status (itself already
 * derived, so a PRD only reads as started once one of its own stories has).
 */
export function isInitiativeActive(trackedIssueStatuses: string[], ownedPrdStatuses: string[]): boolean {
	return trackedIssueStatuses.some((status) => status !== "todo" && status !== "deferred") || ownedPrdStatuses.some((status) => status !== "draft");
}

export function deriveInitiativeStatus(storedStatus: string, trackedIssueStatuses: string[], ownedPrdStatuses: string[]): string {
	if (isInitiativeComplete(trackedIssueStatuses, ownedPrdStatuses)) {
		return "done";
	}

	if (storedStatus === "draft" && isInitiativeActive(trackedIssueStatuses, ownedPrdStatuses)) {
		return "active";
	}

	return storedStatus;
}

export function isPrdComplete(createdStoryStatuses: string[]): boolean {
	return createdStoryStatuses.length > 0 && createdStoryStatuses.every((status) => status === "done" || status === "superseded");
}

export function derivePrdStatus(storedStatus: string, createdStoryStatuses: string[]): string {
	if (createdStoryStatuses.length === 0) {
		return storedStatus;
	}

	if (isPrdComplete(createdStoryStatuses)) {
		return "approved";
	}

	if (createdStoryStatuses.some((status) => status === "in-progress" || status === "done")) {
		return "in-progress";
	}

	return storedStatus;
}

export function deriveIssueStatus(storedStatus: string, subIssueStatuses: string[]): string {
	if (subIssueStatuses.length === 0 || storedStatus === "deferred") {
		return storedStatus;
	}

	if (subIssueStatuses.some((status) => status !== "done" && status !== "deferred")) {
		return "blocked";
	}

	return storedStatus === "blocked" ? "todo" : storedStatus;
}

export function deriveEntityStatuses<T extends Pick<EntityRecord, "id" | "kind" | "status">>(entities: T[], relations: RelationRecord[]): T[] {
	const storedStatusById = new Map(entities.map((entity) => [entity.id, entity.status]));
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const kindById = new Map(entities.map((entity) => [entity.id, entity.kind]));

	const decomposedSubIssuesByIssue = new Map<string, string[]>();
	const fixingIssuesByStory = new Map<string, string[]>();
	const createdStoriesByPrd = new Map<string, string[]>();
	const trackedIssuesByInitiative = new Map<string, string[]>();
	const ownedPrdsByInitiative = new Map<string, string[]>();
	const supersededRecordIds = new Set<string>();

	const pushTo = (map: Map<string, string[]>, key: string, value: string) => {
		const list = map.get(key);
		if (list) {
			list.push(value);
		} else {
			map.set(key, [value]);
		}
	};

	for (const relation of relations) {
		if (!kindById.has(relation.fromId) || !kindById.has(relation.toId)) {
			continue;
		}

		if (relation.type === "decomposes" && kindById.get(relation.fromId) === "issue" && kindById.get(relation.toId) === "issue") {
			pushTo(decomposedSubIssuesByIssue, relation.fromId, relation.toId);
		} else if (relation.type === "fixes" && kindById.get(relation.fromId) === "issue" && kindById.get(relation.toId) === "userStory") {
			pushTo(fixingIssuesByStory, relation.toId, relation.fromId);
		} else if (relation.type === "creates" && kindById.get(relation.toId) === "userStory") {
			pushTo(createdStoriesByPrd, relation.fromId, relation.toId);
		} else if (relation.type === "tracks" && kindById.get(relation.toId) === "issue") {
			pushTo(trackedIssuesByInitiative, relation.fromId, relation.toId);
		} else if (relation.type === "owns" && kindById.get(relation.toId) === "prd") {
			pushTo(ownedPrdsByInitiative, relation.fromId, relation.toId);
		} else if (
			relation.type === "supersedes" &&
			kindById.get(relation.fromId) === kindById.get(relation.toId) &&
			["adr", "prd", "userStory"].includes(kindById.get(relation.fromId) ?? "")
		) {
			supersededRecordIds.add(relation.toId);
		}
	}

	const derivedStatusById = new Map<string, string>();
	const deriveStatusFor = (entityId: string): string => {
		const cached = derivedStatusById.get(entityId);
		if (cached !== undefined) {
			return cached;
		}

		const entity = entityById.get(entityId);
		if (!entity) {
			return storedStatusById.get(entityId) ?? "";
		}

		const statusesOf = (ids: string[] | undefined) => (ids ?? []).map((id) => deriveStatusFor(id));
		const issueTreeStatusesOf = (ids: string[] | undefined) => {
			const issueIds = new Set(ids);
			for (const issueId of issueIds) {
				for (const childId of decomposedSubIssuesByIssue.get(issueId) ?? []) issueIds.add(childId);
			}
			return statusesOf([...issueIds]);
		};
		let derivedStatus = entity.status;

		if (entity.kind === "issue") {
			derivedStatus = deriveIssueStatus(entity.status, statusesOf(decomposedSubIssuesByIssue.get(entity.id)));
		} else if (entity.kind === "userStory") {
			derivedStatus = deriveUserStoryStatus(entity.status, issueTreeStatusesOf(fixingIssuesByStory.get(entity.id)));
		} else if (entity.kind === "prd") {
			derivedStatus = derivePrdStatus(entity.status, statusesOf(createdStoriesByPrd.get(entity.id)));
		} else if (entity.kind === "initiative") {
			derivedStatus = deriveInitiativeStatus(
				entity.status,
				issueTreeStatusesOf(trackedIssuesByInitiative.get(entity.id)),
				statusesOf(ownedPrdsByInitiative.get(entity.id))
			);
		}

		if (supersededRecordIds.has(entity.id)) {
			derivedStatus = "superseded";
		}

		derivedStatusById.set(entityId, derivedStatus);
		return derivedStatus;
	};

	for (const entity of entities) {
		deriveStatusFor(entity.id);
	}

	return entities.map((entity) => {
		const derived = derivedStatusById.get(entity.id);
		return derived === undefined || derived === entity.status ? entity : { ...entity, status: derived };
	});
}

/**
 * Recovers an entity's `EntityKind` from its id's `ID_PREFIX` (e.g.
 * `ISS42` -> `"issue"`), for call sites (synchronize's resolved-facts
 * application) that only have the bare id string to work with. Pure and
 * dependency-free, so both `PgStore` and `SqliteStore` share one
 * implementation rather than each re-deriving the same prefix table lookup.
 */
export function deriveEntityKindFromId(entityId: string): EntityKind {
	const prefix = /^([A-Za-z]+)\d+$/.exec(entityId)?.[1];
	const found = prefix
		? (Object.entries(ID_PREFIX) as Array<[EntityKind, string]>).find(([, candidatePrefix]) => candidatePrefix === prefix)
		: undefined;

	if (!found) {
		throw new Error(`Cannot derive entity kind from id: ${entityId}`);
	}

	return found[0];
}

/** True when `entity`'s trackable facts (title/body/bodySource/status) already match `resolved`'s - synchronize's no-op guard against writing an identical history entry twice. */
export function factsMatchEntity(entity: EntityRecord, resolved: HistoryEntryRecord): boolean {
	return (
		entity.title === resolved.title &&
		entity.body === resolved.body &&
		entity.bodySource === resolved.bodySource &&
		entity.status === resolved.status
	);
}

/**
 * Breadth-first walk of `relations` from `startId`, returning every id
 * reachable via an outgoing edge (transitively). Used by both stores'
 * `hasTypedPath`/`hasStructuralPath` (structural-move cycle guards) once
 * they've fetched their own relation rows - the graph traversal itself is
 * pure and identical regardless of how those rows were fetched.
 */
export function collectReachableIds(relations: RelationRecord[], startId: string): Set<string> {
	const seen = new Set<string>([startId]);
	const queue = [startId];

	while (queue.length > 0) {
		const currentId = queue.shift();
		if (!currentId) {
			continue;
		}

		for (const relation of relations) {
			if (relation.fromId !== currentId || seen.has(relation.toId)) {
				continue;
			}

			seen.add(relation.toId);
			queue.push(relation.toId);
		}
	}

	return seen;
}

/**
 * True when removing `relation` (a structural edge) would leave its `toId`
 * entity - and everything only reachable through it - unreachable from
 * every initiative (ADR7's "never orphan a subtree" invariant). Takes the
 * full entity/relation graph rather than fetching it, so both stores'
 * `wouldOrphanSubtree` wrappers can fetch their own rows their own way and
 * delegate the actual reachability computation here exactly once. Non-
 * structural relations can never orphan anything by definition and return
 * `false` immediately.
 */
export function wouldOrphanSubtree(entities: EntityRecord[], relations: RelationRecord[], relation: RelationRecord): boolean {
	if (!isStructuralRelationType(relation.type)) {
		return false;
	}

	const remainingRelations = relations.filter(
		(candidate) => !(candidate.fromId === relation.fromId && candidate.toId === relation.toId && candidate.type === relation.type)
	);
	const stillReachable = new Set<string>();

	for (const entity of entities) {
		if (entity.kind !== "initiative") {
			continue;
		}

		for (const id of collectReachableIds(remainingRelations, entity.id)) {
			stillReachable.add(id);
		}
	}

	if (stillReachable.has(relation.toId)) {
		return false;
	}

	return remainingRelations.some((candidate) => candidate.fromId === relation.toId);
}

/**
 * Assigns every entity to exactly one owning `project` (ISS166 follow-up):
 * the project it is structurally reachable from (walking
 * `STRUCTURAL_RELATION_TYPES` edges downward from each `project` root).
 * Entities not reachable from any project - orphans (unattached issues) and
 * parentless project ADRs - fall back to the tenant's sentinel
 * `DEFAULT_PROJECT_ID` when it exists, or the sole project when a tenant has
 * exactly one; a multi-project tenant's genuinely unattributable leftovers
 * are left unassigned (returned map has no entry for them). Pure so both the
 * one-time `project_id` backfill migration and the per-open, per-tenant
 * backfill can share the exact same attribution, each doing its own IO.
 */
export function assignEntitiesToProjects(
	entities: readonly { id: string; kind: string }[],
	relations: readonly { fromId: string; toId: string; type: string }[],
	defaultProjectId = DEFAULT_PROJECT_ID
): Map<string, string> {
	const structuralRelations = relations
		.filter((relation) => isStructuralRelationType(relation.type))
		.map((relation) => ({ ...relation, type: relation.type as StructuralRelationType, createdBy: RESERVED_SYSTEM_AUTHOR, createdAt: "" }));
	const projectIds = entities.filter((entity) => entity.kind === "project").map((entity) => entity.id);
	const assignment = new Map<string, string>();

	for (const projectId of projectIds) {
		for (const reachableId of collectReachableIds(structuralRelations, projectId)) {
			if (!assignment.has(reachableId)) {
				assignment.set(reachableId, projectId);
			}
		}
	}

	const fallbackProjectId = projectIds.includes(defaultProjectId)
		? defaultProjectId
		: projectIds.length === 1
			? projectIds[0]
			: undefined;

	if (fallbackProjectId !== undefined) {
		for (const entity of entities) {
			if (!assignment.has(entity.id)) {
				assignment.set(entity.id, fallbackProjectId);
			}
		}
	}

	return assignment;
}
