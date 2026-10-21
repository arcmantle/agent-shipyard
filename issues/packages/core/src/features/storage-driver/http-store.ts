import { randomUUID } from "node:crypto";

import type {
	ContextDetails,
	ContextDirectory,
	ContextListResult,
	DefineContextTermResult,
	ForgetContextTermResult,
	MaterializedContextRevision,
	MaterializedContextTermRevision,
	ContextRevisionErrorReason,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "../context/context-types.js";
import type { DeleteTenantResult, RenameTenantResult, TenantSummary } from "../entity-store/tenant-types.js";
import type { BodySource, EntityRecord, EntitySummary, HistoryEntryRecord, MaterializedEntityRevision, RelationRecord } from "../entity-store/domain.js";
import { EntityConflictError, EntityRevisionError, type EntityRevisionErrorReason } from "../entity-store/domain.js";
import { ContextConflictError, ContextRevisionError, ContextTermConflictError } from "../context/context-types.js";
import { IssueCommentConflictError } from "./issue-comment-store.js";
import { PlanEntryConflictError } from "../plan-entry/plan-entry-types.js";
import type { StorageDriver } from "./storage-driver.js";
import { InstructionFragmentError, InstructionResetAllError, InstructionWriteError, type InstructionResetAllInspection, type InstructionSourceResult, type RetrieveInstructionInput, type RetrievedInstruction } from "./instruction-store.js";
import type { SearchCapability, SearchDiagnostic, SearchRequest, SearchResponse } from "./search-store.js";
import type { ProspectorProjectSettings } from "../project-settings/prospector-settings.js";
import type { AuthIdentity } from "../../auth/auth-provider.js";
import type { HistoryDiagnostics } from "./history-diagnostics.js";
import {
	decodeCanonicalChainBundle,
	encodeCanonicalChainBundle,
	CompletionObservationConflictError,
	SynchronizeConflictError,
	type CanonicalChainBundle,
	type CanonicalChainImportResult,
	type SynchronizeRecordKind
} from "../synchronize/canonical-chain.js";
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
	StatusUpdateResult,
	UnlinkResult
} from "../entity-store/store-types.js";

function isInstructionWriteErrorData(data: unknown): data is { reason: InstructionWriteError["reason"]; currentSource: InstructionSourceResult } {
	if (!data || typeof data !== "object" || !("instructionWriteError" in data) || data.instructionWriteError !== true
		|| !("reason" in data) || !["revision-conflict", "invalid-source"].includes(String(data.reason))
		|| !("currentSource" in data) || !data.currentSource || typeof data.currentSource !== "object") return false;
	const current = data.currentSource;
	return "key" in current && typeof current.key === "string"
		&& "body" in current && typeof current.body === "string"
		&& "version" in current && typeof current.version === "string"
		&& "kind" in current && ["agent", "skill", "fragment"].includes(String(current.kind))
		&& "source" in current && !!current.source && typeof current.source === "object"
		&& "revision" in current.source && typeof current.source.revision === "number";
}

function isInstructionFragmentErrorData(data: unknown): data is { reason: InstructionFragmentError["reason"]; currentSource?: InstructionSourceResult; affectedReferences: string[] } {
	return !!data && typeof data === "object" && "instructionFragmentError" in data && data.instructionFragmentError === true
		&& "reason" in data && ["invalid-source", "revision-conflict", "referenced", "already-exists", "not-personal"].includes(String(data.reason))
		&& "affectedReferences" in data && Array.isArray(data.affectedReferences) && data.affectedReferences.every((key) => typeof key === "string");
}

function isInstructionResetAllErrorData(data: unknown): data is { reason: InstructionResetAllError["reason"]; currentInspection?: InstructionResetAllInspection } {
	return !!data && typeof data === "object" && "instructionResetAllError" in data && data.instructionResetAllError === true
		&& "reason" in data && ["invalid-source", "revision-conflict"].includes(String(data.reason));
}

