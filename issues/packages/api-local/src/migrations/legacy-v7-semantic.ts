import {
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	computeContextContentHash,
	computeContextTermContentHash,
	computeEntityContentHash,
	createReverseFieldPatch,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	deriveMigratedContextIdentity,
	deriveMigratedContextTermId,
	deriveMigratedEntityIdentity,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	ENTITY_KINDS,
	ENTITY_REVERSE_PATCH_REGISTRY,
	formatTenantDisplayName,
	ID_PREFIX,
	isEntityKind,
	RESERVED_SYSTEM_AUTHOR,
	resolveWellKnownLocalTenantId,
	type EntityKind
} from "@agent-issues/core";
import { sql } from "drizzle-orm";
import type { SqliteInternalConnection } from "../db/sqlite-executor.js";

export type LegacySqliteV7Rows = Record<
	"context_terms" | "contexts" | "counters" | "entities" | "relations" | "revision_entries",
	Array<Record<string, unknown>>
>;

export type LegacySqliteV7RevisionValidation = {
	projectId: string;
	recordKind: "entity" | "context" | "context-term";
	recordKey: string;
	state: object;
	tenantId: string;
};

type Counter = { tenant_id: string; kind: string; next_value: number };
type Entity = {
	tenant_id: string;
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string;
	created_at: string;
	updated_at: string;
};
type Relation = { tenant_id: string; from_id: string; to_id: string; type: string; created_at: string };
type Context = {
	tenant_id: string;
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	created_at: string;
	updated_at: string;
};
type Term = {
	tenant_id: string;
	context_key: string;
	term: string;
	definition: string;
	avoid_terms: string;
	created_at: string;
	updated_at: string;
};
type Handoff = {
	tenant_id: string;
	id: string;
	entity_id: string;
	initiative_id: string | null;
	summary: string;
	body: string;
	created_at: string;
};
type ScopedEntity = Entity & { parent_id: string | null; project_id: string };
type ScopedContext = Context & { project_id: string };
type Identity = { tenantId: string; legacyId: string; stableId: string; reference: string; kind: EntityKind };
type Model = {
	counters: Counter[];
	entities: Entity[];
	relations: Relation[];
	contexts: Context[];
	terms: Term[];
	handoffs: Handoff[];
	migrationTimestamp: string;
	projectHints: Map<string, string>;
};

const STRUCTURAL_RELATIONS = new Set(["contains", "owns", "records", "tracks", "creates", "decomposes"]);

export function buildLegacySqliteV7Rows(
	database: SqliteInternalConnection,
	tablePrefix = "",
	revisionValidation?: LegacySqliteV7RevisionValidation[]
): LegacySqliteV7Rows {
	const currentTenantId = database.tenantId;
	if (!currentTenantId) throw new Error("SQLite legacy v7 direct migration requires the current tenant id.");
	const model: Model = {
		contexts: readRows(database, `${tablePrefix}contexts`),
		counters: readRows(database, `${tablePrefix}counters`),
		entities: readRows(database, `${tablePrefix}entities`),
		handoffs: readRows(database, `${tablePrefix}handoffs`),
		migrationTimestamp: "",
		projectHints: new Map(),
		relations: readRows(database, `${tablePrefix}relations`),
		terms: readRows(database, `${tablePrefix}context_terms`)
	};
	model.migrationTimestamp = latestLegacyTimestamp(model);
	const tenantIds = new Set([
		currentTenantId,
		...model.entities.map(({ tenant_id }) => tenant_id),
		...model.contexts.map(({ tenant_id }) => tenant_id),
		...model.handoffs.map(({ tenant_id }) => tenant_id)
	]);
	const localTenantId = resolveWellKnownLocalTenantId();
	bootstrapTenant(model, currentTenantId);
	for (const tenantId of [...tenantIds].sort()) {
		if (tenantId !== currentTenantId && tenantId !== localTenantId) consolidateTenant(model, tenantId, localTenantId);
	}
	convertHandoffs(model);
	const entities = resolveProjects(model.entities, model.relations, model.projectHints);
	const contexts = resolveContextProjects(model.contexts, entities);
	const identities = buildIdentities(entities);
	const identityMap = new Map(identities.map((identity) => [key(identity.tenantId, identity.legacyId), identity]));
	return buildFinalRows(model, entities, contexts, identityMap, revisionValidation);
}

