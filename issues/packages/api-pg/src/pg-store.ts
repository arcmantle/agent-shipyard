import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
	BodySource,
	CanonicalIssueCommentChain,
	AuthIdentity,
	CanonicalChainBundle,
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	ContextWriteResult,
	DatabaseSnapshot,
	DefineContextTermAcknowledgement,
	DefineContextTermResult,
	DeleteResult,
	DeleteTenantResult,
	EntityDetails,
	EntityRecord,
	EntityRelations,
	EntitySummary,
	ForgetContextTermResult,
	HistoryEntryRecord,
	InitiativeBundle,
	InitiativeDetail,
	InitiativeTab,
	InitiativeTabData,
	IssueCommentPage,
	IssueCommentRecord,
	IssueCommentHistoryEntry,
	IssueBreakdownApprovalResult,
	IssueBreakdownDraft,
	LinkResult,
	MoveResult,
	ProjectDiscovery,
	ProjectSummary,
	ProjectSnapshot,
	ProspectorProjectSettings,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult,
	QueryEntitiesInput,
	QueryEntitiesResult,
	QueryEntityRelationsInput,
	RelationRecord,
	RenameTenantResult,
	StatusUpdateResult,
	StorageDriver,
	TenantSummary,
	UnlinkResult
} from "@agent-issues/core";
import { computeIssueCommentContentHash, createReverseFieldPatch, encodeCanonicalReference, isDirectEntitySelector, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, IssueCommentConflictError, materializeIssueCommentFromPatches, measureHistory, projectProposedIssueBreakdown, projectProposedPlan, shortEntityReference, SYSTEM_AUTHENTICATION_SUBJECT, toEntitySummary, type SearchCapability, type SearchDiagnostic, type SearchRequest, type SearchResponse } from "@agent-issues/core";
import type { Pool } from "pg";

import { withTenantTransaction, type TenantExecutor } from "./db/connection.js";
import { PgSynchronizeStore } from "./features/synchronize/canonical-chain-store.js";
import { PgUserDirectoryStore } from "./features/user-directory/store.js";
import { deleteTenant, listTenants, renameTenant } from "./db/tenant-admin.js";
import { PgContextStore } from "./features/context/context-store.js";
import { createEntity, linkEntities, PgEntityStore, resolveCurrentProjectId } from "./features/entity-store/store.js";
import { PgHistoryDiagnosticsStore } from "./features/history-diagnostics.js";
import { PgIssueCommentStore } from "./features/issue-comment/store.js";
import { PgPlanEntryStore } from "./features/plan-entry/store.js";
import * as pgProjectSettingsStore from "./features/project-settings/store.js";
import { PgSearchStore } from "./features/search/search-store.js";
import { PgInstructionStore } from "./features/instructions/instruction-store.js";

/**
 * Postgres implementation of the storage-driver seam (ADR11, ADR13, ISS39).
 * Every method opens exactly one `withTenantTransaction` (ADR9's `SET LOCAL
 * app.tenant_id`), so RLS is always active for the query, then delegates to
 * the free functions in `features/entity-store`, `features/context`, and
 * `db/tenant-admin` - mirroring `SqliteStore`'s own thin-delegating-class
 * shape exactly (`api-local/src/sqlite-store.ts`).
 *
 * Tenant administration (`listTenants`/`deleteTenant`/`renameTenant`) is
 * necessarily narrower here than `SqliteStore`'s: RLS makes each `PgStore`
 * instance's own tenant the only one it can ever see or touch (ADR9), so
 * these methods only ever report on or act on `this.tenantId` - never an
 * arbitrary other tenant the way a single SQLite file's admin CLI can.
 * `renameTenant` copies every row to the new tenant id under a temporarily
 * re-pointed `app.tenant_id` and then deletes the old rows, rather than a
 * single `UPDATE ... SET tenant_id`, because RLS's `USING` (old value) and
 * `WITH CHECK` (new value) can never both pass for one statement scoped to
 * a single session tenant id.
 */
export class PgStore implements StorageDriver {
	public constructor(
		private readonly pool: Pool,
		public readonly tenantId: string,
		/**
		 * The executor-resolved project identity (ISS183, mirroring
		 * `resolveProjectIdentity` in core) this request is scoped to.
		 * Threaded from the cloud gate's `x-agent-issues-project-identity`
		 * header. Undefined keeps today's behavior: the bare (no `--scope`)
		 * default context resolves to the tenant-wide sentinel, exactly as
		 * before this issue - so single-project tenants and any caller that
		 * doesn't send the header see no change at all.
		 */
		private readonly projectIdentity?: string,
		actorIdentity?: AuthIdentity
	) {
		this.actorIdentity = actorIdentity;
		this.strictProjectScope = isDirectEntitySelector(projectIdentity ?? "");
	}