export type HttpStoreOptions = {
	/** Cloud API base URL, no trailing slash required (e.g. `https://api.example.com`). */
	baseUrl: string;
	/** Bearer token attached to every request. `HttpStore` neither resolves nor refreshes it - the caller (backend selection/CLI seam) owns that. */
	bearerToken: string;
	/**
	 * Resolves a server-issued bearer token for an alternate trusted identity.
	 * Without it, `HttpStore` cannot safely impersonate another user because
	 * the gate must derive identity only from the bearer credential.
	 */
	identityBearerToken?: (identity: AuthIdentity) => string | undefined;
	tenantId: string;
	/**
	 * This process's own build-content-hash (ADR45, ISS188), sent as a
	 * header on every request so the local daemon can detect a stale
	 * connection. Only meaningful against the local daemon - cloud mode
	 * omits it entirely, since the cloud gate has no build-hash concept.
	 */
	buildHash?: string;
	/**
	 * This request's desired db path (ISS190), sent as a header on every
	 * request so the local daemon can detect it's fronting the wrong
	 * database and drain-then-respawn against the requested one instead.
	 * Only meaningful against the local daemon - cloud mode omits it
	 * entirely, since the cloud gate has no local db-path concept.
	 */
	dbPath?: string;
	/**
	 * This request's resolved project identity (ISS183), sent as a header so
	 * both cloud and local gates can scope requests to this project's own
	 * entities and shared glossary.
	 */
	projectIdentity?: string;
	/**
	 * This request's workspace root (ISS166 follow-up), sent as a header so
	 * the local daemon - which fronts one shared database for every
	 * workspace on the machine and cannot trust its own long-lived process
	 * cwd. Retained for database-location compatibility; project selection is
	 * driven by `projectIdentity`.
	 */
	workspaceRoot?: string;
	/** Correlates a write with the initiating browser cache update. */
	correlationId?: string;
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
};

const BUILD_HASH_HEADER = "x-agent-issues-build-hash";
const DB_PATH_HEADER = "x-agent-issues-db-path";
const PROJECT_IDENTITY_HEADER = "x-agent-issues-project-identity";
const CORRELATION_ID_HEADER = "x-agent-issues-correlation-id";
const WORKSPACE_ROOT_HEADER = "x-agent-issues-workspace-root";

type JsonRpcSuccessResponse = { jsonrpc: "2.0"; id: string; result: unknown };
type JsonRpcErrorData = { entityId: string; currentRevision: number; currentContentHash: string };
type JsonRpcIssueCommentConflictData = { commentId: string; currentRevision: number; currentContentHash: string };
type JsonRpcPlanEntryConflictData = { entryId: string; currentRevision: number; currentContentHash: string };
type JsonRpcContextConflictData = { contextKey: string; currentRevision: number; currentContentHash: string };
type JsonRpcContextTermConflictData = JsonRpcContextConflictData & { term: string };
type JsonRpcRevisionErrorData = { entityId: string; reason: EntityRevisionErrorReason; headRevision?: number };
type JsonRpcContextRevisionErrorData = { contextKey: string; term?: string; reason: ContextRevisionErrorReason; headRevision?: number };
type JsonRpcSynchronizeConflictData = { recordKind: SynchronizeRecordKind; recordId: string; currentRevision: number; currentContentHash: string };
type JsonRpcCompletionObservationConflictData = { observationId: string };
type JsonRpcErrorResponse = { jsonrpc: "2.0"; id: string; error: { code: number; message: string; data?: unknown } };
type VersionMismatchResponseBody = { code: "daemon-version-mismatch"; expectedBuildHash: string; receivedBuildHash?: string };
type DbPathMismatchResponseBody = { code: "daemon-db-mismatch"; expectedDbPath: string; receivedDbPath?: string };

/**
 * Common base for every "this daemon instance is incompatible with what the
 * client wants, drain it and spawn a fresh one" rejection (ISS188's
 * build-hash mismatch, ISS190's db-path mismatch) - lets the daemon-lifecycle
 * retry orchestrator (`callDaemonWithVersionHandshakeRetry`) catch both
 * reasons with a single `instanceof` check instead of enumerating them.
 */
export abstract class DaemonHandshakeMismatchError extends Error {}

/**
 * Thrown when the local daemon rejects a request for a build-hash mismatch
 * (ADR45, ISS188) - distinct from `HttpStore`'s generic HTTP-failure `Error`
 * so a caller (the daemon-lifecycle retry orchestrator, ISS190) can tell
 * "the daemon is stale, respawn and retry" apart from any other failure.
 */
