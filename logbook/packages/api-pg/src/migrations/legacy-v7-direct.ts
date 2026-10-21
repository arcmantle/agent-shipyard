import {
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	computeContextContentHash,
	computeContextTermContentHash,
	computeEntityContentHash,
	createReverseFieldPatch,
	deriveEntityKindFromId,
	deriveMigratedContextIdentity,
	deriveMigratedContextTermId,
	deriveMigratedEntityIdentity,
	encodeContextRecordKey,
	encodeContextTermRecordKey,
	encodeEntityRecordKey,
	ENTITY_REVERSE_PATCH_REGISTRY,
	isEntityKind,
	materializeContextFromPatches,
	materializeContextTermFromPatches,
	materializeFromPatches,
	RESERVED_SYSTEM_AUTHOR,
	type BodySource,
	type ContextRevisionPatch,
	type ContextTermRevisionPatch,
	type EntityRevisionPatch,
	type EntityKind
} from "@agent-issues/core";
import type { PoolClient } from "pg";

import { createPgMigrationConn } from "../db/migration-runner.js";
import { finalBaselineMigration } from "./final-baseline.js";
import { userDirectoryMigration } from "./user-directory.js";
import { recordProvenanceMigration } from "./record-provenance.js";
import { contextTermProvenanceMigration } from "./context-term-provenance.js";
import { relationProvenanceMigration } from "./relation-provenance.js";
import { issueCommentsMigration } from "./issue-comments.js";
import { debtMetadataMigration } from "./debt-metadata.js";
import { shortEntityReferenceMigration } from "./short-entity-reference.js";
import { shortRecordReferenceMigration } from "./short-record-reference.js";

export const LEGACY_V7_DIRECT_CHECKPOINT = "legacy-v7-direct";
export const LEGACY_V7_DIRECT_APPLIED_MIGRATION_IDS = [
	"final-baseline",
	"user-directory",
	"issue-comments",
	"debt-metadata",
	"short-entity-reference",
	"short-record-reference",
	"record-provenance",
	"context-term-provenance",
	"relation-provenance"
] as const;

const LEGACY_TABLES = ["metadata", "counters", "entities", "relations", "contexts", "context_terms", "history_entries"] as const;
const TENANT_TABLES = ["counters", "users", "entities", "relations", "contexts", "context_terms", "revision_entries", "issue_comments", "issue_comment_references"] as const;

type LegacyEntity = {
	tenant_id: string;
	id: string;
	kind: string;
	title: string;
	status: string;
	body: string;
	body_source: string;
	created_at: string;
	updated_at: string;
	project_id: string | null;
	parent_id: string | null;
	tombstone: boolean;
};

type LegacyCounter = {
	tenant_id: string;
	kind: string;
	next_value: number;
};

type LegacyRelation = {
	tenant_id: string;
	from_id: string;
	to_id: string;
	type: string;
};

type LegacyEntityGraph = {
	entities: LegacyEntity[];
	parentsByKey: Map<string, string[]>;
};

type LegacyHistory = {
	id: string;
	tenant_id: string;
	entity_id: string;
	version: number;
	author: string;
	title: string;
	body: string;
	body_source: string;
	status: string;
	parent_id: string | null;
	created_at: string;
};

type LegacyContext = {
	tenant_id: string;
	key: string;
	scope_entity_id: string | null;
	title: string;
	summary: string;
	created_at: string;
	updated_at: string;
	project_id: string;
};

type LegacyTerm = {
	tenant_id: string;
	context_key: string;
	term: string;
	definition: string;
	avoid_terms: string;
	created_at: string;
	updated_at: string;
};

type EntityIdentity = {
	tenantId: string;
	legacyId: string;
	stableId: string;
	reference: string;
	kind: EntityKind;
};

type EntityState = {
	title: string;
	body: string;
	bodySource: string;
	status: string;
	parentId: string | null;
	tombstone: boolean;
};

type RevisionRow = {
	id: string;
	tenantId: string;
	projectId: string;
	recordKind: "entity" | "context" | "context-term";
	recordKey: string;
	revision: number;
	author: string;
	patchFormat: number;
	reversePatch: string;
	sourceHash: string;
	targetHash: string;
	restoredFromRevision: number | null;
	createdAt: string;
};

type FinalEntityRow = {
	tenant_id: string;
	id: string;
	project_id: string;
	title: string;
	body: string;
	body_source: BodySource;
	status: string;
	revision: number;
	tombstone: boolean;
	created_at: string;
};

type FinalRevisionRow = {
	id: string;
	tenant_id: string;
	project_id: string;
	record_kind: "entity" | "context" | "context-term";
	record_key: string;
	revision: number;
	author: string;
	patch_format: number;
	reverse_patch: Buffer;
	source_hash: Buffer;
	target_hash: Buffer;
	restored_from_revision: number | null;
	created_at: string;
};