function bootstrapTenant(model: Model, tenantId: string): void {
	const now = model.migrationTimestamp;
	insertEntity(model.entities, {
		body: "", body_source: "generated", created_at: now, id: DEFAULT_PROJECT_ID, kind: "project",
		status: "active", tenant_id: tenantId, title: DEFAULT_PROJECT_TITLE, updated_at: now
	});
	insertEntity(model.entities, {
		body: "", body_source: "generated", created_at: now, id: DEFAULT_EPIC_ID, kind: "epic",
		status: "active", tenant_id: tenantId, title: DEFAULT_EPIC_TITLE, updated_at: now
	});
	insertRelation(model.relations, { created_at: now, from_id: DEFAULT_PROJECT_ID, tenant_id: tenantId, to_id: DEFAULT_EPIC_ID, type: "contains" });
	for (const entity of model.entities.filter((row) => row.tenant_id === tenantId && row.kind === "initiative")) {
		if (!model.relations.some((relation) => relation.tenant_id === tenantId && relation.to_id === entity.id && relation.type === "contains")) {
			insertRelation(model.relations, { created_at: now, from_id: DEFAULT_EPIC_ID, tenant_id: tenantId, to_id: entity.id, type: "contains" });
		}
	}
	for (const kind of [...ENTITY_KINDS, "handoff"]) ensureCounter(model.counters, tenantId, kind);
}

function consolidateTenant(model: Model, sourceTenantId: string, targetTenantId: string): void {
	bootstrapTenant(model, targetTenantId);
	const now = model.migrationTimestamp;
	const sourceEntities = model.entities.filter((entity) => entity.tenant_id === sourceTenantId);
	const idMap = new Map<string, string>();
	const projectId = mintEntityId(model.counters, targetTenantId, "project");
	const epicId = mintEntityId(model.counters, targetTenantId, "epic");
	idMap.set(DEFAULT_PROJECT_ID, projectId);
	idMap.set(DEFAULT_EPIC_ID, epicId);
	for (const entity of sourceEntities) {
		if (entity.id === DEFAULT_PROJECT_ID || entity.id === DEFAULT_EPIC_ID) continue;
		if (!isEntityKind(entity.kind)) throw new Error(`Cannot consolidate entity ${entity.id} with unknown kind ${entity.kind}.`);
		idMap.set(entity.id, mintEntityId(model.counters, targetTenantId, entity.kind));
	}
	model.entities.push(
		{ body: "", body_source: "generated", created_at: now, id: projectId, kind: "project", status: "active", tenant_id: targetTenantId, title: formatTenantDisplayName(sourceTenantId) || sourceTenantId, updated_at: now },
		{ body: "", body_source: "generated", created_at: now, id: epicId, kind: "epic", status: "active", tenant_id: targetTenantId, title: DEFAULT_EPIC_TITLE, updated_at: now }
	);
	model.projectHints.set(key(targetTenantId, projectId), projectId);
	model.projectHints.set(key(targetTenantId, epicId), projectId);
	insertRelation(model.relations, { created_at: now, from_id: projectId, tenant_id: targetTenantId, to_id: epicId, type: "contains" });
	for (const entity of sourceEntities) {
		if (entity.id !== DEFAULT_PROJECT_ID && entity.id !== DEFAULT_EPIC_ID) {
			const id = requireMappedId(idMap, entity.id);
			model.entities.push({ ...entity, id, tenant_id: targetTenantId });
			model.projectHints.set(key(targetTenantId, id), projectId);
		}
	}
	for (const relation of model.relations.filter((row) => row.tenant_id === sourceTenantId)) {
		const fromId = idMap.get(relation.from_id);
		const toId = idMap.get(relation.to_id);
		if (fromId && toId) insertRelation(model.relations, { ...relation, from_id: fromId, tenant_id: targetTenantId, to_id: toId });
	}
	for (const entity of sourceEntities.filter(({ kind }) => kind === "initiative")) {
		const id = requireMappedId(idMap, entity.id);
		if (!model.relations.some((relation) => relation.tenant_id === targetTenantId && relation.to_id === id && relation.type === "contains")) {
			insertRelation(model.relations, { created_at: now, from_id: epicId, tenant_id: targetTenantId, to_id: id, type: "contains" });
		}
	}
	const contextKeys = new Map<string, string>();
	for (const context of model.contexts.filter((row) => row.tenant_id === sourceTenantId)) {
		const scopeId = context.scope_entity_id === null ? null : idMap.get(context.scope_entity_id) ?? null;
		const contextKey = context.scope_entity_id === null ? `default:${projectId}` : scopeId ?? context.key;
		contextKeys.set(context.key, contextKey);
		model.contexts.push({ ...context, key: contextKey, scope_entity_id: scopeId, tenant_id: targetTenantId });
	}
	for (const term of model.terms.filter((row) => row.tenant_id === sourceTenantId)) {
		model.terms.push({ ...term, context_key: contextKeys.get(term.context_key) ?? term.context_key, tenant_id: targetTenantId });
	}
	for (const handoff of model.handoffs.filter((row) => row.tenant_id === sourceTenantId)) {
		model.handoffs.push({
			...handoff,
			entity_id: requireMappedId(idMap, handoff.entity_id),
			id: mintHandoffId(model.counters, targetTenantId),
			initiative_id: handoff.initiative_id === null ? null : requireMappedId(idMap, handoff.initiative_id),
			tenant_id: targetTenantId
		});
	}
	removeTenant(model.counters, sourceTenantId);
	removeTenant(model.entities, sourceTenantId);
	removeTenant(model.relations, sourceTenantId);
	removeTenant(model.contexts, sourceTenantId);
	removeTenant(model.terms, sourceTenantId);
	removeTenant(model.handoffs, sourceTenantId);
}

