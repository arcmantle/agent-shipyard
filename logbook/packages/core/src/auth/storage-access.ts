import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { LOGBOOK_ADMIN_ROLE, LOGBOOK_WRITER_ROLE } from "./auth-provider.js";

export type StorageAccess = "read" | "write" | "admin";

type StorageMethod = {
	[K in keyof StorageDriver]-?: StorageDriver[K] extends (...args: never[]) => unknown ? K : never;
}[keyof StorageDriver];

/** Every StorageDriver method must be classified, so a new method fails type-check until it is. */
export const storageMethodAccess = {
	// Entities and relations
	createEntity: "write",
	applyRelations: "write",
	updateEntityStatus: "write",
	updateEntity: "write",
	setEntityBody: "write",
	restoreEntityRevision: "write",
	archiveEntity: "write",
	deleteEntity: "write",
	moveEntity: "write",
	linkEntities: "write",
	unlinkEntities: "write",
	getEntityDetails: "read",
	getInitiativeBundle: "read",
	getInitiativeDetail: "read",
	getInitiativeTab: "read",
	getDatabaseSnapshot: "read",
	getProjectDiscovery: "read",
	getProjectSummary: "read",
	getSnapshotSignature: "read",
	listAllRelations: "read",
	listEntities: "read",
	listEntityHistory: "read",
	listOrphans: "read",
	listProjectAdrs: "read",
	materializeEntityRevision: "read",
	queryEntities: "read",
	queryEntityRelations: "read",
	// Comments, plans, and breakdowns
	createIssueComment: "write",
	updateIssueComment: "write",
	deleteIssueComment: "write",
	listIssueComments: "read",
	listIssueCommentHistory: "read",
	confirmPlan: "write",
	createPlanEntry: "write",
	updatePlanEntry: "write",
	deletePlanEntry: "write",
	linkPlanEntryEntity: "write",
	unlinkPlanEntryEntity: "write",
	getPlanEntry: "read",
	listPlanEntries: "read",
	listPlanEntryHistory: "read",
	listPlanEntryPage: "read",
	createIssueBreakdownDraft: "write",
	approveIssueBreakdownDraft: "write",
	getIssueBreakdownDraft: "read",
	getLatestIssueBreakdownDraft: "read",
	// Contexts
	upsertContext: "write",
	defineContextTerm: "write",
	forgetContextTerm: "write",
	restoreContextRevision: "write",
	restoreContextTermRevision: "write",
	getContextDetails: "read",
	getContextDirectory: "read",
	listContexts: "read",
	materializeContextRevision: "read",
	materializeContextTermRevision: "read",
	queryContextDirectory: "read",
	// Settings, search, synchronization, and history
	setProspectorSettings: "write",
	getProspectorSettings: "read",
	search: "read",
	getSearchCapability: "read",
	getSearchDiagnostics: "read",
	importCanonicalChains: "write",
	exportCanonicalChains: "read",
	getHistoryDiagnostics: "read",
	// Instructions
	saveInstructionSource: "admin",
	restoreInstructionRevision: "admin",
	resetInstructionSource: "admin",
	resetInstructionAll: "admin",
	commitInstructionChanges: "admin",
	createInstructionFragment: "admin",
	removeInstructionFragment: "admin",
	retrieveInstruction: "read",
	previewInstruction: "read",
	listInstructionSources: "read",
	readInstructionSource: "read",
	compareInstructionSource: "read",
	inspectInstructionDependencies: "read",
	listInstructionHistory: "read",
	readInstructionRevision: "read",
	inspectInstructionReset: "read",
	inspectInstructionResetAll: "read",
	// Users and tenants
	upsertUser: "admin",
	listUsers: "read",
	listTenants: "read",
	deleteTenant: "admin",
	renameTenant: "admin",
	withAuthenticatedIdentity: "read",
	close: "read"
} as const satisfies Record<StorageMethod, StorageAccess>;

const accessLevel: Record<StorageAccess, number> = { read: 0, write: 1, admin: 2 };

/** Returns the store unchanged for identities without roles; otherwise rejects calls above the granted access. */
export function guardStorageAccess(store: StorageDriver, roles: readonly string[] | undefined): StorageDriver {
	if (!roles) return store;
	const granted = roles.includes(LOGBOOK_ADMIN_ROLE) ? accessLevel.admin : roles.includes(LOGBOOK_WRITER_ROLE) ? accessLevel.write : accessLevel.read;
	return new Proxy(store, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			const access = (storageMethodAccess as Record<PropertyKey, StorageAccess | undefined>)[property];
			if (access && accessLevel[access] > granted) {
				const role = access === "admin" ? LOGBOOK_ADMIN_ROLE : LOGBOOK_WRITER_ROLE;
				return async () => { throw new Error(`This change requires the ${role} role.`); };
			}
			return value.bind(target);
		}
	});
}