	/**
	 * The project this store settled on, kept for its lifetime. See
	 * `transaction` for why it is resolved once rather than per call.
	 */
	protected currentProjectId?: string;
	protected readonly actorIdentity: AuthIdentity | undefined;
	protected readonly strictProjectScope: boolean;
	protected readonly searchDiagnostics: SearchDiagnostic[] = [];

	public async retrieveInstruction(input: Parameters<StorageDriver["retrieveInstruction"]>[0]): Promise<Awaited<ReturnType<StorageDriver["retrieveInstruction"]>>> {
		return this.instructionTransaction((store) => store.retrieveInstruction(input));
	}

	public async previewInstruction(input: Parameters<StorageDriver["previewInstruction"]>[0]) {
		return this.instructionTransaction((store) => store.previewInstruction(input));
	}

	public async listInstructionSources(input: Parameters<StorageDriver["listInstructionSources"]>[0]) {
		return this.instructionTransaction((store) => store.listInstructionSources(input));
	}

	public async readInstructionSource(input: Parameters<StorageDriver["readInstructionSource"]>[0]) {
		return this.instructionTransaction((store) => store.readInstructionSource(input));
	}

	public async compareInstructionSource(input: Parameters<StorageDriver["compareInstructionSource"]>[0]) {
		return this.instructionTransaction((store) => store.compareInstructionSource(input));
	}

	public async inspectInstructionDependencies(input: Parameters<StorageDriver["inspectInstructionDependencies"]>[0]) {
		return this.instructionTransaction((store) => store.inspectInstructionDependencies(input));
	}

	public async saveInstructionSource(input: Parameters<StorageDriver["saveInstructionSource"]>[0]) {
		return this.instructionTransaction((store) => store.saveInstructionSource(input));
	}

	public async listInstructionHistory(input: Parameters<StorageDriver["listInstructionHistory"]>[0]) {
		return this.instructionTransaction((store) => store.listInstructionHistory(input));
	}

	public async readInstructionRevision(input: Parameters<StorageDriver["readInstructionRevision"]>[0]) {
		return this.instructionTransaction((store) => store.readInstructionRevision(input));
	}

	public async restoreInstructionRevision(input: Parameters<StorageDriver["restoreInstructionRevision"]>[0]) {
		return this.instructionTransaction((store) => store.restoreInstructionRevision(input));
	}

	public async resetInstructionSource(input: Parameters<StorageDriver["resetInstructionSource"]>[0]) {
		return this.instructionTransaction((store) => store.resetInstructionSource(input));
	}

	public async inspectInstructionReset(input: Parameters<StorageDriver["inspectInstructionReset"]>[0]) {
		return this.instructionTransaction((store) => store.inspectInstructionReset(input));
	}

	public async inspectInstructionResetAll(input: Parameters<StorageDriver["inspectInstructionResetAll"]>[0]) {
		return this.instructionTransaction((store) => store.inspectInstructionResetAll(input));
	}

	public async resetInstructionAll(input: Parameters<StorageDriver["resetInstructionAll"]>[0]) {
		return this.instructionTransaction((store) => store.resetInstructionAll(input));
	}

	public async commitInstructionChanges(input: Parameters<StorageDriver["commitInstructionChanges"]>[0]) {
		return this.instructionTransaction((store) => store.commitInstructionChanges(input));
	}

	public async createInstructionFragment(input: Parameters<StorageDriver["createInstructionFragment"]>[0]) {
		return this.instructionTransaction((store) => store.createInstructionFragment(input));
	}

	public async removeInstructionFragment(input: Parameters<StorageDriver["removeInstructionFragment"]>[0]) {
		return this.instructionTransaction((store) => store.removeInstructionFragment(input));
	}

	protected instructionTransaction<T>(operation: (store: PgInstructionStore) => Promise<T>): Promise<T> {
		const identity = this.actorIdentity;
		if (!identity || identity.tenantId !== this.tenantId || !identity.userId) {
			throw new Error("Instruction retrieval requires an authenticated owner.");
		}
		return this.tenantWideTransaction(async (executor) => {
			await executor.execute(sql`SELECT set_config('app.instruction_user_id', ${identity.userId}, true)`);
			return operation(new PgInstructionStore(executor, identity.userId));
		});
	}