export class DaemonVersionMismatchError extends DaemonHandshakeMismatchError {
	public readonly expectedBuildHash: string;
	public readonly receivedBuildHash: string | undefined;

	public constructor(expectedBuildHash: string, receivedBuildHash: string | undefined) {
		super(`Daemon build-hash mismatch: expected "${expectedBuildHash}", received "${receivedBuildHash ?? "(none)"}".`);
		this.name = "DaemonVersionMismatchError";
		this.expectedBuildHash = expectedBuildHash;
		this.receivedBuildHash = receivedBuildHash;
	}
}

/**
 * Thrown when the local daemon rejects a request because it's fronting a
 * different database than the one the client requested via `--db` (ISS190):
 * the daemon-lifecycle retry orchestrator drains the mismatched daemon and
 * spawns a fresh one bound to the requested db, then retries once.
 */
export class DaemonDbPathMismatchError extends DaemonHandshakeMismatchError {
	public readonly expectedDbPath: string;
	public readonly receivedDbPath: string | undefined;

	public constructor(expectedDbPath: string, receivedDbPath: string | undefined) {
		super(`Daemon db-path mismatch: expected "${expectedDbPath}", received "${receivedDbPath ?? "(none)"}".`);
		this.name = "DaemonDbPathMismatchError";
		this.expectedDbPath = expectedDbPath;
		this.receivedDbPath = receivedDbPath;
	}
}

function isVersionMismatchBody(body: unknown): body is VersionMismatchResponseBody {
	return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "daemon-version-mismatch";
}

function isDbPathMismatchBody(body: unknown): body is DbPathMismatchResponseBody {
	return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "daemon-db-mismatch";
}

function isEntityConflictData(data: unknown): data is JsonRpcErrorData {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcErrorData).entityId === "string" &&
		typeof (data as JsonRpcErrorData).currentRevision === "number" &&
		typeof (data as JsonRpcErrorData).currentContentHash === "string"
	);
}

function isSynchronizeConflictData(data: unknown): data is JsonRpcSynchronizeConflictData {
	const validRecordKinds: SynchronizeRecordKind[] = ["entity", "context", "context-term", "issue-comment", "plan-entry"];
	return (
		typeof data === "object" &&
		data !== null &&
		validRecordKinds.includes((data as JsonRpcSynchronizeConflictData).recordKind) &&
		typeof (data as JsonRpcSynchronizeConflictData).recordId === "string" &&
		typeof (data as JsonRpcSynchronizeConflictData).currentRevision === "number" &&
		typeof (data as JsonRpcSynchronizeConflictData).currentContentHash === "string"
	);
}

function isCompletionObservationConflictData(data: unknown): data is JsonRpcCompletionObservationConflictData {
	return typeof data === "object" && data !== null && typeof (data as JsonRpcCompletionObservationConflictData).observationId === "string";
}

function isIssueCommentConflictData(data: unknown): data is JsonRpcIssueCommentConflictData {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcIssueCommentConflictData).commentId === "string" &&
		typeof (data as JsonRpcIssueCommentConflictData).currentRevision === "number" &&
		typeof (data as JsonRpcIssueCommentConflictData).currentContentHash === "string"
	);
}

function isPlanEntryConflictData(data: unknown): data is JsonRpcPlanEntryConflictData {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcPlanEntryConflictData).entryId === "string" &&
		typeof (data as JsonRpcPlanEntryConflictData).currentRevision === "number" &&
		typeof (data as JsonRpcPlanEntryConflictData).currentContentHash === "string"
	);
}

function isContextConflictData(data: unknown): data is JsonRpcContextConflictData {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcContextConflictData).contextKey === "string" &&
		typeof (data as JsonRpcContextConflictData).currentRevision === "number" &&
		typeof (data as JsonRpcContextConflictData).currentContentHash === "string"
	);
}

function isContextTermConflictData(data: unknown): data is JsonRpcContextTermConflictData {
	return isContextConflictData(data) && typeof (data as JsonRpcContextTermConflictData).term === "string";
}

