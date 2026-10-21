import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { decodeCanonicalChainBundle, encodeCanonicalChainBundle, type CanonicalChainWireBundle } from "../features/synchronize/canonical-chain.js";

/**
 * One entry per `StorageDriver` method exposed over JSON-RPC (ADR13, ADR14).
 * Generic over `StorageDriver` rather than hardcoded to `PgStore` (ADR44):
 * the local daemon fronts a `SqliteStore` through this exact same dispatch
 * table. The tracer bullet (ISS49) wired only `createEntity`; the remaining
 * entity, handoff, context/glossary, and tenant-administration methods were
 * added mechanically by ISS50-ISS52 following this exact shape - every
 * handler only ever calls `StorageDriver` interface methods, so widening
 * the type is a pure type-level change.
 */
export type RpcMethodHandler = (store: StorageDriver, params: unknown) => Promise<unknown>;

export const rpcMethods: Record<string, RpcMethodHandler> = {
	exportCanonicalChains: async (store) => encodeCanonicalChainBundle(await store.exportCanonicalChains()),
	importCanonicalChains: async (store, params) => store.importCanonicalChains(decodeCanonicalChainBundle((params as { bundle: CanonicalChainWireBundle }).bundle)),
	upsertUser: async (store, params) => store.upsertUser(params as Parameters<StorageDriver["upsertUser"]>[0]),
	listUsers: async (store) => store.listUsers(),
	getHistoryDiagnostics: async (store) => store.getHistoryDiagnostics(),
	getProspectorSettings: async (store) => store.getProspectorSettings(),
	retrieveInstruction: async (store, params) => store.retrieveInstruction(params as Parameters<StorageDriver["retrieveInstruction"]>[0]),
	previewInstruction: async (store, params) => store.previewInstruction(params as Parameters<StorageDriver["previewInstruction"]>[0]),
	listInstructionSources: async (store, params) => store.listInstructionSources(params as Parameters<StorageDriver["listInstructionSources"]>[0]),
	readInstructionSource: async (store, params) => store.readInstructionSource(params as Parameters<StorageDriver["readInstructionSource"]>[0]),
	compareInstructionSource: async (store, params) => store.compareInstructionSource(params as Parameters<StorageDriver["compareInstructionSource"]>[0]),
	inspectInstructionDependencies: async (store, params) => store.inspectInstructionDependencies(params as Parameters<StorageDriver["inspectInstructionDependencies"]>[0]),
	saveInstructionSource: async (store, params) => store.saveInstructionSource(params as Parameters<StorageDriver["saveInstructionSource"]>[0]),
	listInstructionHistory: async (store, params) => store.listInstructionHistory(params as Parameters<StorageDriver["listInstructionHistory"]>[0]),
	readInstructionRevision: async (store, params) => store.readInstructionRevision(params as Parameters<StorageDriver["readInstructionRevision"]>[0]),
	restoreInstructionRevision: async (store, params) => store.restoreInstructionRevision(params as Parameters<StorageDriver["restoreInstructionRevision"]>[0]),
	resetInstructionSource: async (store, params) => store.resetInstructionSource(params as Parameters<StorageDriver["resetInstructionSource"]>[0]),
	inspectInstructionReset: async (store, params) => store.inspectInstructionReset(params as Parameters<StorageDriver["inspectInstructionReset"]>[0]),
	inspectInstructionResetAll: async (store, params) => store.inspectInstructionResetAll(params as Parameters<StorageDriver["inspectInstructionResetAll"]>[0]),
	resetInstructionAll: async (store, params) => store.resetInstructionAll(params as Parameters<StorageDriver["resetInstructionAll"]>[0]),
	commitInstructionChanges: async (store, params) => store.commitInstructionChanges(params as Parameters<StorageDriver["commitInstructionChanges"]>[0]),
	createInstructionFragment: async (store, params) => store.createInstructionFragment(params as Parameters<StorageDriver["createInstructionFragment"]>[0]),
	removeInstructionFragment: async (store, params) => store.removeInstructionFragment(params as Parameters<StorageDriver["removeInstructionFragment"]>[0]),
	setProspectorSettings: async (store, params) => store.setProspectorSettings(params as Parameters<StorageDriver["setProspectorSettings"]>[0]),
	getSearchCapability: async (store) => store.getSearchCapability(),
	getSearchDiagnostics: async (store) => store.getSearchDiagnostics(),
	search: async (store, params) => store.search(params as Parameters<StorageDriver["search"]>[0]),
	createEntity: async (store, params) => store.createEntity(params as Parameters<StorageDriver["createEntity"]>[0]),
	createIssueComment: async (store, params) => store.createIssueComment(params as Parameters<StorageDriver["createIssueComment"]>[0]),
	updateIssueComment: async (store, params) => store.updateIssueComment(params as Parameters<StorageDriver["updateIssueComment"]>[0]),
	deleteIssueComment: async (store, params) => store.deleteIssueComment(params as Parameters<StorageDriver["deleteIssueComment"]>[0]),
	listIssueComments: async (store, params) => store.listIssueComments(params as Parameters<StorageDriver["listIssueComments"]>[0]),
	listIssueCommentHistory: async (store, params) => store.listIssueCommentHistory(params as Parameters<StorageDriver["listIssueCommentHistory"]>[0]),
	createPlanEntry: async (store, params) => store.createPlanEntry(params as Parameters<StorageDriver["createPlanEntry"]>[0]),
	confirmPlan: async (store, params) => store.confirmPlan(params as Parameters<StorageDriver["confirmPlan"]>[0]),
	createIssueBreakdownDraft: async (store, params) => store.createIssueBreakdownDraft(params as Parameters<StorageDriver["createIssueBreakdownDraft"]>[0]),
	getIssueBreakdownDraft: async (store, params) => store.getIssueBreakdownDraft(params as Parameters<StorageDriver["getIssueBreakdownDraft"]>[0]),
	getLatestIssueBreakdownDraft: async (store, params) => store.getLatestIssueBreakdownDraft(params as Parameters<StorageDriver["getLatestIssueBreakdownDraft"]>[0]),
	approveIssueBreakdownDraft: async (store, params) => store.approveIssueBreakdownDraft(params as Parameters<StorageDriver["approveIssueBreakdownDraft"]>[0]),
	getPlanEntry: async (store, params) => store.getPlanEntry(params as Parameters<StorageDriver["getPlanEntry"]>[0]),
	updatePlanEntry: async (store, params) => store.updatePlanEntry(params as Parameters<StorageDriver["updatePlanEntry"]>[0]),
	deletePlanEntry: async (store, params) => store.deletePlanEntry(params as Parameters<StorageDriver["deletePlanEntry"]>[0]),
	linkPlanEntryEntity: async (store, params) => store.linkPlanEntryEntity(params as Parameters<StorageDriver["linkPlanEntryEntity"]>[0]),
	unlinkPlanEntryEntity: async (store, params) => store.unlinkPlanEntryEntity(params as Parameters<StorageDriver["unlinkPlanEntryEntity"]>[0]),
	listPlanEntries: async (store, params) => store.listPlanEntries(params as Parameters<StorageDriver["listPlanEntries"]>[0]),
	listPlanEntryPage: async (store, params) => store.listPlanEntryPage(params as Parameters<StorageDriver["listPlanEntryPage"]>[0]),
	listPlanEntryHistory: async (store, params) => store.listPlanEntryHistory(params as Parameters<StorageDriver["listPlanEntryHistory"]>[0]),

	// Entity lifecycle (ISS50). Methods whose `StorageDriver` signature takes
	// a bare string/no argument are wrapped in a named-field params object for
	// a consistent JSON-RPC surface; methods that already take a single input
	// object are forwarded to `store` unchanged.
	getEntityDetails: async (store, params) => store.getEntityDetails((params as { entityId: string }).entityId),
	queryEntityRelations: async (store, params) => store.queryEntityRelations(params as Parameters<StorageDriver["queryEntityRelations"]>[0]),
	listEntities: async (store, params) => store.listEntities((params as { kind: string }).kind),
	queryEntities: async (store, params) => store.queryEntities(params as Parameters<StorageDriver["queryEntities"]>[0]),
	listEntityHistory: async (store, params) => store.listEntityHistory((params as { entityId: string }).entityId),
	listAllRelations: async (store) => store.listAllRelations(),
	applyRelations: async (store, params) => store.applyRelations((params as { relations: Parameters<StorageDriver["applyRelations"]>[0] }).relations),
	listOrphans: async (store, params) => store.listOrphans((params as { kind?: string } | undefined)?.kind),
	listProjectAdrs: async (store) => store.listProjectAdrs(),
	updateEntityStatus: async (store, params) => store.updateEntityStatus(params as Parameters<StorageDriver["updateEntityStatus"]>[0]),
	updateEntity: async (store, params) => store.updateEntity(params as Parameters<StorageDriver["updateEntity"]>[0]),
	setEntityBody: async (store, params) => store.setEntityBody(params as Parameters<StorageDriver["setEntityBody"]>[0]),
	materializeEntityRevision: async (store, params) => store.materializeEntityRevision(params as Parameters<StorageDriver["materializeEntityRevision"]>[0]),
	restoreEntityRevision: async (store, params) => store.restoreEntityRevision(params as Parameters<StorageDriver["restoreEntityRevision"]>[0]),
	archiveEntity: async (store, params) => store.archiveEntity(params as Parameters<StorageDriver["archiveEntity"]>[0]),
	deleteEntity: async (store, params) => store.deleteEntity(params as Parameters<StorageDriver["deleteEntity"]>[0]),
	moveEntity: async (store, params) => store.moveEntity(params as Parameters<StorageDriver["moveEntity"]>[0]),
	linkEntities: async (store, params) => store.linkEntities(params as Parameters<StorageDriver["linkEntities"]>[0]),
	unlinkEntities: async (store, params) => store.unlinkEntities(params as Parameters<StorageDriver["unlinkEntities"]>[0]),
	getDatabaseSnapshot: async (store, params) => store.getDatabaseSnapshot(params as Parameters<StorageDriver["getDatabaseSnapshot"]>[0]),
	getProjectSummary: async (store, params) => store.getProjectSummary(params as Parameters<StorageDriver["getProjectSummary"]>[0]),
	getProjectDiscovery: async (store, params) => store.getProjectDiscovery(params as Parameters<StorageDriver["getProjectDiscovery"]>[0]),
	getInitiativeBundle: async (store, params) => store.getInitiativeBundle((params as { initiativeId: string }).initiativeId),
	getInitiativeDetail: async (store, params) => store.getInitiativeDetail(params as Parameters<StorageDriver["getInitiativeDetail"]>[0]),
	getInitiativeTab: async (store, params) => store.getInitiativeTab(params as Parameters<StorageDriver["getInitiativeTab"]>[0]),
	getSnapshotSignature: async (store) => store.getSnapshotSignature(),

	listContexts: async (store) => store.listContexts(),
	getContextDetails: async (store, params) => store.getContextDetails(params as Parameters<StorageDriver["getContextDetails"]>[0]),
	getContextDirectory: async (store) => store.getContextDirectory(),
	queryContextDirectory: async (store, params) => store.queryContextDirectory(params as Parameters<StorageDriver["queryContextDirectory"]>[0]),
	upsertContext: async (store, params) => store.upsertContext(params as Parameters<StorageDriver["upsertContext"]>[0]),
	defineContextTerm: async (store, params) => store.defineContextTerm(params as Parameters<StorageDriver["defineContextTerm"]>[0]),
	forgetContextTerm: async (store, params) => store.forgetContextTerm(params as Parameters<StorageDriver["forgetContextTerm"]>[0]),
	materializeContextRevision: async (store, params) => store.materializeContextRevision(params as Parameters<StorageDriver["materializeContextRevision"]>[0]),
	materializeContextTermRevision: async (store, params) => store.materializeContextTermRevision(params as Parameters<StorageDriver["materializeContextTermRevision"]>[0]),
	restoreContextRevision: async (store, params) => store.restoreContextRevision(params as Parameters<StorageDriver["restoreContextRevision"]>[0]),
	restoreContextTermRevision: async (store, params) => store.restoreContextTermRevision(params as Parameters<StorageDriver["restoreContextTermRevision"]>[0]),

	// Tenant administration (ISS52). `PgStore`'s guard against acting on any
	// tenant other than the auth-seam-resolved one (ISS46's requireOwnTenant)
	// is enforced inside these methods themselves; the gate adds no
	// additional authorization surface.
	listTenants: async (store) => store.listTenants(),
	deleteTenant: async (store, params) => store.deleteTenant((params as { tenantId: string }).tenantId),
	renameTenant: async (store, params) => {
		const { previousTenantId, newTenantId } = params as { previousTenantId: string; newTenantId: string };
		return store.renameTenant(previousTenantId, newTenantId);
	}
};

/**
 * JSON-RPC methods that mutate `PgStore` data (ISS48, ADR13). Only a
 * successful call to one of these triggers a `snapshot-changed` broadcast on
 * the gate's SSE change-event channel; read-only methods never do.
 */
export const writeMethods = new Set<string>([
	"importCanonicalChains",
	"upsertUser",
	"setProspectorSettings",
	"createEntity",
	"createIssueComment",
	"updateIssueComment",
	"deleteIssueComment",
	"createPlanEntry",
	"confirmPlan",
	"createIssueBreakdownDraft",
	"approveIssueBreakdownDraft",
	"linkPlanEntryEntity",
	"unlinkPlanEntryEntity",
	"updatePlanEntry",
	"deletePlanEntry",
	"updateEntityStatus",
	"updateEntity",
	"setEntityBody",
	"restoreEntityRevision",
	"archiveEntity",
	"deleteEntity",
	"moveEntity",
	"linkEntities",
	"unlinkEntities",
	"upsertContext",
	"defineContextTerm",
	"forgetContextTerm",
	"restoreContextRevision",
	"restoreContextTermRevision",
	"deleteTenant",
	"renameTenant",
	"applyRelations"
]);