export async function transformLegacyPostgresV7(client: PoolClient): Promise<void> {
	const history = (await client.query<LegacyHistory>(`SELECT * FROM history_entries ORDER BY tenant_id, entity_id, version, created_at, id`)).rows;
	const counters = (await client.query<LegacyCounter>(`SELECT tenant_id, kind, next_value FROM counters ORDER BY tenant_id, kind`)).rows;
	const liveGraph = await readLegacyEntities(client, history);
	const graph = recoverDeletedEntities(liveGraph, history, counters);
	const entities = resolveEntityProjects(graph);
	const contexts = await readLegacyContexts(client, entities);
	const terms = (await client.query<LegacyTerm>("SELECT * FROM context_terms ORDER BY tenant_id, context_key, term")).rows;
	const identities = buildIdentities(entities);
	const identityByLegacyKey = new Map(identities.map((identity) => [identityKey(identity.tenantId, identity.legacyId), identity]));
	const revisionRows = buildEntityRevisions(entities, history, identityByLegacyKey);

	await stageLegacyTables(client);
	await finalBaselineMigration.up(createPgMigrationConn(client));
	await userDirectoryMigration.up(createPgMigrationConn(client));
	await issueCommentsMigration.up(createPgMigrationConn(client));
	await debtMetadataMigration.up(createPgMigrationConn(client));
	for (const table of TENANT_TABLES) {
		await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
	}
	await createIdentityMap(client, identities);
	await copyHeads(client, entities, contexts, terms, revisionRows);
	await shortEntityReferenceMigration.up(createPgMigrationConn(client));
	await shortRecordReferenceMigration.up(createPgMigrationConn(client));
	await recordProvenanceMigration.up(createPgMigrationConn(client));
	await contextTermProvenanceMigration.up(createPgMigrationConn(client));
	await relationProvenanceMigration.up(createPgMigrationConn(client));
	await validateTransformation(client, entities, history, contexts, terms);
	await dropLegacyTables(client);
	await client.query(`CREATE TABLE schema_migrations (
		id TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`);
	await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, clock_timestamp())", [LEGACY_V7_DIRECT_CHECKPOINT]);
	for (const migrationId of LEGACY_V7_DIRECT_APPLIED_MIGRATION_IDS) {
		await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, clock_timestamp())", [migrationId]);
	}
	for (const table of TENANT_TABLES) {
		await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
		await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
	}
}

async function readLegacyContexts(client: PoolClient, entities: LegacyEntity[]): Promise<LegacyContext[]> {
	const contexts = (await client.query<Omit<LegacyContext, "project_id">>("SELECT * FROM contexts ORDER BY tenant_id, key")).rows;
	const entityByKey = new Map(entities.map((entity) => [identityKey(entity.tenant_id, entity.id), entity]));
	const projectsByTenant = Map.groupBy(entities.filter((entity) => entity.kind === "project"), (entity) => entity.tenant_id);
	return contexts.map((context) => {
		const scopedEntity = context.scope_entity_id === null
			? undefined
			: entityByKey.get(identityKey(context.tenant_id, context.scope_entity_id));
		const defaultProjectId = context.key === "default"
			? "PROJ0"
			: context.key.startsWith("default:") ? context.key.slice("default:".length) : undefined;
		const keyedEntity = entityByKey.get(identityKey(context.tenant_id, defaultProjectId ?? context.key));
		const candidates = new Set<string>();
		if (scopedEntity?.project_id) candidates.add(scopedEntity.project_id);
		if (keyedEntity?.project_id) candidates.add(keyedEntity.project_id);
		if (context.scope_entity_id === null && keyedEntity === undefined) {
			for (const project of projectsByTenant.get(context.tenant_id) ?? []) candidates.add(project.id);
		}
		if (candidates.size !== 1) {
			throw new Error(`Legacy v7 context ${context.key} must resolve exactly one project scope; found ${[...candidates].sort().join(", ") || "none"}.`);
		}
		return { ...context, project_id: [...candidates][0]! };
	});
}

async function readLegacyEntities(client: PoolClient, history: LegacyHistory[]): Promise<LegacyEntityGraph> {
	const entities = (await client.query<Omit<LegacyEntity, "parent_id" | "project_id" | "tombstone">>(
		"SELECT * FROM entities ORDER BY tenant_id, id"
	)).rows;
	const relations = (await client.query<LegacyRelation>(`SELECT tenant_id, from_id, to_id, type FROM relations
		WHERE type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
		ORDER BY tenant_id, to_id, from_id, type`)).rows;
	const groupedRelations = Map.groupBy(relations, (relation) => identityKey(relation.tenant_id, relation.to_id));
	const historyByEntity = Map.groupBy(history, (snapshot) => identityKey(snapshot.tenant_id, snapshot.entity_id));
	const parentsByKey = new Map<string, string[]>();
	const liveEntities = entities.map((entity): LegacyEntity => {
		const key = identityKey(entity.tenant_id, entity.id);
		const relationParents = [...new Set((groupedRelations.get(key) ?? []).map((relation) => relation.from_id))];
		const latestHistoricalParent = historyByEntity.get(key)?.at(-1)?.parent_id;
		parentsByKey.set(key, relationParents.length === 0 && latestHistoricalParent != null
			? [latestHistoricalParent]
			: relationParents);
		return {
			...entity,
			parent_id: relationParents.length === 1 ? relationParents[0]! : null,
			project_id: null,
			tombstone: false
		};
	});
	return { entities: liveEntities, parentsByKey };
}

function recoverDeletedEntities(graph: LegacyEntityGraph, history: LegacyHistory[], counters: LegacyCounter[]): LegacyEntityGraph {
	const liveKeys = new Set(graph.entities.map((entity) => identityKey(entity.tenant_id, entity.id)));
	const countersByKind = new Map(counters.map((counter) => [identityKey(counter.tenant_id, counter.kind), counter.next_value]));
	const orphanHistory = Map.groupBy(
		history.filter((snapshot) => !liveKeys.has(identityKey(snapshot.tenant_id, snapshot.entity_id))),
		(snapshot) => identityKey(snapshot.tenant_id, snapshot.entity_id)
	);
	const recovered: LegacyEntity[] = [];
	for (const [key, snapshots] of orphanHistory) {
		const latest = snapshots.at(-1)!;
		let kind: EntityKind;
		try {
			kind = deriveEntityKindFromId(latest.entity_id);
		} catch {
			throw new Error(`Cannot infer legacy v7 history-only entity kind for ${key}.`);
		}
		const sequence = Number.parseInt(/\d+$/.exec(latest.entity_id)?.[0] ?? "", 10);
		const nextValue = countersByKind.get(identityKey(latest.tenant_id, kind));
		if (!Number.isInteger(sequence) || nextValue === undefined || sequence >= nextValue) {
			throw new Error(`Legacy v7 history-only entity ${key} is not backed by its ${kind} counter.`);
		}
		recovered.push({
			body: latest.body,
			body_source: latest.body_source,
			created_at: snapshots[0]!.created_at,
			id: latest.entity_id,
			kind,
			parent_id: latest.parent_id,
			project_id: null,
			status: latest.status,
			tenant_id: latest.tenant_id,
			title: latest.title,
			tombstone: true,
			updated_at: latest.created_at
		});
		graph.parentsByKey.set(key, latest.parent_id === null ? [] : [latest.parent_id]);
	}
	return { entities: [...graph.entities, ...recovered], parentsByKey: graph.parentsByKey };
}