function isEntityRevisionErrorData(data: unknown): data is JsonRpcRevisionErrorData {
	const VALID_REASONS: EntityRevisionErrorReason[] = ["entity-not-found", "revision-out-of-range", "broken-chain"];
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcRevisionErrorData).entityId === "string" &&
		VALID_REASONS.includes((data as JsonRpcRevisionErrorData).reason)
	);
}

function isContextRevisionErrorData(data: unknown): data is JsonRpcContextRevisionErrorData {
	const validReasons: ContextRevisionErrorReason[] = ["context-not-found", "term-not-found", "revision-out-of-range", "broken-chain"];
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as JsonRpcContextRevisionErrorData).contextKey === "string" &&
		validReasons.includes((data as JsonRpcContextRevisionErrorData).reason)
	);
}

/**
 * The cloud-mode implementation of the storage-driver seam (ADR13, ADR14):
 * turns every `StorageDriver` operation into a single JSON-RPC call to the
 * cloud API's `/rpc` endpoint (ISS49-ISS52). A JSON-RPC error response
 * surfaces as a thrown `Error` carrying the gate's message, matching
 * `SqliteStore`/`PgStore`'s existing throw-based contract so command code
 * never branches on which backend it holds. `HttpStore` holds no persistent
 * network connection to release, but still honors the seam's close-then-reject
 * contract (`storage-driver-contract.ts`) by refusing any call made after
 * `close()`.
 */
export class HttpStore implements StorageDriver {
	public constructor(options: HttpStoreOptions) {
		this.options = options;
		this.closed = false;
	}

	protected options: HttpStoreOptions;
	protected closed: boolean;

	public get tenantId(): string {
		return this.options.tenantId;
	}

	public withAuthenticatedIdentity(identity: AuthIdentity): StorageDriver {
		const bearerToken = this.options.identityBearerToken?.(identity);
		if (!bearerToken) {
			throw new Error("HttpStore requires a trusted bearer-token resolver to switch authenticated identity.");
		}

		return new HttpStore({ ...this.options, bearerToken });
	}

	public async exportCanonicalChains(): Promise<CanonicalChainBundle> {
		return decodeCanonicalChainBundle(await this.call("exportCanonicalChains"));
	}

	public importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult> {
		return this.call("importCanonicalChains", { bundle: encodeCanonicalChainBundle(bundle) });
	}

	public upsertUser(input: Parameters<StorageDriver["upsertUser"]>[0]): ReturnType<StorageDriver["upsertUser"]> {
		return this.call("upsertUser", input);
	}

	public listUsers(): ReturnType<StorageDriver["listUsers"]> {
		return this.call("listUsers");
	}

	public getHistoryDiagnostics(): Promise<HistoryDiagnostics> {
		return this.call("getHistoryDiagnostics");
	}

	public getProspectorSettings(): Promise<ProspectorProjectSettings> {
		return this.call("getProspectorSettings");
	}

	public setProspectorSettings(settings: ProspectorProjectSettings): Promise<ProspectorProjectSettings> {
		return this.call("setProspectorSettings", settings);
	}

	public retrieveInstruction(input: RetrieveInstructionInput): Promise<RetrievedInstruction> {
		return this.call("retrieveInstruction", input);
	}

	public previewInstruction(input: Parameters<StorageDriver["previewInstruction"]>[0]): ReturnType<StorageDriver["previewInstruction"]> {
		return this.call("previewInstruction", input);
	}

	public listInstructionSources(input: Parameters<StorageDriver["listInstructionSources"]>[0]): ReturnType<StorageDriver["listInstructionSources"]> {
		return this.call("listInstructionSources", input);
	}

	public readInstructionSource(input: Parameters<StorageDriver["readInstructionSource"]>[0]): ReturnType<StorageDriver["readInstructionSource"]> {
		return this.call("readInstructionSource", input);
	}

	public compareInstructionSource(input: Parameters<StorageDriver["compareInstructionSource"]>[0]): ReturnType<StorageDriver["compareInstructionSource"]> {
		return this.call("compareInstructionSource", input);
	}

	public inspectInstructionDependencies(input: Parameters<StorageDriver["inspectInstructionDependencies"]>[0]): ReturnType<StorageDriver["inspectInstructionDependencies"]> {
		return this.call("inspectInstructionDependencies", input);
	}