function convertHandoffs(model: Model): void {
	for (const handoff of model.handoffs) {
		model.entities.push({
			body: handoff.body,
			body_source: "authored",
			created_at: handoff.created_at,
			id: handoff.id,
			kind: "handoff",
			status: "active",
			tenant_id: handoff.tenant_id,
			title: handoff.summary.trim() === "" ? `Handoff ${handoff.id}` : handoff.summary,
			updated_at: handoff.created_at
		});
		const focusProject = model.projectHints.get(key(handoff.tenant_id, handoff.entity_id));
		if (focusProject !== undefined) model.projectHints.set(key(handoff.tenant_id, handoff.id), focusProject);
		insertRelation(model.relations, { created_at: handoff.created_at, from_id: handoff.id, tenant_id: handoff.tenant_id, to_id: handoff.entity_id, type: "handsOff" });
		const sequence = Number.parseInt(/\d+$/.exec(handoff.id)?.[0] ?? "", 10);
		const counter = ensureCounter(model.counters, handoff.tenant_id, "handoff");
		if (Number.isInteger(sequence)) counter.next_value = Math.max(counter.next_value, sequence + 1);
	}
}

function resolveProjects(entities: Entity[], relations: Relation[], projectHints: ReadonlyMap<string, string>): ScopedEntity[] {
	const parents = Map.groupBy(relations.filter(({ type }) => STRUCTURAL_RELATIONS.has(type)), (relation) => key(relation.tenant_id, relation.to_id));
	const entityMap = new Map(entities.map((entity) => [key(entity.tenant_id, entity.id), entity]));
	const projects = Map.groupBy(entities.filter(({ kind }) => kind === "project"), ({ tenant_id }) => tenant_id);
	const resolved = new Map<string, string>();
	const visiting = new Set<string>();
	const resolve = (entity: Entity, path: string[]): string => {
		const entityKey = key(entity.tenant_id, entity.id);
		const cached = resolved.get(entityKey);
		if (cached) return cached;
		if (visiting.has(entityKey)) throw new Error(`Legacy v7 structural ancestry cycle: ${[...path, entity.id].join(" -> ")}.`);
		if (entity.kind === "project") return entity.id;
		const parentIds = [...new Set((parents.get(entityKey) ?? []).map(({ from_id }) => from_id))].sort();
		if (parentIds.length > 1) throw new Error(`Legacy v7 entity ${entity.id} has ambiguous structural parents: ${parentIds.join(", ")}.`);
		visiting.add(entityKey);
		const hintedProject = projectHints.get(entityKey);
		const candidates = parentIds.length === 0
			? hintedProject === undefined ? (projects.get(entity.tenant_id) ?? []).map(({ id }) => id) : [hintedProject]
			: parentIds.map((parentId) => resolve(requireEntity(entityMap, entity.tenant_id, parentId), [...path, entity.id]));
		visiting.delete(entityKey);
		const projectIds = [...new Set(candidates)].sort();
		if (projectIds.length !== 1) throw new Error(`Legacy v7 entity ${entity.id} has ${projectIds.length} project ancestors: ${projectIds.join(", ") || "none"}.`);
		resolved.set(entityKey, projectIds[0]!);
		return projectIds[0]!;
	};
	return entities.map((entity) => {
		const parentIds = [...new Set((parents.get(key(entity.tenant_id, entity.id)) ?? []).map(({ from_id }) => from_id))];
		return { ...entity, parent_id: parentIds.length === 1 ? parentIds[0]! : null, project_id: resolve(entity, []) };
	});
}

