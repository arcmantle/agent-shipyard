import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { isDirectEntitySelector, isStructuralRelationType, measureHistory, projectProposedIssueBreakdown, projectProposedPlan, resolveLocalUsername, toContextWriteResult, toDefineContextTermAcknowledgement, toEntitySummary, type AuthIdentity, type BodySource, type DatabaseSnapshot, type IssueBreakdownApprovalResult, type IssueBreakdownDraft, type ProjectSummary, type ProjectSnapshot, type ProspectorProjectSettings, type RelationRecord, type SearchCapability, type SearchDiagnostic, type SearchRequest, type SearchResponse, type StorageDriver } from "@agent-issues/core";
import type { CanonicalChainBundle } from "@agent-issues/core";
import { LocalSynchronizeStore } from "./features/synchronize/canonical-chain-store.js";
import * as localSynchronizeStore from "./features/synchronize/canonical-chain-store.js";
import { LocalUserDirectoryStore, upsertUser } from "./features/user-directory/store.js";
import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	QueryContextDirectoryInput
} from "./features/context/context-store.js";
import { LocalContextStore } from "./features/context/context-store.js";
import * as localContextStore from "./features/context/context-store.js";
import type { DatabaseLocationOptions } from "./db/database.js";
import { LocalHistoryDiagnosticsStore } from "./features/history-diagnostics.js";
import { deleteTenant, ensureDatabase, listTenants, renameTenant } from "./db/database.js";
import { getSqliteEntityOrThrow, resolveSqliteEntity, type SqliteExecutor, type SqliteInternalConnection } from "./db/sqlite-executor.js";
import { LocalEntityStore } from "./features/entity-store/store.js";
import * as localEntityStore from "./features/entity-store/store.js";
import { LocalIssueCommentStore } from "./features/issue-comment/store.js";
import { LocalPlanEntryStore } from "./features/plan-entry/store.js";
import * as localProjectSettingsStore from "./features/project-settings/store.js";
import { LocalSearchStore } from "./features/search/search-store.js";
import { LocalInstructionStore } from "./features/instructions/instruction-store.js";
import type { InstructionBundle, RetrieveInstructionInput, SaveInstructionSourceInput } from "@agent-issues/core";

export type OpenSqliteStoreResult = {
	store: SqliteStore;
	dbPath: string;
};

/**
 * The local, offline-default implementation of the storage-driver seam
 * (ADR11, ADR13). Wraps a synchronous better-sqlite3 connection; every
 * method resolves immediately since SQLite access is synchronous, but the
 * async signatures match the seam so a Postgres/HttpStore implementation
 * can slot in without callers branching on backend.
 */
export class SqliteStore implements StorageDriver {
	public constructor(executor: SqliteInternalConnection, actorIdentity?: AuthIdentity, strictProjectScope = false, hasProjectScope = false) {
		this.executor = executor;
		this.actorIdentity = actorIdentity;
		this.strictProjectScope = strictProjectScope;
		this.hasProjectScope = hasProjectScope;
		this.synchronizeStore = new LocalSynchronizeStore(executor);
		this.userDirectoryStore = new LocalUserDirectoryStore(executor);
		this.historyDiagnosticsStore = new LocalHistoryDiagnosticsStore(executor);
		this.contextStore = new LocalContextStore(executor);
		this.entityStore = new LocalEntityStore(executor, hasProjectScope);
		this.issueCommentStore = new LocalIssueCommentStore(executor);
		this.planEntryStore = new LocalPlanEntryStore(executor);
		this.searchStore = new LocalSearchStore(executor);
	}

	protected executor: SqliteInternalConnection;
	protected readonly actorIdentity: AuthIdentity | undefined;
	protected readonly strictProjectScope: boolean;
	protected readonly hasProjectScope: boolean;
	private readonly synchronizeStore: LocalSynchronizeStore;
	private readonly userDirectoryStore: LocalUserDirectoryStore;
	private readonly historyDiagnosticsStore: LocalHistoryDiagnosticsStore;
	private readonly contextStore: LocalContextStore;
	private readonly entityStore: LocalEntityStore;
	protected readonly issueCommentStore: LocalIssueCommentStore;
	protected readonly planEntryStore: LocalPlanEntryStore;
	protected readonly searchStore: LocalSearchStore;

	public get tenantId(): string {
		return this.executor.tenantId;
	}