	public saveInstructionSource(input: Parameters<StorageDriver["saveInstructionSource"]>[0]): ReturnType<StorageDriver["saveInstructionSource"]> {
		return this.call("saveInstructionSource", input);
	}

	public listInstructionHistory(input: Parameters<StorageDriver["listInstructionHistory"]>[0]): ReturnType<StorageDriver["listInstructionHistory"]> {
		return this.call("listInstructionHistory", input);
	}

	public readInstructionRevision(input: Parameters<StorageDriver["readInstructionRevision"]>[0]): ReturnType<StorageDriver["readInstructionRevision"]> {
		return this.call("readInstructionRevision", input);
	}

	public restoreInstructionRevision(input: Parameters<StorageDriver["restoreInstructionRevision"]>[0]): ReturnType<StorageDriver["restoreInstructionRevision"]> {
		return this.call("restoreInstructionRevision", input);
	}

	public resetInstructionSource(input: Parameters<StorageDriver["resetInstructionSource"]>[0]): ReturnType<StorageDriver["resetInstructionSource"]> {
		return this.call("resetInstructionSource", input);
	}

	public inspectInstructionReset(input: Parameters<StorageDriver["inspectInstructionReset"]>[0]): ReturnType<StorageDriver["inspectInstructionReset"]> {
		return this.call("inspectInstructionReset", input);
	}

	public inspectInstructionResetAll(input: Parameters<StorageDriver["inspectInstructionResetAll"]>[0]): ReturnType<StorageDriver["inspectInstructionResetAll"]> {
		return this.call("inspectInstructionResetAll", input);
	}

	public resetInstructionAll(input: Parameters<StorageDriver["resetInstructionAll"]>[0]): ReturnType<StorageDriver["resetInstructionAll"]> {
		return this.call("resetInstructionAll", input);
	}

	public commitInstructionChanges(input: Parameters<StorageDriver["commitInstructionChanges"]>[0]): ReturnType<StorageDriver["commitInstructionChanges"]> {
		return this.call("commitInstructionChanges", input);
	}

	public createInstructionFragment(input: Parameters<StorageDriver["createInstructionFragment"]>[0]): ReturnType<StorageDriver["createInstructionFragment"]> {
		return this.call("createInstructionFragment", input);
	}

	public removeInstructionFragment(input: Parameters<StorageDriver["removeInstructionFragment"]>[0]): ReturnType<StorageDriver["removeInstructionFragment"]> {
		return this.call("removeInstructionFragment", input);
	}

	public getSearchCapability(): Promise<SearchCapability> {
		return this.call("getSearchCapability");
	}

	public getSearchDiagnostics(): Promise<SearchDiagnostic[]> {
		return this.call("getSearchDiagnostics");
	}

	public search(input: SearchRequest): Promise<SearchResponse> {
		return this.call("search", input);
	}