	private get historyDiagnosticsStore(): PgHistoryDiagnosticsStore {
		return new PgHistoryDiagnosticsStore(this.pool, this.tenantId);
	}

	/**
	 * One `withTenantTransaction` per store method (ADR9), carrying this
	 * request's `projectIdentity` onto the executor so project-scoped reads can
	 * resolve it.
	 *
	 * The project is resolved on this store's FIRST transaction and remembered
	 * for its lifetime, which is what makes cloud behave like local rather than
	 * merely look like it: local resolves `currentProjectId` once when the
	 * database is opened, so a session that later creates a second project
	 * keeps operating as the project it opened against. Resolving lazily or
	 * per-transaction instead would make the same sequence start failing the
	 * moment a second project appeared. Only harvested after `fn` succeeds - a
	 * rolled-back transaction may have resolved to a project that no longer
	 * exists.
	 */
	protected transaction<T>(fn: (executor: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(
			this.pool,
			this.tenantId,
			async (executor) => {
				// Awaited before `fn` runs, not merely started: the advisory lock
				// inside project registration is transaction-scoped, so it cannot
				// serialize two resolutions racing within this same transaction.
				// Letting `fn` start first is how a store ends up minting two
				// projects for one identity and making it ambiguous forever.
				const projectId = this.currentProjectId ?? (await resolveCurrentProjectId(executor, executor.projectIdentity));
				executor.currentProjectId = projectId;

				const result = await fn(executor);
				this.currentProjectId = projectId;
				return result;
			},
			this.projectIdentity
		);
	}

	/**
	 * For the methods that legitimately span every project - project discovery
	 * (the call that tells you which projects exist), whole-tenant synchronize,
	 * and tenant administration. These deliberately skip project resolution:
	 * requiring one would make discovery fail in exactly the multi-project
	 * tenants it exists for, and would let a `deleteTenant` call register a
	 * project in the tenant it is about to remove.
	 */
	protected tenantWideTransaction<T>(fn: (executor: TenantExecutor) => Promise<T>): Promise<T> {
		return withTenantTransaction(this.pool, this.tenantId, fn, this.projectIdentity);
	}

	public withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver {
		return new PgStore(this.pool, this.tenantId, this.projectIdentity, identity);
	}

	protected mutation<T>(fn: (executor: TenantExecutor, actorId: string) => Promise<T>): Promise<T> {
		return this.transaction(async (executor) => {
			const identity = this.actorIdentity ?? { userId: SYSTEM_AUTHENTICATION_SUBJECT, tenantId: this.tenantId };
			const user = await new PgUserDirectoryStore(executor).upsertUser({ authenticationSubject: identity.userId, displayName: identity.displayName });
			return fn(executor, user.id);
		});
	}

	protected tenantWideMutation<T>(fn: (executor: TenantExecutor, actorId: string) => Promise<T>): Promise<T> {
		return this.tenantWideTransaction(async (executor) => {
			const identity = this.actorIdentity ?? { userId: SYSTEM_AUTHENTICATION_SUBJECT, tenantId: this.tenantId };
			const user = await new PgUserDirectoryStore(executor).upsertUser({ authenticationSubject: identity.userId, displayName: identity.displayName });
			return fn(executor, user.id);
		});
	}

	protected async getIssueBreakdownDraftByWhere(where: ReturnType<typeof sql>): Promise<IssueBreakdownDraft> {
		return this.transaction(async (executor) => {
			const result = await executor.execute(sql`SELECT * FROM issue_breakdown_drafts WHERE tenant_id = ${executor.tenantId} AND ${where} ORDER BY created_at DESC LIMIT 1`);
			const row = result.rows[0] as {
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
			await this.assertSelectedProjectEntity(executor, row.target_id);
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
		});
	}

	public async exportCanonicalChains() {
		return this.tenantWideTransaction((executor) => new PgSynchronizeStore(executor).exportCanonicalChains());
	}

	public async importCanonicalChains(bundle: CanonicalChainBundle) {
		return this.tenantWideMutation((executor) => new PgSynchronizeStore(executor).importCanonicalChains(bundle));
	}

	public async upsertUser(input: Parameters<StorageDriver["upsertUser"]>[0]) {
		return this.tenantWideTransaction((executor) => new PgUserDirectoryStore(executor).upsertUser(input));
	}

	public async listUsers() {
		return this.tenantWideTransaction((executor) => new PgUserDirectoryStore(executor).listUsers());
	}

	public async getHistoryDiagnostics() {
		return measureHistory(await this.exportCanonicalChains(), await this.historyDiagnosticsStore.getMaterializationDepths());
	}

	public async getProspectorSettings(): Promise<ProspectorProjectSettings> {
		return this.transaction((executor) => pgProjectSettingsStore.getProspectorSettings(executor));
	}

	public async setProspectorSettings(settings: ProspectorProjectSettings): Promise<ProspectorProjectSettings> {
		return this.mutation((executor) => pgProjectSettingsStore.setProspectorSettings(executor, settings));
	}

	public async getSearchCapability(): Promise<SearchCapability> {
		return this.transaction(async (executor) => new PgSearchStore(executor, this.searchDiagnostics).getSearchCapability());
	}

	public async getSearchDiagnostics(): Promise<SearchDiagnostic[]> {
		return this.transaction(async (executor) => new PgSearchStore(executor, this.searchDiagnostics).getSearchDiagnostics());
	}

	public async search(input: SearchRequest): Promise<SearchResponse> {
		return this.transaction((executor) => new PgSearchStore(executor, this.searchDiagnostics).search(input));
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
	}): Promise<EntitySummary> {
		return this.mutation(async (executor, actorId) => {
			if (input.parentId) {
				await this.assertSelectedProjectEntity(executor, input.parentId);
			}
			for (const link of input.links ?? []) {
				await this.assertSelectedProjectEntity(executor, link.targetId);
			}
			return new PgEntityStore(executor, this.projectIdentity).createEntity(input, actorId);
		});
	}

	public async getEntityDetails(entityId: string): Promise<EntityDetails> {
		const details = await this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getEntityDetails(entityId));
		if (details.entity.kind !== "issue") {
			if (this.projectIdentity !== undefined) {
				await this.transaction((executor) => this.assertCurrentProjectEntity(executor, entityId));
			}
			return details;
		}

		const issue = await this.transaction((executor) => findProjectIssue(executor, details.entity.id));
		if (!issue) {
			if (this.projectIdentity !== undefined) {
				const currentProject = await this.transaction((executor) => findCurrentProject(executor));
				if (currentProject) {
					throw new Error(`Entity not found in current project "${currentProject.title}" (${currentProject.reference}): ${entityId}`);
				}

				throw new Error(`Entity not found: ${entityId}`);
			}
			return { ...details, comments: { comments: [], users: [], total: 0, nextBefore: null } };
		}

		return { ...details, comments: await this.listIssueComments({ issueId: issue.id }) };
	}