function resolveContextProjects(contexts: Context[], entities: ScopedEntity[]): ScopedContext[] {
	const entityMap = new Map(entities.map((entity) => [key(entity.tenant_id, entity.id), entity]));
	const projects = Map.groupBy(entities.filter(({ kind }) => kind === "project"), ({ tenant_id }) => tenant_id);
	return contexts.map((context) => {
		const scoped = context.scope_entity_id === null ? undefined : entityMap.get(key(context.tenant_id, context.scope_entity_id));
		const defaultProject = context.key === "default" ? DEFAULT_PROJECT_ID : context.key.startsWith("default:") ? context.key.slice(8) : undefined;
		const keyed = entityMap.get(key(context.tenant_id, defaultProject ?? context.key));
		const candidates = new Set<string>();
		if (scoped) candidates.add(scoped.project_id);
		if (keyed) candidates.add(keyed.project_id);
		if (context.scope_entity_id === null && keyed === undefined) for (const project of projects.get(context.tenant_id) ?? []) candidates.add(project.id);
		if (candidates.size !== 1) throw new Error(`Legacy v7 context ${context.key} must resolve exactly one project scope; found ${[...candidates].sort().join(", ") || "none"}.`);
		return { ...context, project_id: [...candidates][0]! };
	});
}

function buildIdentities(entities: ScopedEntity[]): Identity[] {
	const identities = entities.map((entity): Identity => {
		if (!isEntityKind(entity.kind)) throw new Error(`Cannot migrate entity ${entity.id} with unknown kind ${entity.kind}.`);
		return { kind: entity.kind, legacyId: entity.id, tenantId: entity.tenant_id, ...deriveMigratedEntityIdentity(entity.kind, entity.id) };
	});
	for (const property of ["legacyId", "stableId", "reference"] as const) {
		const values = new Set<string>();
		for (const identity of identities) {
			const value = key(identity.tenantId, identity[property]);
			if (values.has(value)) throw new Error(`Legacy v7 identity mapping is not unique for ${identity[property]}.`);
			values.add(value);
		}
	}
	return identities;
}