	protected async call<T>(method: string, params?: unknown): Promise<T> {
		if (this.closed) {
			throw new Error("HttpStore is closed; open a new store instead of reusing a closed one.");
		}

		const fetchImpl = this.options.fetchImpl ?? fetch;
		const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.options.bearerToken}` };
		if (this.options.buildHash !== undefined) {
			headers[BUILD_HASH_HEADER] = this.options.buildHash;
		}
		if (this.options.dbPath !== undefined) {
			headers[DB_PATH_HEADER] = this.options.dbPath;
		}
		if (this.options.projectIdentity !== undefined) {
			headers[PROJECT_IDENTITY_HEADER] = this.options.projectIdentity;
		}
		if (this.options.correlationId !== undefined) {
			headers[CORRELATION_ID_HEADER] = this.options.correlationId;
		}
		if (this.options.workspaceRoot !== undefined) {
			headers[WORKSPACE_ROOT_HEADER] = this.options.workspaceRoot;
		}

		const response = await fetchImpl(`${this.options.baseUrl}/rpc`, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params })
		});

		if (response.status === 409) {
			const body: unknown = await response.json().catch(() => undefined);
			if (isVersionMismatchBody(body)) {
				throw new DaemonVersionMismatchError(body.expectedBuildHash, body.receivedBuildHash);
			}
			if (isDbPathMismatchBody(body)) {
				throw new DaemonDbPathMismatchError(body.expectedDbPath, body.receivedDbPath);
			}
		}

		if (!response.ok) {
			throw new Error(`HttpStore request to ${method} failed with HTTP ${response.status}.`);
		}

		const body = (await response.json()) as JsonRpcSuccessResponse | JsonRpcErrorResponse;
		if ("error" in body) {
			const { message, data } = body.error;
			if (isInstructionResetAllErrorData(data)) {
				throw new InstructionResetAllError(data.reason, message, data.currentInspection);
			}
			if (isInstructionFragmentErrorData(data)) {
				throw new InstructionFragmentError(data.reason, message, data.currentSource, data.affectedReferences);
			}
			if (isInstructionWriteErrorData(data)) {
				throw new InstructionWriteError(data.reason, data.currentSource, message);
			}
			if (isCompletionObservationConflictData(data)) {
				throw new CompletionObservationConflictError(data.observationId);
			}
			if (isSynchronizeConflictData(data)) {
				throw new SynchronizeConflictError(data.recordKind, data.recordId, data.currentRevision, data.currentContentHash);
			}
			if (isEntityConflictData(data)) {
				throw new EntityConflictError(data.entityId, data.currentRevision, data.currentContentHash);
			}
			if (isIssueCommentConflictData(data)) {
				throw new IssueCommentConflictError(data.commentId, data.currentRevision, data.currentContentHash);
			}
			if (isPlanEntryConflictData(data)) {
				throw new PlanEntryConflictError(data.entryId, data.currentRevision, data.currentContentHash);
			}
			if (isEntityRevisionErrorData(data)) {
				throw new EntityRevisionError(data.entityId, data.reason, message, data.headRevision);
			}
			if (isContextRevisionErrorData(data)) {
				throw new ContextRevisionError(data.contextKey, data.reason, message, data.headRevision, data.term);
			}
			if (isContextTermConflictData(data)) {
				throw new ContextTermConflictError(data.contextKey, data.term, data.currentRevision, data.currentContentHash);
			}
			if (isContextConflictData(data)) {
				throw new ContextConflictError(data.contextKey, data.currentRevision, data.currentContentHash);
			}
			throw new Error(message);
		}

		return body.result as T;
	}

	// Entities
	public createEntity(input: Parameters<StorageDriver["createEntity"]>[0]): ReturnType<StorageDriver["createEntity"]> {
		return this.call("createEntity", input);
	}

	public createIssueComment(input: Parameters<StorageDriver["createIssueComment"]>[0]): ReturnType<StorageDriver["createIssueComment"]> {
		return this.call("createIssueComment", input);
	}

	public updateIssueComment(input: Parameters<StorageDriver["updateIssueComment"]>[0]): ReturnType<StorageDriver["updateIssueComment"]> {
		return this.call("updateIssueComment", input);
	}

	public deleteIssueComment(input: Parameters<StorageDriver["deleteIssueComment"]>[0]): ReturnType<StorageDriver["deleteIssueComment"]> {
		return this.call("deleteIssueComment", input);
	}

	public listIssueComments(input: Parameters<StorageDriver["listIssueComments"]>[0]): ReturnType<StorageDriver["listIssueComments"]> {
		return this.call("listIssueComments", input);
	}

	public listIssueCommentHistory(input: Parameters<StorageDriver["listIssueCommentHistory"]>[0]): ReturnType<StorageDriver["listIssueCommentHistory"]> {
		return this.call("listIssueCommentHistory", input);
	}

	public createPlanEntry(input: Parameters<StorageDriver["createPlanEntry"]>[0]): ReturnType<StorageDriver["createPlanEntry"]> {
		return this.call("createPlanEntry", input);
	}

	public confirmPlan(input: Parameters<StorageDriver["confirmPlan"]>[0]): ReturnType<StorageDriver["confirmPlan"]> {
		return this.call("confirmPlan", input);
	}

	public createIssueBreakdownDraft(input: Parameters<StorageDriver["createIssueBreakdownDraft"]>[0]): ReturnType<StorageDriver["createIssueBreakdownDraft"]> {
		return this.call("createIssueBreakdownDraft", input);
	}

	public getIssueBreakdownDraft(input: Parameters<StorageDriver["getIssueBreakdownDraft"]>[0]): ReturnType<StorageDriver["getIssueBreakdownDraft"]> {
		return this.call("getIssueBreakdownDraft", input);
	}

	public getLatestIssueBreakdownDraft(input: Parameters<StorageDriver["getLatestIssueBreakdownDraft"]>[0]): ReturnType<StorageDriver["getLatestIssueBreakdownDraft"]> {
		return this.call("getLatestIssueBreakdownDraft", input);
	}

	public approveIssueBreakdownDraft(input: Parameters<StorageDriver["approveIssueBreakdownDraft"]>[0]): ReturnType<StorageDriver["approveIssueBreakdownDraft"]> {
		return this.call("approveIssueBreakdownDraft", input);
	}

	public getPlanEntry(input: Parameters<StorageDriver["getPlanEntry"]>[0]): ReturnType<StorageDriver["getPlanEntry"]> {
		return this.call("getPlanEntry", input);
	}

	public updatePlanEntry(input: Parameters<StorageDriver["updatePlanEntry"]>[0]): ReturnType<StorageDriver["updatePlanEntry"]> {
		return this.call("updatePlanEntry", input);
	}

	public deletePlanEntry(input: Parameters<StorageDriver["deletePlanEntry"]>[0]): ReturnType<StorageDriver["deletePlanEntry"]> {
		return this.call("deletePlanEntry", input);
	}

	public linkPlanEntryEntity(input: Parameters<StorageDriver["linkPlanEntryEntity"]>[0]): ReturnType<StorageDriver["linkPlanEntryEntity"]> {
		return this.call("linkPlanEntryEntity", input);
	}

	public unlinkPlanEntryEntity(input: Parameters<StorageDriver["unlinkPlanEntryEntity"]>[0]): ReturnType<StorageDriver["unlinkPlanEntryEntity"]> {
		return this.call("unlinkPlanEntryEntity", input);
	}

	public listPlanEntries(input: Parameters<StorageDriver["listPlanEntries"]>[0]): ReturnType<StorageDriver["listPlanEntries"]> {
		return this.call("listPlanEntries", input);
	}

	public listPlanEntryPage(input: Parameters<StorageDriver["listPlanEntryPage"]>[0]): ReturnType<StorageDriver["listPlanEntryPage"]> {
		return this.call("listPlanEntryPage", input);
	}

	public listPlanEntryHistory(input: Parameters<StorageDriver["listPlanEntryHistory"]>[0]): ReturnType<StorageDriver["listPlanEntryHistory"]> {
		return this.call("listPlanEntryHistory", input);
	}

	public getEntityDetails(entityId: string): Promise<EntityDetails> {
		return this.call("getEntityDetails", { entityId });
	}

	public queryEntityRelations(input: Parameters<StorageDriver["queryEntityRelations"]>[0]): Promise<EntityRelations> {
		return this.call("queryEntityRelations", input);
	}

	public listEntities(kind: string): Promise<EntitySummary[]> {
		return this.call("listEntities", { kind });
	}

	public queryEntities(input: Parameters<StorageDriver["queryEntities"]>[0]): ReturnType<StorageDriver["queryEntities"]> {
		return this.call("queryEntities", input);
	}

	public listEntityHistory(entityId: string): Promise<HistoryEntryRecord[]> {
		return this.call("listEntityHistory", { entityId });
	}

	public listAllRelations(): Promise<RelationRecord[]> {
		return this.call("listAllRelations");
	}

	public applyRelations(relations: RelationRecord[]): Promise<{ inserted: number }> {
		return this.call("applyRelations", { relations });
	}

	public listOrphans(kind?: string): Promise<EntityRecord[]> {
		return this.call("listOrphans", kind ? { kind } : undefined);
	}

	public listProjectAdrs(): Promise<EntityRecord[]> {
		return this.call("listProjectAdrs");
	}

	public updateEntityStatus(input: Parameters<StorageDriver["updateEntityStatus"]>[0]): Promise<StatusUpdateResult> {
		return this.call("updateEntityStatus", input);
	}

	public updateEntity(input: Parameters<StorageDriver["updateEntity"]>[0]): ReturnType<StorageDriver["updateEntity"]> {
		return this.call("updateEntity", input);
	}

	public setEntityBody(input: { entityId: string; body: string; bodySource?: BodySource; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<EntityRecord> {
		return this.call("setEntityBody", input);
	}

	public materializeEntityRevision(input: { entityId: string; revision: number }): Promise<MaterializedEntityRevision> {
		return this.call("materializeEntityRevision", input);
	}

	public restoreEntityRevision(input: { entityId: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedEntityRevision> {
		return this.call("restoreEntityRevision", input);
	}

	public archiveEntity(input: { entityId: string }): Promise<StatusUpdateResult> {
		return this.call("archiveEntity", input);
	}

	public deleteEntity(input: { entityId: string }): Promise<DeleteResult> {
		return this.call("deleteEntity", input);
	}

	public moveEntity(input: { entityId: string; newParentId: string; author?: string }): Promise<MoveResult> {
		return this.call("moveEntity", input);
	}

	public linkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<LinkResult> {
		return this.call("linkEntities", input);
	}

	public unlinkEntities(input: { fromId: string; toId: string; relationType: string }): Promise<UnlinkResult> {
		return this.call("unlinkEntities", input);
	}

	public getDatabaseSnapshot(): Promise<DatabaseSnapshot>;
	public getDatabaseSnapshot(input: { projectId: string }): Promise<ProjectSnapshot>;
	public getDatabaseSnapshot(input?: { projectId: string }): Promise<DatabaseSnapshot | ProjectSnapshot> {
		return this.call("getDatabaseSnapshot", input);
	}

	public getProjectSummary(input: { projectId: string }): Promise<ProjectSummary> {
		return this.call("getProjectSummary", input);
	}

	public getProjectDiscovery(input?: { projectId?: string }): Promise<ProjectDiscovery> {
		return this.call("getProjectDiscovery", input);
	}

	public getInitiativeBundle(initiativeId: string): Promise<InitiativeBundle> {
		return this.call("getInitiativeBundle", { initiativeId });
	}

	public getInitiativeDetail(input: { initiativeId: string }): Promise<InitiativeDetail> {
		return this.call("getInitiativeDetail", input);
	}

	public getInitiativeTab(input: { initiativeId: string; tab: InitiativeTab }): Promise<InitiativeTabData> {
		return this.call("getInitiativeTab", input);
	}

	public getSnapshotSignature(): Promise<string> {
		return this.call("getSnapshotSignature");
	}

	// Context / glossary
	public listContexts(): Promise<ContextListResult> {
		return this.call("listContexts");
	}

	public getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails> {
		return this.call("getContextDetails", input);
	}

	public getContextDirectory(): Promise<ContextDirectory> {
		return this.call("getContextDirectory");
	}

	public queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult> {
		return this.call("queryContextDirectory", input);
	}

	public upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextDetails> {
		return this.call("upsertContext", input);
	}

	public defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<DefineContextTermResult> {
		return this.call("defineContextTerm", input);
	}

	public forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult> {
		return this.call("forgetContextTerm", input);
	}

	public materializeContextRevision(input: { scopeRef?: string; revision: number }): Promise<MaterializedContextRevision> {
		return this.call("materializeContextRevision", input);
	}

	public materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }): Promise<MaterializedContextTermRevision> {
		return this.call("materializeContextTermRevision", input);
	}

	public restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextRevision> {
		return this.call("restoreContextRevision", input);
	}

	public restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextTermRevision> {
		return this.call("restoreContextTermRevision", input);
	}

	// Tenant administration
	public listTenants(): Promise<TenantSummary[]> {
		return this.call("listTenants");
	}

	public deleteTenant(tenantId: string): Promise<DeleteTenantResult> {
		return this.call("deleteTenant", { tenantId });
	}

	public renameTenant(previousTenantId: string, newTenantId: string): Promise<RenameTenantResult> {
		return this.call("renameTenant", { previousTenantId, newTenantId });
	}

	public async close(): Promise<void> {
		this.closed = true;
	}
}