	public async importInstructionBundle(bundle: InstructionBundle): Promise<void> {
		return new LocalInstructionStore(this.executor).importBundle(bundle);
	}

	public async retrieveInstruction(input: RetrieveInstructionInput) {
		return new LocalInstructionStore(this.executor).retrieveInstruction(input);
	}

	public async previewInstruction(input: Parameters<StorageDriver["previewInstruction"]>[0]) {
		return new LocalInstructionStore(this.executor).previewInstruction(input);
	}

	public async readInstructionSource(input: RetrieveInstructionInput) {
		return new LocalInstructionStore(this.executor).readInstructionSource(input);
	}

	public async compareInstructionSource(input: RetrieveInstructionInput) {
		return new LocalInstructionStore(this.executor).compareInstructionSource(input);
	}

	public async inspectInstructionDependencies(input: RetrieveInstructionInput) {
		return new LocalInstructionStore(this.executor).inspectInstructionDependencies(input);
	}

	public async listInstructionSources(input: { version: string }) {
		return new LocalInstructionStore(this.executor).listInstructionSources(input);
	}

	public async saveInstructionSource(input: SaveInstructionSourceInput) {
		return new LocalInstructionStore(this.executor).saveInstructionSource(input);
	}

	public async listInstructionHistory(input: RetrieveInstructionInput) {
		return new LocalInstructionStore(this.executor).listInstructionHistory(input);
	}

	public async readInstructionRevision(input: Parameters<StorageDriver["readInstructionRevision"]>[0]) {
		return new LocalInstructionStore(this.executor).readInstructionRevision(input);
	}

	public async restoreInstructionRevision(input: Parameters<StorageDriver["restoreInstructionRevision"]>[0]) {
		return new LocalInstructionStore(this.executor).restoreInstructionRevision(input);
	}

	public async resetInstructionSource(input: Parameters<StorageDriver["resetInstructionSource"]>[0]) {
		return new LocalInstructionStore(this.executor).resetInstructionSource(input);
	}

	public async inspectInstructionReset(input: Parameters<StorageDriver["inspectInstructionReset"]>[0]) {
		return new LocalInstructionStore(this.executor).inspectInstructionReset(input);
	}

	public async inspectInstructionResetAll(input: Parameters<StorageDriver["inspectInstructionResetAll"]>[0]) {
		return new LocalInstructionStore(this.executor).inspectInstructionResetAll(input);
	}

	public async resetInstructionAll(input: Parameters<StorageDriver["resetInstructionAll"]>[0]) {
		return new LocalInstructionStore(this.executor).resetInstructionAll(input);
	}

	public async commitInstructionChanges(input: Parameters<StorageDriver["commitInstructionChanges"]>[0]) {
		return new LocalInstructionStore(this.executor).commitInstructionChanges(input);
	}

	public async createInstructionFragment(input: Parameters<StorageDriver["createInstructionFragment"]>[0]) {
		return new LocalInstructionStore(this.executor).createInstructionFragment(input);
	}

	public async removeInstructionFragment(input: Parameters<StorageDriver["removeInstructionFragment"]>[0]) {
		return new LocalInstructionStore(this.executor).removeInstructionFragment(input);
	}

	public withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver {
		return new SqliteStore(this.executor, identity, this.strictProjectScope, this.hasProjectScope);
	}

	public async exportCanonicalChains() {
		return this.synchronizeStore.exportCanonicalChains();
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.executor.drizzle.transaction(() => {
			const result = localSynchronizeStore.importCanonicalChains(this.executor, bundle);
			this.searchStore.synchronizeSearchDocuments();
			return result;
		});
	}

	public async upsertUser(input: Parameters<StorageDriver["upsertUser"]>[0]) {
		return this.userDirectoryStore.upsertUser(input);
	}

	public async listUsers() {
		return this.userDirectoryStore.listUsers();
	}

	public async getHistoryDiagnostics() {
		return measureHistory(await this.synchronizeStore.exportCanonicalChains(), await this.historyDiagnosticsStore.getMaterializationDepths());
	}

	public async getProspectorSettings(): Promise<ProspectorProjectSettings> {
		return localProjectSettingsStore.getProspectorSettings(this.executor);
	}

	public async setProspectorSettings(settings: ProspectorProjectSettings): Promise<ProspectorProjectSettings> {
		return localProjectSettingsStore.setProspectorSettings(this.executor, settings);
	}