function resolveEntityProjects(graph: LegacyEntityGraph): LegacyEntity[] {
	for (const entity of graph.entities) {
		const parentIds = graph.parentsByKey.get(identityKey(entity.tenant_id, entity.id)) ?? [];
		if (parentIds.length > 1) {
			throw new Error(`Legacy v7 entity ${entity.id} has ambiguous structural parents: ${[...parentIds].sort().join(", ")}.`);
		}
	}
	const entitiesByKey = new Map(graph.entities.map((entity) => [identityKey(entity.tenant_id, entity.id), entity]));
	const projectsByTenant = Map.groupBy(graph.entities.filter((entity) => entity.kind === "project"), (entity) => entity.tenant_id);
	const resolvedProjects = new Map<string, string>();
	const visiting = new Set<string>();
	const resolveProject = (entity: LegacyEntity, path: string[]): string => {
		const key = identityKey(entity.tenant_id, entity.id);
		const cached = resolvedProjects.get(key);
		if (cached !== undefined) return cached;
		if (visiting.has(key)) {
			const cycle = [...path, entity.id];
			const includesRecovered = cycle.some((entityId) => entitiesByKey.get(identityKey(entity.tenant_id, entityId))?.tombstone === true);
			throw new Error(`Legacy v7 ${includesRecovered ? "history-only " : ""}structural ancestry cycle: ${cycle.join(" -> ")}.`);
		}
		if (entity.kind === "project") {
			resolvedProjects.set(key, entity.id);
			return entity.id;
		}
		visiting.add(key);
		const parentIds = graph.parentsByKey.get(key) ?? [];
		const projectIds = parentIds.length === 0
			? (projectsByTenant.get(entity.tenant_id) ?? []).map((project) => project.id)
			: parentIds.map((parentId) => resolveProject(
				entitiesByKey.get(identityKey(entity.tenant_id, parentId))
					?? (() => { throw new Error(`Legacy v7 structural parent ${parentId} is missing for tenant ${entity.tenant_id}.`); })(),
				[...path, entity.id]
			));
		visiting.delete(key);
		const candidates = [...new Set(projectIds)].sort();
		if (candidates.length !== 1) {
			throw new Error(`Legacy v7 entity ${entity.id} has ${candidates.length} project ancestors: ${candidates.join(", ") || "none"}.`);
		}
		resolvedProjects.set(key, candidates[0]!);
		return candidates[0]!;
	};
	for (const entity of graph.entities) entity.project_id = resolveProject(entity, []);
	return graph.entities.sort((left, right) => identityKey(left.tenant_id, left.id).localeCompare(identityKey(right.tenant_id, right.id)));
}

function buildIdentities(entities: LegacyEntity[]): EntityIdentity[] {
	const identities = entities.map((entity): EntityIdentity => {
		if (!isEntityKind(entity.kind)) {
			throw new Error(`Cannot migrate entity ${entity.id} with unknown kind ${entity.kind}.`);
		}
		return {
			kind: entity.kind,
			legacyId: entity.id,
			tenantId: entity.tenant_id,
			...deriveMigratedEntityIdentity(entity.kind, entity.id)
		};
	});
	for (const property of ["legacyId", "stableId", "reference"] as const) {
		const values = new Set<string>();
		for (const identity of identities) {
			const value = identityKey(identity.tenantId, identity[property]);
			if (values.has(value)) {
				throw new Error(`Legacy v7 identity mapping is not unique for ${identity[property]}.`);
			}
			values.add(value);
		}
	}
	return identities;
}