	public async queryEntityRelations(input: QueryEntityRelationsInput): Promise<EntityRelations> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).queryEntityRelations(input));
	}

	public async listEntities(kind: string): Promise<EntitySummary[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listEntities(kind));
	}

	public async queryEntities(input: QueryEntitiesInput): Promise<QueryEntitiesResult> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).queryEntities(input));
	}

	public async listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return this.transaction(async (executor) => {
			if (this.projectIdentity !== undefined) {
				await this.assertCurrentProjectEntity(executor, entityId, true);
			}
			return new PgEntityStore(executor, this.projectIdentity).listEntityHistory(entityId);
		});
	}

	public async createIssueComment(input: { issueId: string; body: string; referencedIssueIds?: string[] }): Promise<IssueCommentRecord> {
		return this.mutation((executor, actorId) => new PgIssueCommentStore(executor).createIssueComment(input, actorId));
	}

	public async updateIssueComment(input: { commentId: string; body: string; referencedIssueIds?: string[]; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord> {
		return this.mutation((executor, actorId) => new PgIssueCommentStore(executor).updateIssueComment(input, actorId));
	}

	public async deleteIssueComment(input: { commentId: string; expectedRevision: number; expectedContentHash: string }): Promise<IssueCommentRecord> {
		return this.mutation((executor, actorId) => new PgIssueCommentStore(executor).deleteIssueComment(input, actorId));
	}

	public async listIssueComments(input: { issueId: string; before?: string; all?: boolean }): Promise<IssueCommentPage> {
		return this.transaction((executor) => new PgIssueCommentStore(executor).listIssueComments(input));
	}

	public async listIssueCommentHistory(input: { commentId: string }): Promise<IssueCommentHistoryEntry[]> {
		return this.transaction((executor) => new PgIssueCommentStore(executor).listIssueCommentHistory(input));
	}

	public async confirmPlan(input: Parameters<StorageDriver["confirmPlan"]>[0]) {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.planId);
			const entityStore = new PgEntityStore(executor, this.projectIdentity);
			const details = await entityStore.getEntityDetails(input.planId);
			if (details.entity.kind !== "plan") {
				throw new Error(`Plan not found: ${input.planId}`);
			}
			const proposedPlan = projectProposedPlan(details.entity, await new PgPlanEntryStore(executor).listPlanEntries({ planId: details.entity.id }));
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
			return { ...(await entityStore.updateEntityStatus({ entityId: details.entity.id, status: "ready" }, actorId)), confirmed: true };
		});
	}

	public async createIssueBreakdownDraft(input: Parameters<StorageDriver["createIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		return this.mutation(async (executor) => {
			await this.assertSelectedProjectEntity(executor, input.targetId);
			const target = (await new PgEntityStore(executor, this.projectIdentity).getEntityDetails(input.targetId)).entity;
			if (!["initiative", "userStory"].includes(target.kind)) {
				throw new Error(`Issue-breakdown draft target must be an initiative or user story: ${input.targetId}`);
			}
			const projected = projectProposedIssueBreakdown({ targetId: target.id, targetReference: target.reference, issues: input.issues });
			const id = randomUUID();
			const now = new Date().toISOString();
			await executor.execute(sql`UPDATE issue_breakdown_drafts SET status = 'superseded', updated_at = ${now}
				WHERE tenant_id = ${executor.tenantId} AND target_id = ${target.id}::uuid AND status = 'active'`);
			await executor.execute(sql`INSERT INTO issue_breakdown_drafts (tenant_id, id, target_id, status, snapshot_json, snapshot_digest, created_at, updated_at)
				VALUES (${executor.tenantId}, ${id}::uuid, ${target.id}::uuid, 'active', ${JSON.stringify(projected)}, ${projected.snapshotDigest}, ${now}, ${now})`);
			return { id, status: "active", approvedAt: null, createdIssueReferences: [], ...projected };
		});
	}

	public async getIssueBreakdownDraft(input: Parameters<StorageDriver["getIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		return this.getIssueBreakdownDraftByWhere(sql`id = ${input.draftId}::uuid`);
	}

	public async getLatestIssueBreakdownDraft(input: Parameters<StorageDriver["getLatestIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownDraft> {
		return this.getIssueBreakdownDraftByWhere(sql`target_id = ${input.targetId}::uuid AND status = 'active'`);
	}

	public async approveIssueBreakdownDraft(input: Parameters<StorageDriver["approveIssueBreakdownDraft"]>[0]): Promise<IssueBreakdownApprovalResult> {
		return this.mutation(async (executor, actorId) => {
			const readDraft = async (where: ReturnType<typeof sql>): Promise<IssueBreakdownDraft> => {
				const result = await executor.execute(sql`SELECT * FROM issue_breakdown_drafts WHERE tenant_id = ${executor.tenantId} AND ${where} ORDER BY created_at DESC LIMIT 1`);
				const row = result.rows[0] as {
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
				await this.assertSelectedProjectEntity(executor, row.target_id);
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
			};

			const draft = await readDraft(sql`id = ${input.draftId}::uuid`);
			if (draft.status === "approved" && draft.snapshotDigest === input.snapshotDigest) {
				return { status: "approved", targetReference: draft.targetReference, createdIssueReferences: draft.createdIssueReferences };
			}
			if (draft.snapshotDigest !== input.snapshotDigest || draft.status === "superseded") {
				return { status: "stale", draft: draft.status === "approved" ? draft : await readDraft(sql`target_id = ${draft.targetId}::uuid AND status = 'active'`) };
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
				const created = await createEntity(executor, { kind: "issue", title: issue.title, parentId, body: formatIssueBody(issue) }, this.projectIdentity, actorId);
				issueIds.set(issue.key, created.id);
				createdIssueReferences.push(created.reference);
			}
			const planEntryStore = new PgPlanEntryStore(executor);
			for (const issue of draft.issues) {
				for (const entryId of issue.planEntryIds ?? []) {
					await planEntryStore.linkPlanEntryEntity({ entryId, targetId: issueIds.get(issue.key)! }, actorId);
				}
			}
			for (const issue of draft.issues) {
				for (const relation of issue.relationReferences) {
					const targetId = relation.targetKey ? issueIds.get(relation.targetKey) : relation.targetId ?? relation.targetReference;
					if (!targetId) {
						throw new Error(`Issue-breakdown draft contains an unresolved relation target for ${issue.key}`);
					}
					await linkEntities(executor, { fromId: issueIds.get(issue.key)!, relationType: relation.relationType, toId: targetId }, actorId);
				}
			}

			const approvedAt = new Date().toISOString();
			await executor.execute(sql`UPDATE issue_breakdown_drafts
				SET status = 'approved', approved_at = ${approvedAt}, created_issue_references = ${JSON.stringify(createdIssueReferences)}, updated_at = ${approvedAt}
				WHERE tenant_id = ${executor.tenantId} AND id = ${draft.id}::uuid`);
			return { status: "approved", targetReference: draft.targetReference, createdIssueReferences };
		});
	}

	public async createPlanEntry(input: Parameters<StorageDriver["createPlanEntry"]>[0]) {
		return this.mutation((executor, actorId) => new PgPlanEntryStore(executor).createPlanEntry(input, actorId));
	}

	public async getPlanEntry(input: Parameters<StorageDriver["getPlanEntry"]>[0]) {
		return this.transaction((executor) => new PgPlanEntryStore(executor).getPlanEntry(input));
	}

	public async updatePlanEntry(input: Parameters<StorageDriver["updatePlanEntry"]>[0]) {
		return this.mutation((executor, actorId) => new PgPlanEntryStore(executor).updatePlanEntry(input, actorId));
	}

	public async deletePlanEntry(input: Parameters<StorageDriver["deletePlanEntry"]>[0]) {
		return this.mutation((executor, actorId) => new PgPlanEntryStore(executor).deletePlanEntry(input, actorId));
	}

	public async linkPlanEntryEntity(input: Parameters<StorageDriver["linkPlanEntryEntity"]>[0]) {
		return this.mutation((executor, actorId) => new PgPlanEntryStore(executor).linkPlanEntryEntity(input, actorId));
	}

	public async unlinkPlanEntryEntity(input: Parameters<StorageDriver["unlinkPlanEntryEntity"]>[0]) {
		return this.mutation((executor, actorId) => new PgPlanEntryStore(executor).unlinkPlanEntryEntity(input, actorId));
	}

	public async listPlanEntries(input: Parameters<StorageDriver["listPlanEntries"]>[0]) {
		return this.transaction((executor) => new PgPlanEntryStore(executor).listPlanEntries(input));
	}

	public async listPlanEntryPage(input: Parameters<StorageDriver["listPlanEntryPage"]>[0]) {
		return this.transaction((executor) => new PgPlanEntryStore(executor).listPlanEntryPage(input));
	}

	public async listPlanEntryHistory(input: Parameters<StorageDriver["listPlanEntryHistory"]>[0]) {
		return this.transaction((executor) => new PgPlanEntryStore(executor).listPlanEntryHistory(input));
	}

	public async listAllRelations(): Promise<RelationRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listAllRelations());
	}

	public async applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return this.transaction(async (executor) => {
			for (const relation of relations) {
				await this.assertSelectedProjectEntity(executor, relation.fromId);
				await this.assertSelectedProjectEntity(executor, relation.toId);
			}
			return new PgEntityStore(executor, this.projectIdentity).applyRelations(relations);
		});
	}

	public async linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.fromId);
			await this.assertSelectedProjectEntity(executor, input.toId);
			return new PgEntityStore(executor, this.projectIdentity).linkEntities(input, actorId);
		});
	}

	public async unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return this.mutation(async (executor) => {
			await this.assertSelectedProjectEntity(executor, input.fromId);
			await this.assertSelectedProjectEntity(executor, input.toId);
			return new PgEntityStore(executor, this.projectIdentity).unlinkEntities(input);
		});
	}

	public async updateEntityStatus(input: Parameters<StorageDriver["updateEntityStatus"]>[0]): Promise<StatusUpdateResult> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			return new PgEntityStore(executor, this.projectIdentity).updateEntityStatus(input, actorId);
		});
	}

	public async updateEntity(input: { entityId: string; title?: string; body?: string; bodySource?: BodySource; category?: string; priority?: string; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			return new PgEntityStore(executor, this.projectIdentity).updateEntity(input, actorId);
		});
	}

	public async setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			return new PgEntityStore(executor, this.projectIdentity).setEntityBody(input, actorId);
		});
	}

	public async materializeEntityRevision(input: { entityId: string; revision: number }) {
		const result = await this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).materializeEntityRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("entity", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId, true);
			return new PgEntityStore(executor, this.projectIdentity).restoreEntityRevision(input, actorId);
		});
		await this.historyDiagnosticsStore.recordMaterialization("entity", input.expectedRevision, input.revision);
		return result;
	}

	public async archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			return new PgEntityStore(executor, this.projectIdentity).archiveEntity(input, actorId);
		});
	}

	public async moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			await this.assertSelectedProjectEntity(executor, input.newParentId);
			return new PgEntityStore(executor, this.projectIdentity).moveEntity(input, actorId);
		});
	}

	public async deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return this.mutation(async (executor, actorId) => {
			await this.assertSelectedProjectEntity(executor, input.entityId);
			return new PgEntityStore(executor, this.projectIdentity).deleteEntity(input, actorId);
		});
	}

	public async listOrphans(kind?: string): Promise<EntityRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listOrphans(kind));
	}

	public async listProjectAdrs(): Promise<EntityRecord[]> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).listProjectAdrs());
	}

	public async getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getInitiativeBundle(initiativeId));
	}

	public async getInitiativeDetail(input: { initiativeId: string }): Promise<InitiativeDetail> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getInitiativeDetail(input));
	}

	public async getInitiativeTab(input: { initiativeId: string; tab: InitiativeTab }): Promise<InitiativeTabData> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getInitiativeTab(input));
	}

	public async getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public async getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public async getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		if (input) {
			return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getDatabaseSnapshot(input));
		}

		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getDatabaseSnapshot());
	}

	public async getProjectSummary(input: { projectId: string }): Promise<ProjectSummary> {
		return this.transaction((executor) => new PgEntityStore(executor, this.projectIdentity).getProjectSummary(input));
	}

	public async getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return this.tenantWideTransaction((executor) => new PgEntityStore(executor, this.projectIdentity).getProjectDiscovery(input));
	}

	public async getSnapshotSignature(): Promise<string> {
		return this.tenantWideTransaction((executor) => new PgEntityStore(executor, this.projectIdentity).getSnapshotSignature());
	}

	public async listContexts(): Promise<ContextListResult> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).listContexts());
	}

	public async getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).getContextDetails(input));
	}

	public async getContextDirectory(): Promise<ContextDirectory> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).getContextDirectory());
	}

	public async queryContextDirectory(input: QueryContextDirectoryInput = {}): Promise<QueryContextDirectoryResult> {
		return this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).queryContextDirectory(input));
	}

	public async upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextWriteResult> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).upsertContext(input, actorId));
	}

	public async defineContextTerm(input: {
		scopeRef?: string;
		term: string;
		definition: string;
		avoid?: string[];
		author?: string;
		expectedRevision?: number;
		expectedContentHash?: string;
	}): Promise<DefineContextTermAcknowledgement> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).defineContextTerm(input, actorId));
	}

	public async forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).forgetContextTerm(input, actorId));
	}

	public async materializeContextRevision(input: { scopeRef?: string; revision: number }) {
		const result = await this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).materializeContextRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("context", result.headRevision, result.targetRevision);
		return result;
	}

	public async materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }) {
		const result = await this.transaction((executor) => new PgContextStore(executor, this.projectIdentity).materializeContextTermRevision(input));
		await this.historyDiagnosticsStore.recordMaterialization("context-term", result.headRevision, result.targetRevision);
		return result;
	}

	public async restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).restoreContextRevision(input, actorId));
		await this.historyDiagnosticsStore.recordMaterialization("context", input.expectedRevision, input.revision);
		return result;
	}

	public async restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }) {
		const result = await this.mutation((executor, actorId) => new PgContextStore(executor, this.projectIdentity).restoreContextTermRevision(input, actorId));
		await this.historyDiagnosticsStore.recordMaterialization("context-term", input.expectedRevision, input.revision);
		return result;
	}

	public async listTenants(): Promise<TenantSummary[]> {
		return this.tenantWideTransaction((executor) => listTenants(executor, this.tenantId));
	}

	public async deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return this.tenantWideMutation((executor) => deleteTenant(executor, this.tenantId, tenantId));
	}

	public async renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return this.tenantWideMutation((executor) => renameTenant(executor, this.tenantId, previousTenantId, newTenantId));
	}

	public async close(): Promise<void> {
		await this.pool.end();
	}

	protected async assertSelectedProjectEntity(executor: TenantExecutor, entityId: string, includeTombstone = false): Promise<void> {
		if (!this.strictProjectScope) {
			return;
		}

		if (!await findProjectEntity(executor, entityId, includeTombstone)) {
			throw new Error(`Entity not found: ${entityId}`);
		}
	}

	protected async assertCurrentProjectEntity(executor: TenantExecutor, entityId: string, includeTombstone = false): Promise<void> {
		if (!await findProjectEntity(executor, entityId, includeTombstone)) {
			throw new Error(`Entity not found: ${entityId}`);
		}
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

async function validateReferencedIssueIds(executor: TenantExecutor, referencedIssueIds: string[]): Promise<string[]> {
	const deduplicated = [...new Set(referencedIssueIds)];
	for (const referencedIssueId of deduplicated) {
		await getProjectIssueOrThrow(executor, referencedIssueId);
	}
	return deduplicated;
}

async function getProjectIssueOrThrow(executor: TenantExecutor, issueId: string): Promise<{ id: string }> {
	const issue = await findProjectIssue(executor, issueId);
	if (!issue) {
		throw new Error(`Entity not found: ${issueId}`);
	}
	return issue;
}

async function findProjectIssue(executor: TenantExecutor, issueId: string): Promise<{ id: string } | undefined> {
	const result = await executor.execute(sql`
		SELECT entities.id::text AS id
		FROM entities
		WHERE entities.tenant_id = ${executor.tenantId}
			AND entities.project_id = ${executor.currentProjectId}
			AND entities.kind = 'issue'
			AND entities.tombstone = false
			AND (entities.id::text = ${issueId} OR entities.reference = ${issueId})
	`);
	return result.rows[0] as { id: string } | undefined;
}

async function findProjectEntity(executor: TenantExecutor, entityId: string, includeTombstone: boolean): Promise<{ id: string } | undefined> {
	const result = await executor.execute(sql`
		SELECT entities.id::text AS id
		FROM entities
		WHERE entities.tenant_id = ${executor.tenantId}
			AND entities.project_id = ${executor.currentProjectId}
			${includeTombstone ? sql`` : sql`AND entities.tombstone = false`}
			AND (entities.id::text = ${entityId} OR entities.reference = ${entityId})
	`);
	return result.rows[0] as { id: string } | undefined;
}

async function findCurrentProject(executor: TenantExecutor): Promise<{ title: string; reference: string } | undefined> {
	const result = await executor.execute(sql`
		SELECT title, reference
		FROM entities
		WHERE tenant_id = ${executor.tenantId}
			AND id = ${executor.currentProjectId}::uuid
			AND kind = 'project'
			AND tombstone = false
	`);
	return result.rows[0] as { title: string; reference: string } | undefined;
}

async function findProjectIssueComment(executor: TenantExecutor, commentId: string): Promise<{ id: string } | undefined> {
	const result = await executor.execute(sql`
		SELECT issue_comments.id::text AS id
		FROM issue_comments
		JOIN entities AS issue ON issue.tenant_id = issue_comments.tenant_id AND issue.id = issue_comments.issue_id
		WHERE issue_comments.tenant_id = ${executor.tenantId}
			AND issue.project_id = ${executor.currentProjectId}
			AND (issue_comments.id::text = ${commentId} OR issue_comments.reference = ${commentId})
	`);
	return result.rows[0] as { id: string } | undefined;
}

function toIssueCommentRecord(head: CanonicalIssueCommentChain["head"]): IssueCommentRecord {
	return {
		id: head.id,
		reference: head.reference,
		shortReference: shortEntityReference({ id: head.id, kind: "issueComment", shortReference: head.shortReference }),
		issueId: head.issueId,
		createdBy: head.createdBy,
		updatedBy: head.updatedBy,
		...(!head.tombstone && { body: head.body }),
		referencedIssueIds: head.referencedIssueIds,
		tombstone: head.tombstone,
		revision: head.revision,
		contentHash: head.contentHash,
		createdAt: head.createdAt,
		updatedAt: head.updatedAt
	};
}

function encodeCommentCursor(comment: Pick<IssueCommentRecord, "createdAt" | "reference">): string {
	return Buffer.from(JSON.stringify({ createdAt: comment.createdAt, reference: comment.reference })).toString("base64url");
}

function decodeCommentCursor(value: string): { createdAt: string; reference: string } {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; reference?: unknown };
		if (typeof cursor.createdAt !== "string" || typeof cursor.reference !== "string") throw new Error();
		return { createdAt: cursor.createdAt, reference: cursor.reference };
	} catch {
		throw new Error("Invalid issue comment cursor.");
	}
}

export function openPgStore(pool: Pool, tenantId: string): PgStore {
	return new PgStore(pool, tenantId);
}
