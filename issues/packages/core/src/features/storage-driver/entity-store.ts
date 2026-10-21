import type { BodySource, EntityRecord, EntitySummary, HistoryEntryRecord, RelationRecord, MaterializedEntityRevision } from "../entity-store/domain.js";
import type {
	DatabaseSnapshot,
	DeleteResult,
	EntityDetails,
	EntityRelations,
	InitiativeBundle,
	InitiativeDetail,
	InitiativeTab,
	InitiativeTabData,
	LinkResult,
	MoveResult,
	ProjectDiscovery,
	ProjectSummary,
	ProjectSnapshot,
	QueryEntitiesInput,
	QueryEntitiesResult,
	QueryEntityRelationsInput,
	StatusUpdateResult,
	UnlinkResult
} from "../entity-store/store-types.js";
import type { WorkspaceObservation } from "../workspace-observation/workspace-observation.js";

/**
 * The entity/relation half of the storage-driver seam (ADR "Backends mirror
 * one another per feature, behind all-async feature interfaces"), split out
 * of `StorageDriver` so a reader who knows one backend's `LocalEntityStore`/
 * `PgEntityStore` can read the other. All methods return promises; local's
 * synchronous free functions still do the actual work beneath the class that
 * implements this interface.
 */
export interface EntityStore {
	createEntity(input: {
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
	}): Promise<EntitySummary>;
	getEntityDetails(entityId: string): Promise<EntityDetails>;
	queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityRelations>;
	listEntities(kind: string): Promise<EntitySummary[]>;
	queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult>;
	listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]>;
	/** Non-structural relations transferred after canonical entity import. */
	listAllRelations(): Promise<RelationRecord[]>;
	applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }>;
	listOrphans(kind?: string): Promise<EntityRecord[]>;
	listProjectAdrs(): Promise<EntityRecord[]>;
	updateEntityStatus(input: { entityId: string; status: string; author?: string; workspaceObservation?: WorkspaceObservation }): Promise<StatusUpdateResult>;
	updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; category?: string; priority?: string; type?: string | null; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord>;
	setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord>;
	/** Materializes entity facts at a specific historical revision by walking the reverse-delta chain (ADR55/ISS261). */
	materializeEntityRevision(input: { entityId: string; revision: number }): Promise<MaterializedEntityRevision>;
	restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedEntityRevision>;
	archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult>;
	deleteEntity(input: { entityId: string }): Promise<DeleteResult>;
	moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult>;
	linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult>;
	unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult>;
	getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	getProjectSummary(input: { projectId: string }): Promise<ProjectSummary>;
	getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery>;
	getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle>;
	getInitiativeDetail(input: { initiativeId: string }): Promise<InitiativeDetail>;
	getInitiativeTab(input: { initiativeId: string; tab: InitiativeTab }): Promise<InitiativeTabData>;
	/**
	 * A cheap, opaque string that changes whenever this tenant's own data
	 * changes and stays stable otherwise (ISS191) - the site server's
	 * local-mode live-refresh polls this instead of directly `stat()`-ing
	 * the sqlite file, so local mode never bypasses this seam the way cloud
	 * mode (which already only ever talks through `StorageDriver`) doesn't.
	 * Callers must never parse or compare its internal shape - only
	 * equality across two calls is meaningful.
	 */
	getSnapshotSignature(): Promise<string>;
}