function buildFinalRows(
	model: Model,
	entities: ScopedEntity[],
	contexts: ScopedContext[],
	identities: ReadonlyMap<string, Identity>,
	revisionValidation?: LegacySqliteV7RevisionValidation[]
): LegacySqliteV7Rows {
	const revisionEntries: Array<Record<string, unknown>> = [];
	const finalEntities = entities.map((entity) => {
		const identity = requireIdentity(identities, entity.tenant_id, entity.id);
		const projectId = requireIdentity(identities, entity.tenant_id, entity.project_id).stableId;
		const state = {
			body: entity.body,
			bodySource: entity.body_source,
			parentId: entity.parent_id === null ? null : requireIdentity(identities, entity.tenant_id, entity.parent_id).stableId,
			status: entity.status,
			title: entity.title,
			tombstone: false
		};
		revisionValidation?.push({ projectId, recordKey: encodeEntityRecordKey(identity.stableId), recordKind: "entity", state, tenantId: entity.tenant_id });
		addRevision(revisionEntries, `legacy-head:${entity.tenant_id}:${identity.stableId}`, entity.tenant_id, projectId, "entity", encodeEntityRecordKey(identity.stableId), entity.updated_at, createReverseFieldPatch(state, state, ENTITY_REVERSE_PATCH_REGISTRY));
		return {
			body: entity.body,
			body_source: entity.body_source,
			content_hash: computeEntityContentHash(entity.title, entity.body),
			created_at: entity.created_at,
			id: identity.stableId,
			kind: entity.kind,
			project_id: projectId,
			reference: identity.reference,
			revision: 1,
			status: entity.status,
			tenant_id: entity.tenant_id,
			title: entity.title,
			tombstone: 0,
			updated_at: entity.updated_at
		};
	});
	const finalContexts = contexts.map((context) => {
		const identity = deriveMigratedContextIdentity(context.key);
		const projectId = requireIdentity(identities, context.tenant_id, context.project_id).stableId;
		const state = { summary: context.summary, title: context.title };
		revisionValidation?.push({ projectId, recordKey: encodeContextRecordKey(identity.stableId), recordKind: "context", state, tenantId: context.tenant_id });
		addRevision(revisionEntries, `legacy-context:${context.tenant_id}:${identity.stableId}`, context.tenant_id, projectId, "context", encodeContextRecordKey(identity.stableId), context.updated_at, createReverseFieldPatch(state, state, CONTEXT_REVERSE_PATCH_REGISTRY));
		return {
			content_hash: computeContextContentHash(context.title, context.summary),
			created_at: context.created_at,
			id: identity.stableId,
			key: context.key,
			reference: identity.reference,
			revision: 1,
			scope_entity_id: context.scope_entity_id === null ? null : requireIdentity(identities, context.tenant_id, context.scope_entity_id).stableId,
			summary: context.summary,
			tenant_id: context.tenant_id,
			title: context.title,
			updated_at: context.updated_at
		};
	});
	const projectByContext = new Map(contexts.map((context) => [key(context.tenant_id, context.key), context.project_id]));
	const finalTerms = model.terms.map((term) => {
		const id = deriveMigratedContextTermId(term.context_key, term.term);
		const project = projectByContext.get(key(term.tenant_id, term.context_key));
		if (!project) throw new Error(`Legacy v7 context term ${term.context_key}:${term.term} has no project scope.`);
		const avoid = parseAvoid(term.avoid_terms);
		const state = { avoid, definition: term.definition, term: term.term, tombstone: false };
		revisionValidation?.push({ projectId: requireIdentity(identities, term.tenant_id, project).stableId, recordKey: encodeContextTermRecordKey(id), recordKind: "context-term", state, tenantId: term.tenant_id });
		addRevision(revisionEntries, `legacy-term:${term.tenant_id}:${id}`, term.tenant_id, requireIdentity(identities, term.tenant_id, project).stableId, "context-term", encodeContextTermRecordKey(id), term.updated_at, createReverseFieldPatch(state, state, CONTEXT_TERM_REVERSE_PATCH_REGISTRY));
		return {
			avoid_terms: term.avoid_terms,
			content_hash: computeContextTermContentHash(term.term, term.definition, avoid, false),
			context_key: term.context_key,
			created_at: term.created_at,
			definition: term.definition,
			id,
			revision: 1,
			tenant_id: term.tenant_id,
			term: term.term,
			tombstone: 0,
			updated_at: term.updated_at
		};
	});
	return {
		context_terms: finalTerms,
		contexts: finalContexts,
		counters: model.counters,
		entities: finalEntities,
		relations: model.relations.map((relation) => ({
			...relation,
			from_id: requireIdentity(identities, relation.tenant_id, relation.from_id).stableId,
			to_id: requireIdentity(identities, relation.tenant_id, relation.to_id).stableId
		})),
		revision_entries: revisionEntries
	};
}