	public async getSearchCapability(): Promise<SearchCapability> {
		return this.searchStore.getSearchCapability();
	}

	public async getSearchDiagnostics(): Promise<SearchDiagnostic[]> {
		return this.searchStore.getSearchDiagnostics();
	}

	public async search(input: SearchRequest): Promise<SearchResponse> {
		return this.searchStore.search(input);
	}

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
	}) {
		if (input.parentId) {
			this.assertSelectedProjectEntity(input.parentId);
		}
		for (const link of input.links ?? []) {
			this.assertSelectedProjectEntity(link.targetId);
		}
		return toEntitySummary(await this.mutate(
			(actorId) => localEntityStore.createEntity(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.id) }
		));
	}

	public async getEntityDetails(entityId: string) {
		const details = await this.entityStore.getEntityDetails(entityId);
		if (details.entity.kind !== "issue") {
			if (this.hasProjectScope) {
				this.assertCurrentProjectEntity(entityId);
			}
			return details;
		}
		const entity = getSqliteEntityOrThrow(this.executor, details.entity.id);
		if (entity.projectId !== this.executor.currentProjectId) {
			const currentProject = getSqliteEntityOrThrow(this.executor, this.executor.currentProjectId);
			throw new Error(`Entity not found in current project "${currentProject.title}" (${currentProject.reference}): ${entityId}`);
		}

		return { ...details, comments: this.issueCommentStore.listIssueComments({ issueId: entity.id }) };
	}

	public async queryEntityRelations(input: Parameters<StorageDriver["queryEntityRelations"]>[0]) {
		this.assertCurrentProjectEntity(input.entityId);
		return this.entityStore.queryEntityRelations(input);
	}

	public async listEntities(kind: string) {
		return this.entityStore.listEntities(kind);
	}

	public async queryEntities(input: Parameters<StorageDriver["queryEntities"]>[0]) {
		return this.entityStore.queryEntities(input);
	}

	public async listEntityHistory(entityId: string) {
		if (this.hasProjectScope) {
			this.assertCurrentProjectEntity(entityId, true);
		}
		return this.entityStore.listEntityHistory(entityId);
	}

	public async createIssueComment(input: Parameters<StorageDriver["createIssueComment"]>[0]) {
		return this.mutate(
			(actorId) => this.issueCommentStore.createIssueComment(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeIssueCommentSearchDocument(result.id) }
		);
	}

	public async updateIssueComment(input: Parameters<StorageDriver["updateIssueComment"]>[0]) {
		return this.mutate(
			(actorId) => this.issueCommentStore.updateIssueComment(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeIssueCommentSearchDocument(result.id) }
		);
	}

	public async deleteIssueComment(input: Parameters<StorageDriver["deleteIssueComment"]>[0]) {
		return this.mutate(
			(actorId) => this.issueCommentStore.deleteIssueComment(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeIssueCommentSearchDocument(result.id) }
		);
	}

	public async listIssueComments(input: Parameters<StorageDriver["listIssueComments"]>[0]) {
		return this.issueCommentStore.listIssueComments(input);
	}

	public async listIssueCommentHistory(input: Parameters<StorageDriver["listIssueCommentHistory"]>[0]) {
		return this.issueCommentStore.listIssueCommentHistory(input);
	}

	public async confirmPlan(input: Parameters<StorageDriver["confirmPlan"]>[0]) {
		this.assertSelectedProjectEntity(input.planId);
		return this.mutate((actorId) => {
			const details = localEntityStore.getEntityDetails(this.executor, input.planId);
			if (details.entity.kind !== "plan") {
				throw new Error(`Plan not found: ${input.planId}`);
			}
			const proposedPlan = projectProposedPlan(details.entity, this.planEntryStore.listPlanEntries({ planId: details.entity.id }));
			if (proposedPlan.snapshotDigest !== input.snapshotDigest) {
				throw new Error(`Plan snapshot is stale: ${input.planId}`);
			}
			if (proposedPlan.hasActiveQuestions) {
				throw new Error(`Plan has active questions: ${input.planId}`);
			}
			if (details.entity.status === "ready") {
				return { entity: toEntitySummary(details.entity), previousStatus: "ready", confirmed: false };
			}
			if (details.entity.status !== "in-progress") {
				throw new Error(`Plan is not ready for confirmation: ${input.planId}`);
			}
			return { ...localEntityStore.updateEntityStatus(this.executor, { entityId: details.entity.id, status: "ready" }, actorId), confirmed: true };
		}, { synchronizeSearch: (result) => result.confirmed ? this.searchStore.synchronizeEntitySearchDocumentsForChange(result.entity.id) : undefined });
	}

	public async createIssueBreakdownDraft(input: Parameters<StorageDriver["createIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		this.assertSelectedProjectEntity(input.targetId);
		return this.mutate(() => {
			const target = getSqliteEntityOrThrow(this.executor, input.targetId);
			if (!["initiative", "userStory"].includes(target.kind)) {
				throw new Error(`Issue-breakdown draft target must be an initiative or user story: ${input.targetId}`);
			}
			const projected = projectProposedIssueBreakdown({ targetId: target.id, targetReference: target.reference, issues: input.issues });
			const id = randomUUID();
			const now = new Date().toISOString();
			this.executor.drizzle.run(sql`UPDATE issue_breakdown_drafts SET status = 'superseded', updated_at = ${now}
				WHERE tenant_id = ${this.executor.tenantId} AND target_id = ${target.id} AND status = 'active'`);
			this.executor.drizzle.run(sql`INSERT INTO issue_breakdown_drafts (tenant_id, id, target_id, status, snapshot_json, snapshot_digest, created_at, updated_at)
				VALUES (${this.executor.tenantId}, ${id}, ${target.id}, 'active', ${JSON.stringify(projected)}, ${projected.snapshotDigest}, ${now}, ${now})`);
			return { id, status: "active", approvedAt: null, createdIssueReferences: [], ...projected };
		});
	}

	public async getIssueBreakdownDraft(input: Parameters<StorageDriver["getIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		return this.getIssueBreakdownDraftByWhere(sql`id = ${input.draftId}`);
	}

	public async getLatestIssueBreakdownDraft(input: Parameters<StorageDriver["getLatestIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		this.assertSelectedProjectEntity(input.targetId);
		return this.getIssueBreakdownDraftByWhere(sql`target_id = ${input.targetId} AND status = 'active'`);
	}

	public async approveIssueBreakdownDraft(input: Parameters<StorageDriver["approveIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownApprovalResult> {
		return this.mutate((actorId) => {
			const draft = this.getIssueBreakdownDraftByWhere(sql`id = ${input.draftId}`);
			if (draft.status === "approved" && draft.snapshotDigest === input.snapshotDigest) {
				return { status: "approved", targetReference: draft.targetReference, createdIssueReferences: draft.createdIssueReferences };
			}
			if (draft.snapshotDigest !== input.snapshotDigest || draft.status === "superseded") {
				return { status: "stale", draft: draft.status === "approved" ? draft : this.getIssueBreakdownDraftByWhere(sql`target_id = ${draft.targetId} AND status = 'active'`) };
			}

			const issueIds = new Map<string, string>();
			const createdIssueReferences: string[] = [];
			for (const issue of draft.issues) {
				if (issueIds.has(issue.key)) {
					throw new Error(`Issue-breakdown draft contains duplicate issue key: ${issue.key}`);
				}
				const parentId = issue.parentKey ? issueIds.get(issue.parentKey) : draft.targetId;
				if (!parentId) {
					throw new Error(`Issue-breakdown draft contains an unknown parent key: ${issue.parentKey}`);
				}
				const created = localEntityStore.createEntity(this.executor, {
					kind: "issue",
					title: issue.title,
					parentId,
					body: formatIssueBody(issue)
				}, actorId);
				issueIds.set(issue.key, created.id);
				createdIssueReferences.push(created.reference);
			}
			for (const issue of draft.issues) {
				for (const entryId of issue.planEntryIds ?? []) {
					this.planEntryStore.linkPlanEntryEntity({
						entryId,
						targetId: issueIds.get(issue.key)!
					}, actorId);
				}
			}
			for (const issue of draft.issues) {
				for (const relation of issue.relationReferences) {
					const targetId = relation.targetKey ? issueIds.get(relation.targetKey) : relation.targetId ?? relation.targetReference;
					if (!targetId) {
						throw new Error(`Issue-breakdown draft contains an unresolved relation target for ${issue.key}`);
					}
					localEntityStore.linkEntities(this.executor, { fromId: issueIds.get(issue.key)!, relationType: relation.relationType, toId: targetId }, actorId);
				}
			}

			const approvedAt = new Date().toISOString();
			this.executor.drizzle.run(sql`UPDATE issue_breakdown_drafts
				SET status = 'approved', approved_at = ${approvedAt}, created_issue_references = ${JSON.stringify(createdIssueReferences)}, updated_at = ${approvedAt}
				WHERE tenant_id = ${this.executor.tenantId} AND id = ${draft.id}`);
			return { status: "approved", targetReference: draft.targetReference, createdIssueReferences };
		});
	}

	public async createPlanEntry(input: Parameters<StorageDriver["createPlanEntry"]>[0]) {
		return this.mutate(
			(actorId) => this.planEntryStore.createPlanEntry(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizePlanEntrySearchDocument(result.id) }
		);
	}

	public async getPlanEntry(input: Parameters<StorageDriver["getPlanEntry"]>[0]) {
		return this.planEntryStore.getPlanEntry(input);
	}

	public async listPlanEntries(input: Parameters<StorageDriver["listPlanEntries"]>[0]) {
		return this.planEntryStore.listPlanEntries(input);
	}

	public async listPlanEntryPage(input: Parameters<StorageDriver["listPlanEntryPage"]>[0]) {
		return this.planEntryStore.listPlanEntryPage(input);
	}

	public async updatePlanEntry(input: Parameters<StorageDriver["updatePlanEntry"]>[0]) {
		return this.mutate(
			(actorId) => this.planEntryStore.updatePlanEntry(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizePlanEntrySearchDocument(result.id) }
		);
	}

	public async deletePlanEntry(input: Parameters<StorageDriver["deletePlanEntry"]>[0]) {
		return this.mutate(
			(actorId) => this.planEntryStore.deletePlanEntry(input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizePlanEntrySearchDocument(result.id) }
		);
	}

	public async linkPlanEntryEntity(input: Parameters<StorageDriver["linkPlanEntryEntity"]>[0]) {
		return this.mutate((actorId) => this.planEntryStore.linkPlanEntryEntity(input, actorId), { synchronizeSearch: false });
	}

	public async unlinkPlanEntryEntity(input: Parameters<StorageDriver["unlinkPlanEntryEntity"]>[0]) {
		return this.mutate((actorId) => this.planEntryStore.unlinkPlanEntryEntity(input, actorId), { synchronizeSearch: false });
	}

	public async listPlanEntryHistory(input: Parameters<StorageDriver["listPlanEntryHistory"]>[0]) {
		return this.planEntryStore.listPlanEntryHistory(input);
	}

	public async listAllRelations() {
		const relations = await this.entityStore.listAllRelations();
		return relations.filter((relation) => {
			const from = resolveSqliteEntity(this.executor, relation.fromId);
			const to = resolveSqliteEntity(this.executor, relation.toId);
			return from?.projectId === this.executor.currentProjectId && to?.projectId === this.executor.currentProjectId;
		});
	}

	public async applyRelations(relations: RelationRecord[]) {
		for (const relation of relations) {
			this.assertSelectedProjectEntity(relation.fromId);
			this.assertSelectedProjectEntity(relation.toId);
		}
		return this.executor.drizzle.transaction(() => {
			const result = localEntityStore.applyRelations(this.executor, relations);
			this.searchStore.synchronizeSearchDocuments();
			return result;
		});
	}

	public async listOrphans(kind?: string) {
		return this.entityStore.listOrphans(kind);
	}

	public async listProjectAdrs() {
		return this.entityStore.listProjectAdrs();
	}

	public async updateEntityStatus(input: Parameters<StorageDriver["updateEntityStatus"]>[0]) {
		this.assertSelectedProjectEntity(input.entityId);
		return this.mutate(
			(actorId) => localEntityStore.updateEntityStatus(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.entity.id) }
		);
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; category?: string; priority?: string; author?: string; expectedRevision: number; expectedContentHash: string }) {
		this.assertSelectedProjectEntity(input.entityId);
		return this.mutate(
			(actorId) => localEntityStore.updateEntity(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.id) }
		);
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }) {
		this.assertSelectedProjectEntity(input.entityId);
		return this.mutate(
			(actorId) => localEntityStore.setEntityBody(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.id) }
		);
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		return this.entityStore.materializeEntityRevision(input);
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		this.assertSelectedProjectEntity(input.entityId, true);
		return this.mutate(
			(actorId) => localEntityStore.restoreEntityRevision(this.executor, input, actorId),
			{ synchronizeSearch: () => this.searchStore.synchronizeEntitySearchDocumentsForChange(input.entityId) }
		);
	}

	public async archiveEntity(input: { entityId: string }) {
		this.assertSelectedProjectEntity(input.entityId);
		return this.mutate(
			(actorId) => localEntityStore.archiveEntity(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.entity.id) }
		);
	}

	public async deleteEntity(input: { entityId: string }) {
		this.assertSelectedProjectEntity(input.entityId);
		const synchronizeSearch = this.searchStore.prepareEntitySearchDocumentsForChange(input.entityId);
		return this.mutate(
			(actorId) => localEntityStore.deleteEntity(this.executor, input, actorId),
			{ synchronizeSearch: () => synchronizeSearch() }
		);
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }) {
		this.assertSelectedProjectEntity(input.entityId);
		this.assertSelectedProjectEntity(input.newParentId);
		return this.mutate(
			(actorId) => localEntityStore.moveEntity(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeEntitySearchDocumentsForChange(result.entity.id) }
		);
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }) {
		this.assertSelectedProjectEntity(input.fromId);
		this.assertSelectedProjectEntity(input.toId);
		return this.mutate(
			(actorId) => localEntityStore.linkEntities(this.executor, input, actorId),
			{
				synchronizeSearch: (result) => {
					if (result.created && isStructuralRelationType(result.relation.type)) {
						this.searchStore.synchronizeEntitySearchDocumentsForChange(result.relation.toId);
					}
				}
			}
		);
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }) {
		this.assertSelectedProjectEntity(input.fromId);
		this.assertSelectedProjectEntity(input.toId);
		return this.mutate(
			() => localEntityStore.unlinkEntities(this.executor, input),
			{
				synchronizeSearch: (result) => {
					if (result.removed && isStructuralRelationType(result.relation.type)) {
						this.searchStore.synchronizeEntitySearchDocumentsForChange(result.relation.toId);
					}
				}
			}
		);
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		return input ? this.entityStore.getDatabaseSnapshot(input) : this.entityStore.getDatabaseSnapshot();
	}

	public async getProjectSummary(input: { projectId: string }): Promise<ProjectSummary> {
		return this.entityStore.getProjectSummary(input);
	}

	public async getProjectDiscovery(input?: { projectId?: string }) {
		return this.entityStore.getProjectDiscovery(input);
	}

	public async getInitiativeBundle(initiativeId: string) {
		return this.entityStore.getInitiativeBundle(initiativeId);
	}

	public async getInitiativeDetail(input: Parameters<StorageDriver["getInitiativeDetail"]>[0]) {
		return this.entityStore.getInitiativeDetail(input);
	}

	public async getInitiativeTab(input: Parameters<StorageDriver["getInitiativeTab"]>[0]) {
		return this.entityStore.getInitiativeTab(input);
	}

	public async getSnapshotSignature(): Promise<string> {
		return this.entityStore.getSnapshotSignature();
	}

	public async listContexts(): Promise<ContextListResult> {
		return this.contextStore.listContexts();
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.contextStore.getContextDetails(input);
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return this.contextStore.getContextDirectory();
	}

	public async queryContextDirectory(input?: QueryContextDirectoryInput) {
		return this.contextStore.queryContextDirectory(input);
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return toContextWriteResult(await this.mutate(
			(actorId) => localContextStore.upsertContext(this.executor, input, actorId),
			{
				synchronizeSearch: (result) => {
					if (result.context.id) {
						this.searchStore.synchronizeContextSearchDocument(result.context.id);
					}
				}
			}
		));
	}

	public async defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		return toDefineContextTermAcknowledgement(await this.mutate(
			(actorId) => localContextStore.defineContextTerm(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeContextTermSearchDocument(result.term.id) }
		));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }) {
		const termId = (await this.contextStore.getContextDetails({ scopeRef: input.scopeRef })).terms.find((term) => term.term === input.term.trim())?.id;
		return this.mutate(
			(actorId) => localContextStore.forgetContextTerm(this.executor, input, actorId),
			{ synchronizeSearch: termId ? () => this.searchStore.synchronizeContextTermSearchDocument(termId) : false }
		);
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		return this.contextStore.materializeContextRevision(input);
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		return this.contextStore.materializeContextTermRevision(input);
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const context = (await this.contextStore.getContextDetails({ scopeRef: input.scopeRef })).context;
		return this.mutate(
			(actorId) => localContextStore.restoreContextRevision(this.executor, input, actorId),
			{
				synchronizeSearch: () => {
					if (context.id) {
						this.searchStore.synchronizeContextSearchDocument(context.id);
					}
				}
			}
		);
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		return this.mutate(
			(actorId) => localContextStore.restoreContextTermRevision(this.executor, input, actorId),
			{ synchronizeSearch: (result) => this.searchStore.synchronizeContextTermSearchDocument(result.id) }
		);
	}

	public async listTenants() {
		return listTenants(this.executor);
	}

	public async deleteTenant(tenantId: string) {
		return this.mutate(() => deleteTenant(this.executor, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string) {
		return this.mutate(() => renameTenant(this.executor, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		this.executor.close();
	}

	protected assertSelectedProjectEntity(entityId: string, includeTombstone = false): void {
		if (!this.strictProjectScope) {
			return;
		}

		const entity = resolveSqliteEntity(this.executor, entityId, includeTombstone);
		if (!entity || entity.projectId !== this.executor.currentProjectId) {
			throw new Error(`Entity not found: ${entityId}`);
		}
	}

	protected assertCurrentProjectEntity(entityId: string, includeTombstone = false): void {
		const entity = resolveSqliteEntity(this.executor, entityId, includeTombstone);
		if (!entity || entity.projectId !== this.executor.currentProjectId) {
			throw new Error(`Entity not found: ${entityId}`);
		}
	}

	protected getIssueBreakdownDraftByWhere(where: ReturnType<typeof sql>): IssueBreakdownDraft {
		const row = this.executor.drizzle.get(sql`SELECT * FROM issue_breakdown_drafts WHERE tenant_id = ${this.executor.tenantId} AND ${where} ORDER BY created_at DESC LIMIT 1`) as {
			id: string;
			target_id: string;
			status: "active" | "approved" | "superseded";
			snapshot_json: string;
			approved_at: string | null;
			created_issue_references: string;
		} | undefined;
		if (!row) {
			throw new Error("Issue-breakdown draft not found.");
		}
		this.assertSelectedProjectEntity(row.target_id);
		try {
			return {
				id: row.id,
				status: row.status,
				approvedAt: row.approved_at,
				createdIssueReferences: JSON.parse(row.created_issue_references) as string[],
				...(JSON.parse(row.snapshot_json) as ReturnType<typeof projectProposedIssueBreakdown>)
			};
		} catch (error) {
			throw new Error(`Issue-breakdown draft contains malformed JSON: ${row.id}`, { cause: error });
		}
	}

	protected mutate<T>(operation: (actorId: string) => T, options: { synchronizeSearch?: false | ((result: T) => void) } = {}): T {
		return this.executor.drizzle.transaction(() => {
			const username = resolveLocalUsername();
			const identity = this.actorIdentity ?? { userId: `local:${username}`, tenantId: this.tenantId, displayName: username };
			const user = upsertUser(this.executor, { authenticationSubject: identity.userId, displayName: identity.displayName });
			const result = operation(user.id);
			if (typeof options.synchronizeSearch === "function") {
				options.synchronizeSearch(result);
			} else if (options.synchronizeSearch !== false) {
				this.searchStore.synchronizeSearchDocuments();
			}
			return result;
		});
	}
}

function formatIssueBody(issue: IssueBreakdownDraft["issues"][number]): string {
	return [
		"## Work Mode",
		"",
		issue.workMode,
		"",
		"## Outcome",
		"",
		issue.outcome,
		"",
		"## Scope",
		"",
		...issue.scope.map((item) => `- ${item}`),
		"",
		"## Acceptance Criteria",
		"",
		...issue.acceptanceCriteria.map((item) => `- ${item}`)
	].join("\n");
}

export async function openSqliteStore(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenSqliteStoreResult> {
	const { executor, dbPath } = await ensureDatabase(inputPath, options);
	return { store: new SqliteStore(executor, undefined, isDirectEntitySelector(options?.projectIdentity ?? ""), options?.projectIdentity !== undefined), dbPath };
}