function buildEntityRevisions(
	entities: LegacyEntity[],
	history: LegacyHistory[],
	identityByLegacyKey: ReadonlyMap<string, EntityIdentity>
): RevisionRow[] {
	const historyByEntity = new Map<string, LegacyHistory[]>();
	for (const snapshot of history) {
		const key = identityKey(snapshot.tenant_id, snapshot.entity_id);
		const snapshots = historyByEntity.get(key) ?? [];
		snapshots.push(snapshot);
		historyByEntity.set(key, snapshots);
	}
	for (const [key, snapshots] of historyByEntity) {
		for (let index = 0; index < snapshots.length; index++) {
			if (snapshots[index]?.version !== index + 1) {
				throw new Error(`Legacy v7 history for ${key} must have unique contiguous versions starting at 1.`);
			}
		}
	}
	const revisions: RevisionRow[] = [];
	for (const entity of entities) {
		const identity = requireIdentity(identityByLegacyKey, entity.tenant_id, entity.id);
		const projectId = requireIdentity(identityByLegacyKey, entity.tenant_id, entity.project_id ?? entity.id).stableId;
		const snapshots = historyByEntity.get(identityKey(entity.tenant_id, entity.id)) ?? [];
		const historicalStates = snapshots.map((snapshot) => ({
			author: snapshot.author,
			createdAt: snapshot.created_at,
			id: snapshot.id,
			state: toEntityState(snapshot, identityByLegacyKey)
		}));
		const states = [
			...historicalStates,
			{
				author: entity.tombstone ? historicalStates.at(-1)?.author ?? RESERVED_SYSTEM_AUTHOR : RESERVED_SYSTEM_AUTHOR,
				createdAt: entity.updated_at,
				id: `legacy-head:${identity.stableId}`,
				state: { ...toEntityState(entity, identityByLegacyKey), parentId: entity.tombstone ? null : toEntityState(entity, identityByLegacyKey).parentId, tombstone: entity.tombstone }
			}
		];
		for (let index = 0; index < states.length; index++) {
			const successor = states[index]!;
			const predecessor = states[Math.max(0, index - 1)]!;
			const patch = createReverseFieldPatch(successor.state, predecessor.state, ENTITY_REVERSE_PATCH_REGISTRY);
			revisions.push({
				author: successor.author,
				createdAt: successor.createdAt,
				id: successor.id,
				patchFormat: patch.patchFormat,
				projectId,
				recordKey: encodeEntityRecordKey(identity.stableId),
				recordKind: "entity",
				restoredFromRevision: null,
				reversePatch: Buffer.from(patch.reversePatch).toString("hex"),
				revision: index + 1,
				sourceHash: patch.sourceHash,
				targetHash: patch.targetHash,
				tenantId: entity.tenant_id
			});
		}
	}
	return revisions;
}

function toEntityState(
	row: Pick<LegacyEntity, "tenant_id" | "title" | "body" | "body_source" | "status" | "parent_id">,
	identities: ReadonlyMap<string, EntityIdentity>
): EntityState {
	return {
		body: row.body,
		bodySource: row.body_source,
		parentId: row.parent_id === null ? null : requireIdentity(identities, row.tenant_id, row.parent_id).stableId,
		status: row.status,
		title: row.title,
		tombstone: false
	};
}

async function stageLegacyTables(client: PoolClient): Promise<void> {
	for (const index of [
		"relations_tenant_to_id_idx",
		"contexts_tenant_scope_entity_id_idx",
		"context_terms_tenant_context_key_idx",
		"history_entries_tenant_entity_version_idx"
	]) {
		await client.query(`DROP INDEX ${index}`);
	}
	for (const table of LEGACY_TABLES) {
		await client.query(`ALTER TABLE ${table} RENAME TO legacy_v7_${table}`);
	}
	await client.query(`DO $$
		DECLARE constraint_row RECORD;
		BEGIN
			FOR constraint_row IN
				SELECT relation.relname AS table_name, catalog_constraint.conname
				FROM pg_constraint AS catalog_constraint
				JOIN pg_class AS relation ON relation.oid = catalog_constraint.conrelid
				WHERE relation.relnamespace = current_schema()::regnamespace
					AND relation.relname LIKE 'legacy_v7_%'
			LOOP
				EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I CASCADE', constraint_row.table_name, constraint_row.conname);
			END LOOP;
		END $$`);
}

async function createIdentityMap(client: PoolClient, identities: EntityIdentity[]): Promise<void> {
	await client.query(`CREATE TEMP TABLE legacy_v7_identity_map (
		tenant_id TEXT NOT NULL,
		legacy_id TEXT NOT NULL,
		stable_id UUID NOT NULL,
		reference TEXT NOT NULL,
		kind TEXT NOT NULL,
		PRIMARY KEY (tenant_id, legacy_id),
		UNIQUE (tenant_id, stable_id),
		UNIQUE (tenant_id, reference)
	) ON COMMIT DROP`);
	await client.query(`INSERT INTO legacy_v7_identity_map (tenant_id, legacy_id, stable_id, reference, kind)
		SELECT row.tenant_id, row.legacy_id, row.stable_id::uuid, row.reference, row.kind
		FROM jsonb_to_recordset($1::jsonb) AS row(tenant_id TEXT, legacy_id TEXT, stable_id TEXT, reference TEXT, kind TEXT)`,
		[JSON.stringify(identities.map((identity) => ({
			kind: identity.kind,
			legacy_id: identity.legacyId,
			reference: identity.reference,
			stable_id: identity.stableId,
			tenant_id: identity.tenantId
		})))]);
}