function addRevision(
	rows: Array<Record<string, unknown>>,
	id: string,
	tenantId: string,
	projectId: string,
	recordKind: "entity" | "context" | "context-term",
	recordKey: string,
	createdAt: string,
	patch: { patchFormat: number; reversePatch: Uint8Array; sourceHash: string; targetHash: string }
): void {
	rows.push({
		author: RESERVED_SYSTEM_AUTHOR,
		created_at: createdAt,
		id,
		patch_format: patch.patchFormat,
		project_id: projectId,
		record_key: recordKey,
		record_kind: recordKind,
		restored_from_revision: null,
		reverse_patch: Buffer.from(patch.reversePatch),
		revision: 1,
		source_hash: Buffer.from(patch.sourceHash, "hex"),
		target_hash: Buffer.from(patch.targetHash, "hex"),
		tenant_id: tenantId
	});
}

function readRows<Row>(database: SqliteInternalConnection, table: string): Row[] {
	return database.drizzle.all<Row>(sql`SELECT * FROM ${sql.identifier(table)} ORDER BY rowid`);
}

function insertEntity(entities: Entity[], entity: Entity): void {
	if (!entities.some((row) => row.tenant_id === entity.tenant_id && row.id === entity.id)) entities.push(entity);
}

function insertRelation(relations: Relation[], relation: Relation): void {
	if (!relations.some((row) => row.tenant_id === relation.tenant_id && row.from_id === relation.from_id && row.to_id === relation.to_id && row.type === relation.type)) relations.push(relation);
}

function ensureCounter(counters: Counter[], tenantId: string, kind: string): Counter {
	let counter = counters.find((row) => row.tenant_id === tenantId && row.kind === kind);
	if (!counter) {
		counter = { kind, next_value: 1, tenant_id: tenantId };
		counters.push(counter);
	}
	return counter;
}

function mintEntityId(counters: Counter[], tenantId: string, kind: EntityKind): string {
	const counter = ensureCounter(counters, tenantId, kind);
	const id = `${ID_PREFIX[kind]}${counter.next_value}`;
	counter.next_value++;
	return id;
}

function mintHandoffId(counters: Counter[], tenantId: string): string {
	const counter = ensureCounter(counters, tenantId, "handoff");
	const id = `HO${counter.next_value}`;
	counter.next_value++;
	return id;
}

function removeTenant<Row extends { tenant_id: string }>(rows: Row[], tenantId: string): void {
	for (let index = rows.length - 1; index >= 0; index--) if (rows[index]?.tenant_id === tenantId) rows.splice(index, 1);
}

function requireMappedId(ids: ReadonlyMap<string, string>, id: string): string {
	const mapped = ids.get(id);
	if (!mapped) throw new Error(`Cannot map consolidated legacy v7 entity ${id}.`);
	return mapped;
}

function requireEntity(entities: ReadonlyMap<string, Entity>, tenantId: string, id: string): Entity {
	const entity = entities.get(key(tenantId, id));
	if (!entity) throw new Error(`Legacy v7 structural parent ${id} is missing for tenant ${tenantId}.`);
	return entity;
}

function requireIdentity(identities: ReadonlyMap<string, Identity>, tenantId: string, id: string): Identity {
	const identity = identities.get(key(tenantId, id));
	if (!identity) throw new Error(`Cannot map legacy v7 entity reference ${id} for tenant ${tenantId}.`);
	return identity;
}

function key(tenantId: string, id: string): string {
	return `${tenantId}\0${id}`;
}

function parseAvoid(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function latestLegacyTimestamp(model: Model): string {
	const timestamps = [
		...model.entities.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
		...model.relations.map(({ created_at }) => created_at),
		...model.contexts.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
		...model.terms.flatMap(({ created_at, updated_at }) => [created_at, updated_at]),
		...model.handoffs.map(({ created_at }) => created_at)
	].filter((timestamp) => timestamp.length > 0).sort();
	return timestamps.at(-1) ?? "1970-01-01T00:00:00.000Z";
}