async function copyHeads(
	client: PoolClient,
	entities: LegacyEntity[],
	contexts: LegacyContext[],
	terms: LegacyTerm[],
	revisionRows: RevisionRow[]
): Promise<void> {
	await client.query(`INSERT INTO counters SELECT * FROM legacy_v7_counters`);
	await client.query(`INSERT INTO entities
		(tenant_id, id, reference, kind, title, status, body, body_source, revision, content_hash, tombstone, project_id, created_at, updated_at)
		SELECT source.tenant_id, identity.stable_id, identity.reference, source.kind, source.title, source.status,
			source.body, source.body_source, history.revision, row_hash.content_hash, source.tombstone, project.stable_id,
			source.created_at, source.updated_at
		FROM jsonb_to_recordset($3::jsonb) AS source(
			tenant_id TEXT, id TEXT, kind TEXT, title TEXT, status TEXT, body TEXT, body_source TEXT,
			created_at TEXT, updated_at TEXT, project_id TEXT, parent_id TEXT, tombstone BOOLEAN
		)
		JOIN legacy_v7_identity_map AS identity ON identity.tenant_id = source.tenant_id AND identity.legacy_id = source.id
		JOIN LATERAL (
			SELECT row.content_hash
			FROM jsonb_to_recordset($2::jsonb) AS row(tenant_id TEXT, legacy_id TEXT, content_hash TEXT)
			WHERE row.tenant_id = source.tenant_id AND row.legacy_id = source.id
		) AS row_hash ON TRUE
		JOIN LATERAL (
			SELECT row.revision, row.source_hash
			FROM jsonb_to_recordset($1::jsonb) AS row(tenant_id TEXT, record_key TEXT, revision INTEGER, source_hash TEXT)
			WHERE row.tenant_id = source.tenant_id AND row.record_key = length(identity.stable_id::text)::text || ':' || identity.stable_id::text
			ORDER BY row.revision DESC LIMIT 1
		) AS history ON TRUE
		JOIN legacy_v7_identity_map AS project
			ON project.tenant_id = source.tenant_id AND project.legacy_id = source.project_id AND project.kind = 'project'`, [
			JSON.stringify(revisionRows.map(toSqlRevisionRow)),
			JSON.stringify(entities.map((entity) => ({
				content_hash: computeEntityContentHash(entity.title, entity.body),
				legacy_id: entity.id,
				tenant_id: entity.tenant_id
			}))),
			JSON.stringify(entities)
		]);
	const missingHeads = await client.query<{ legacy_id: string; tenant_id: string }>(`SELECT map.tenant_id, map.legacy_id
		FROM legacy_v7_identity_map AS map
		LEFT JOIN entities AS entity ON entity.tenant_id = map.tenant_id AND entity.id = map.stable_id
		WHERE entity.id IS NULL ORDER BY map.tenant_id, map.legacy_id`);
	if (missingHeads.rowCount !== 0) {
		throw new Error(`Legacy v7 head mapping failed for ${JSON.stringify(missingHeads.rows)}.`);
	}
	await client.query(`INSERT INTO relations
		SELECT relation.tenant_id, source.stable_id, target.stable_id, relation.type, relation.created_at
		FROM legacy_v7_relations AS relation
		JOIN legacy_v7_identity_map AS source ON source.tenant_id = relation.tenant_id AND source.legacy_id = relation.from_id
		JOIN legacy_v7_identity_map AS target ON target.tenant_id = relation.tenant_id AND target.legacy_id = relation.to_id`);
	await copyContexts(client, contexts, terms);
	await client.query(`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch,
		 source_hash, target_hash, restored_from_revision, created_at)
		SELECT row.id, row.tenant_id, row.project_id::uuid, row.record_kind, row.record_key, row.revision, row.author,
			row.patch_format, decode(row.reverse_patch, 'hex'), decode(row.source_hash, 'hex'), decode(row.target_hash, 'hex'),
			row.restored_from_revision, row.created_at
		FROM jsonb_to_recordset($1::jsonb) AS row(
			id TEXT, tenant_id TEXT, project_id TEXT, record_kind TEXT, record_key TEXT, revision INTEGER,
			author TEXT, patch_format INTEGER, reverse_patch TEXT, source_hash TEXT, target_hash TEXT,
			restored_from_revision INTEGER, created_at TEXT
		)`, [JSON.stringify(revisionRows.map(toSqlRevisionRow))]);
}

async function copyContexts(client: PoolClient, contexts: LegacyContext[], terms: LegacyTerm[]): Promise<void> {
	const contextRows = contexts.map((context) => {
		const identity = deriveMigratedContextIdentity(context.key);
		const state = { summary: context.summary, title: context.title };
		const patch = createReverseFieldPatch(state, state, CONTEXT_REVERSE_PATCH_REGISTRY);
		return {
			...context,
			contentHash: computeContextContentHash(context.title, context.summary),
			id: identity.stableId,
			reference: identity.reference,
			...patch
		};
	});
	const termRows = terms.map((term) => {
		const id = deriveMigratedContextTermId(term.context_key, term.term);
		const state = { avoid: parseAvoid(term.avoid_terms), definition: term.definition, term: term.term, tombstone: false };
		const patch = createReverseFieldPatch(state, state, CONTEXT_TERM_REVERSE_PATCH_REGISTRY);
		return {
			...term,
			contentHash: computeContextTermContentHash(term.term, term.definition, state.avoid, false),
			id,
			...patch
		};
	});
	await client.query(`INSERT INTO contexts
		(tenant_id, id, reference, key, scope_entity_id, title, summary, revision, content_hash, created_at, updated_at)
		SELECT row.tenant_id, row.id::uuid, row.reference, row.key, scope.stable_id, row.title, row.summary, 1,
			row.content_hash, row.created_at, row.updated_at
		FROM jsonb_to_recordset($1::jsonb) AS row(tenant_id TEXT, id TEXT, reference TEXT, key TEXT,
			scope_entity_id TEXT, title TEXT, summary TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT)
		LEFT JOIN legacy_v7_identity_map AS scope ON scope.tenant_id = row.tenant_id AND scope.legacy_id = row.scope_entity_id`,
		[JSON.stringify(contextRows.map((context) => ({
			created_at: context.created_at,
			id: context.id,
			key: context.key,
			reference: context.reference,
			scope_entity_id: context.scope_entity_id,
			content_hash: context.contentHash,
			summary: context.summary,
			tenant_id: context.tenant_id,
			title: context.title,
			updated_at: context.updated_at
		})))]);
	await client.query(`INSERT INTO context_terms
		(tenant_id, id, context_key, term, definition, avoid_terms, revision, content_hash, tombstone, created_at, updated_at)
		SELECT row.tenant_id, row.id::uuid, row.context_key, row.term, row.definition, row.avoid_terms, 1,
			row.content_hash, FALSE, row.created_at, row.updated_at
		FROM jsonb_to_recordset($1::jsonb) AS row(tenant_id TEXT, id TEXT, context_key TEXT, term TEXT,
			definition TEXT, avoid_terms TEXT, content_hash TEXT, created_at TEXT, updated_at TEXT)`, [JSON.stringify(termRows.map((term) => ({
			avoid_terms: term.avoid_terms,
			context_key: term.context_key,
			created_at: term.created_at,
			definition: term.definition,
			id: term.id,
			content_hash: term.contentHash,
			tenant_id: term.tenant_id,
			term: term.term,
			updated_at: term.updated_at
		})))]);
	await insertContextRevisionRows(client, contextRows, termRows);
}

async function insertContextRevisionRows(
	client: PoolClient,
	contexts: Array<Record<string, unknown> & { tenant_id: string; key: string; id: string; updated_at: string; patchFormat: number; reversePatch: Uint8Array; sourceHash: string; targetHash: string }>,
	terms: Array<Record<string, unknown> & { tenant_id: string; context_key: string; term: string; id: string; updated_at: string; patchFormat: number; reversePatch: Uint8Array; sourceHash: string; targetHash: string }>
): Promise<void> {
	const projectByContext = new Map(contexts.map((context) => [
		identityKey(context.tenant_id, context.key),
		context.project_id
	]));
	const rows = [
		...contexts.map((context) => ({
			author: RESERVED_SYSTEM_AUTHOR,
			createdAt: context.updated_at,
			id: `legacy-context:${context.id}`,
			patchFormat: context.patchFormat,
			recordKey: encodeContextRecordKey(context.id),
			recordKind: "context",
			reversePatch: Buffer.from(context.reversePatch).toString("hex"),
			sourceHash: context.sourceHash,
			targetHash: context.targetHash,
			tenantId: context.tenant_id,
			contextKey: context.key,
			projectId: context.project_id
		})),
		...terms.map((term) => ({
			author: RESERVED_SYSTEM_AUTHOR,
			createdAt: term.updated_at,
			id: `legacy-term:${term.id}`,
			patchFormat: term.patchFormat,
			recordKey: encodeContextTermRecordKey(term.id),
			recordKind: "context-term",
			reversePatch: Buffer.from(term.reversePatch).toString("hex"),
			sourceHash: term.sourceHash,
			targetHash: term.targetHash,
			tenantId: term.tenant_id,
			contextKey: term.context_key,
			projectId: projectByContext.get(identityKey(term.tenant_id, term.context_key))
		}))
	];
	if (rows.some((row) => row.projectId === undefined)) {
		throw new Error("Legacy v7 context term has no canonical context project mapping.");
	}
	await client.query(`INSERT INTO revision_entries
		(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format, reverse_patch,
		 source_hash, target_hash, restored_from_revision, created_at)
		SELECT row.id, row.tenant_id, project.stable_id, row.record_kind, row.record_key, 1, row.author,
			row.patch_format, decode(row.reverse_patch, 'hex'), decode(row.source_hash, 'hex'), decode(row.target_hash, 'hex'), NULL, row.created_at
		FROM jsonb_to_recordset($1::jsonb) AS row(id TEXT, tenant_id TEXT, record_kind TEXT, record_key TEXT,
			author TEXT, patch_format INTEGER, reverse_patch TEXT, source_hash TEXT, target_hash TEXT, created_at TEXT, project_id TEXT)
		JOIN legacy_v7_identity_map AS project
			ON project.tenant_id = row.tenant_id AND project.legacy_id = row.project_id AND project.kind = 'project'`, [JSON.stringify(rows.map((row) => ({
			author: row.author,
			created_at: row.createdAt,
			id: row.id,
			patch_format: row.patchFormat,
			project_id: row.projectId,
			record_key: row.recordKey,
			record_kind: row.recordKind,
			reverse_patch: row.reversePatch,
			source_hash: row.sourceHash,
			target_hash: row.targetHash,
			tenant_id: row.tenantId
		})))]);
}

async function validateTransformation(
	client: PoolClient,
	entities: LegacyEntity[],
	history: LegacyHistory[],
	contexts: LegacyContext[],
	terms: LegacyTerm[]
): Promise<void> {
	const counts = (await client.query<{ contexts: number; context_revisions: number; entities: number; historical: number; source_terms: number; terms: number; term_revisions: number }>(`
		SELECT
			(SELECT count(*)::integer FROM entities) AS entities,
			(SELECT count(*)::integer FROM revision_entries WHERE record_kind = 'entity' AND revision > 1) AS historical,
			(SELECT count(*)::integer FROM contexts) AS contexts,
			(SELECT count(*)::integer FROM revision_entries WHERE record_kind = 'context') AS context_revisions,
			(SELECT count(*)::integer FROM context_terms) AS terms,
			(SELECT count(*)::integer FROM legacy_v7_context_terms) AS source_terms,
			(SELECT count(*)::integer FROM revision_entries WHERE record_kind = 'context-term') AS term_revisions
	`)).rows[0];
	if (counts?.entities !== entities.length || counts.historical !== history.length) {
		throw new Error(`Legacy v7 validation failed: expected ${entities.length} entities and ${history.length} historical revisions, found ${counts?.entities ?? 0} and ${counts?.historical ?? 0}.`);
	}
	if (counts.contexts !== contexts.length || counts.context_revisions !== contexts.length
		|| counts.terms !== terms.length || counts.term_revisions !== terms.length) {
		throw new Error(`Legacy v7 validation failed: context or term heads/revisions do not match source counts: ${JSON.stringify(counts)}.`);
	}
	const heads = (await client.query<FinalEntityRow>(`SELECT tenant_id, id::text, project_id::text, title, body, body_source,
		status, revision, tombstone, created_at FROM entities ORDER BY tenant_id, id`)).rows;
	const parents = (await client.query<{ tenant_id: string; entity_id: string; parent_id: string }>(`SELECT tenant_id, to_id::text AS entity_id, from_id::text AS parent_id
		FROM relations WHERE type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
		ORDER BY tenant_id, entity_id, parent_id`)).rows;
	const revisions = (await client.query<FinalRevisionRow>(`SELECT id, tenant_id, project_id::text, record_kind, record_key, revision, author,
		patch_format, reverse_patch, source_hash, target_hash, restored_from_revision, created_at
		FROM revision_entries ORDER BY tenant_id, record_kind, record_key, revision DESC`)).rows;
	const finalContexts = (await client.query<{ tenant_id: string; id: string; key: string; title: string; summary: string; revision: number; created_at: string }>(
		"SELECT tenant_id, id::text, key, title, summary, revision, created_at FROM contexts ORDER BY tenant_id, key"
	)).rows;
	const finalTerms = (await client.query<{ tenant_id: string; id: string; context_key: string; term: string; definition: string; avoid_terms: string; revision: number; tombstone: boolean; created_at: string }>(
		"SELECT tenant_id, id::text, context_key, term, definition, avoid_terms, revision, tombstone, created_at FROM context_terms ORDER BY tenant_id, context_key, term"
	)).rows;
	const headByKey = new Map(heads.map((head) => [identityKey(head.tenant_id, head.id), head]));
	const parentByKey = new Map(parents.map((parent) => [identityKey(parent.tenant_id, parent.entity_id), parent.parent_id]));
	const revisionsByRecord = Map.groupBy(revisions, (revision) => `${revision.tenant_id}\0${revision.record_kind}\0${revision.record_key}`);
	const historyByEntity = Map.groupBy(history, (snapshot) => identityKey(snapshot.tenant_id, snapshot.entity_id));
	for (const entity of entities) {
		const identity = deriveMigratedEntityIdentity(entity.kind as EntityKind, entity.id);
		const head = headByKey.get(identityKey(entity.tenant_id, identity.stableId));
		if (!head) throw new Error(`Legacy v7 validation failed: missing entity head ${entity.id}.`);
		const recordKey = encodeEntityRecordKey(identity.stableId);
		const rows = revisionsByRecord.get(`${entity.tenant_id}\0entity\0${recordKey}`) ?? [];
		if (rows.length !== head.revision || rows.some((row, index) => row.revision !== head.revision - index)) {
			throw new Error(`Legacy v7 validation failed: reconstructed entity history is not contiguous for ${entity.id}.`);
		}
		const patches: EntityRevisionPatch[] = rows.map((row) => ({
			author: row.author,
			createdAt: row.created_at,
			patchFormat: row.patch_format,
			restoredFromRevision: row.restored_from_revision ?? undefined,
			reversePatch: row.reverse_patch,
			revision: row.revision,
			sourceHash: row.source_hash.toString("hex"),
			targetHash: row.target_hash.toString("hex")
		}));
		const snapshots = historyByEntity.get(identityKey(entity.tenant_id, entity.id)) ?? [];
		for (const snapshot of snapshots) {
			const materialized = materializeFromPatches(identity.stableId, {
				body: head.body,
				bodySource: head.body_source,
				category: null,
				createdAt: head.created_at,
				id: identity.stableId,
				parentId: parentByKey.get(identityKey(entity.tenant_id, identity.stableId)) ?? null,
				priority: null,
				type: null,
				revision: head.revision,
				status: head.status,
				title: head.title,
				tombstone: head.tombstone
			}, patches, snapshot.version);
			const expectedParentId = snapshot.parent_id === null
				? null
				: requireIdentity(new Map(entities.map((candidate) => {
					const candidateIdentity = deriveMigratedEntityIdentity(candidate.kind as EntityKind, candidate.id);
					return [identityKey(candidate.tenant_id, candidate.id), { ...candidateIdentity, kind: candidate.kind as EntityKind, legacyId: candidate.id, tenantId: candidate.tenant_id }];
				})), snapshot.tenant_id, snapshot.parent_id).stableId;
			const patch = rows.find((row) => row.revision === snapshot.version);
			if (materialized.title !== snapshot.title || materialized.body !== snapshot.body
				|| materialized.bodySource !== snapshot.body_source || materialized.status !== snapshot.status
				|| materialized.parentId !== expectedParentId || materialized.tombstone !== false
				|| patch?.id !== snapshot.id || patch.author !== snapshot.author || patch.created_at !== snapshot.created_at
				|| patch.project_id !== head.project_id || patch.record_key !== recordKey || patch.restored_from_revision !== null) {
				throw new Error(`Legacy v7 validation failed: divergent reconstructed entity ${entity.id} revision ${snapshot.version}.`);
			}
		}
		const materializedHead = materializeFromPatches(identity.stableId, {
			body: head.body,
			bodySource: head.body_source,
			category: null,
			createdAt: head.created_at,
			id: identity.stableId,
			parentId: parentByKey.get(identityKey(entity.tenant_id, identity.stableId)) ?? null,
			priority: null,
			type: null,
			revision: head.revision,
			status: head.status,
			title: head.title,
			tombstone: head.tombstone
		}, patches, head.revision);
		const headPatch = rows.find((row) => row.revision === head.revision);
		const expectedHeadParentId = entity.tombstone || entity.parent_id === null
			? null
			: deriveMigratedEntityIdentity(
				entities.find((candidate) => candidate.tenant_id === entity.tenant_id && candidate.id === entity.parent_id)!.kind as EntityKind,
				entity.parent_id
			).stableId;
		const expectedHeadAuthor = entity.tombstone
			? snapshots.at(-1)?.author ?? RESERVED_SYSTEM_AUTHOR
			: RESERVED_SYSTEM_AUTHOR;
		if (materializedHead.title !== entity.title || materializedHead.body !== entity.body
			|| materializedHead.bodySource !== entity.body_source || materializedHead.status !== entity.status
			|| materializedHead.parentId !== expectedHeadParentId || materializedHead.tombstone !== entity.tombstone
			|| headPatch?.id !== `legacy-head:${identity.stableId}` || headPatch.author !== expectedHeadAuthor
			|| headPatch.created_at !== entity.updated_at || headPatch.project_id !== head.project_id
			|| headPatch.record_key !== recordKey || headPatch.restored_from_revision !== null) {
			throw new Error(`Legacy v7 validation failed: divergent reconstructed entity ${entity.id} revision ${head.revision}.`);
		}
	}
	for (const context of contexts) {
		const identity = deriveMigratedContextIdentity(context.key);
		const head = finalContexts.find((candidate) => candidate.tenant_id === context.tenant_id && candidate.key === context.key);
		const recordKey = encodeContextRecordKey(identity.stableId);
		const rows = revisionsByRecord.get(`${context.tenant_id}\0context\0${recordKey}`) ?? [];
		if (!head || rows.length !== 1) throw new Error(`Legacy v7 validation failed: missing context baseline ${context.key}.`);
		const patches: ContextRevisionPatch[] = rows.map((row) => ({
			author: row.author,
			createdAt: row.created_at,
			patchFormat: row.patch_format,
			reversePatch: row.reverse_patch,
			revision: row.revision,
			sourceHash: row.source_hash.toString("hex"),
			targetHash: row.target_hash.toString("hex")
		}));
		const materialized = materializeContextFromPatches({
			createdAt: head.created_at,
			key: head.key,
			revision: head.revision,
			summary: head.summary,
			title: head.title
		}, patches, 1);
		const row = rows[0]!;
		const projectId = deriveMigratedEntityIdentity("project", context.project_id).stableId;
		if (head.id !== identity.stableId || materialized.title !== context.title || materialized.summary !== context.summary
			|| row.id !== `legacy-context:${identity.stableId}` || row.project_id !== projectId || row.record_key !== recordKey
			|| row.author !== RESERVED_SYSTEM_AUTHOR || row.created_at !== context.updated_at || row.restored_from_revision !== null) {
			throw new Error(`Legacy v7 validation failed: divergent context baseline ${context.key}.`);
		}
	}
	for (const term of terms) {
		const id = deriveMigratedContextTermId(term.context_key, term.term);
		const head = finalTerms.find((candidate) => candidate.tenant_id === term.tenant_id
			&& candidate.context_key === term.context_key && candidate.term === term.term);
		const recordKey = encodeContextTermRecordKey(id);
		const rows = revisionsByRecord.get(`${term.tenant_id}\0context-term\0${recordKey}`) ?? [];
		if (!head || rows.length !== 1) throw new Error(`Legacy v7 validation failed: missing context term baseline ${term.context_key}:${term.term}.`);
		const avoid = parseAvoid(term.avoid_terms);
		const patches: ContextTermRevisionPatch[] = rows.map((row) => ({
			author: row.author,
			createdAt: row.created_at,
			patchFormat: row.patch_format,
			reversePatch: row.reverse_patch,
			revision: row.revision,
			sourceHash: row.source_hash.toString("hex"),
			targetHash: row.target_hash.toString("hex")
		}));
		const materialized = materializeContextTermFromPatches({
			avoid: parseAvoid(head.avoid_terms),
			contextKey: head.context_key,
			createdAt: head.created_at,
			definition: head.definition,
			id: head.id,
			revision: head.revision,
			term: head.term,
			tombstone: head.tombstone
		}, patches, 1);
		const context = contexts.find((candidate) => candidate.tenant_id === term.tenant_id && candidate.key === term.context_key)!;
		const row = rows[0]!;
		const projectId = deriveMigratedEntityIdentity("project", context.project_id).stableId;
		if (head.id !== id || materialized.term !== term.term || materialized.definition !== term.definition
			|| JSON.stringify(materialized.avoid) !== JSON.stringify(avoid) || materialized.tombstone !== false
			|| row.id !== `legacy-term:${id}` || row.project_id !== projectId || row.record_key !== recordKey
			|| row.author !== RESERVED_SYSTEM_AUTHOR || row.created_at !== term.updated_at || row.restored_from_revision !== null) {
			throw new Error(`Legacy v7 validation failed: divergent context term baseline ${term.context_key}:${term.term}.`);
		}
	}
}

async function dropLegacyTables(client: PoolClient): Promise<void> {
	for (const table of [...LEGACY_TABLES].reverse()) {
		await client.query(`DROP TABLE legacy_v7_${table} CASCADE`);
	}
}

function requireIdentity(identities: ReadonlyMap<string, EntityIdentity>, tenantId: string, legacyId: string): EntityIdentity {
	const identity = identities.get(identityKey(tenantId, legacyId));
	if (!identity) {
		throw new Error(`Cannot map legacy v7 entity reference ${legacyId} for tenant ${tenantId}.`);
	}
	return identity;
}

function identityKey(tenantId: string, legacyId: string): string {
	return `${tenantId}\0${legacyId}`;
}

function parseAvoid(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function toSqlRevisionRow(row: RevisionRow): Record<string, unknown> {
	return {
		author: row.author,
		created_at: row.createdAt,
		id: row.id,
		patch_format: row.patchFormat,
		project_id: row.projectId,
		record_key: row.recordKey,
		record_kind: row.recordKind,
		restored_from_revision: row.restoredFromRevision,
		reverse_patch: row.reversePatch,
		revision: row.revision,
		source_hash: row.sourceHash,
		target_hash: row.targetHash,
		tenant_id: row.tenantId
	};
}