import express, { type Express, type Request } from "express";

import type { AuthIdentity, AuthProvider } from "../auth/auth-provider.js";
import { EntityConflictError, EntityRevisionError } from "../features/entity-store/domain.js";
import { ContextConflictError, ContextRevisionError, ContextTermConflictError } from "../features/context/context-types.js";
import { IssueCommentConflictError } from "../features/storage-driver/issue-comment-store.js";
import { PlanEntryConflictError } from "../features/plan-entry/plan-entry-types.js";
import { InstructionFragmentError, InstructionResetAllError, InstructionWriteError } from "../features/storage-driver/instruction-store.js";
import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { CompletionObservationConflictError, SynchronizeConflictError } from "../features/synchronize/canonical-chain.js";
import { ChangeEventBroadcaster, mergeProjectChangeEventDetails, projectChangeEventForWrite } from "./change-events.js";
import { isJsonRpcRequest, JSON_RPC_ERROR_CODES, type JsonRpcErrorResponse, type JsonRpcSuccessResponse } from "./json-rpc.js";
import { rpcMethods, writeMethods } from "./rpc-methods.js";

export type VersionMismatchDetails =
	| { reason: "build-hash"; expectedBuildHash: string; receivedBuildHash: string | undefined }
	| { reason: "db-path"; expectedDbPath: string; receivedDbPath: string | undefined };

export type VersionHandshakeOptions = {
	/** This daemon instance's own build-content-hash (ADR45), computed once at startup and compared against every request's build-hash header. */
	buildHash: string;
	/** HTTP header carrying the client's build-content-hash. Defaults to `x-agent-issues-build-hash`. */
	header?: string;
	/**
	 * This daemon instance's own resolved db path (ISS190): compared against
	 * every request's db-path header the same way `buildHash` is - a client
	 * requesting a different `--db` is exactly as incompatible as a stale
	 * build, and triggers the same drain-then-exit-and-respawn flow. Omitted
	 * entirely by the cloud gate, which has no local db-path concept.
	 */
	dbPath?: string;
	/** HTTP header carrying the client's requested db path. Defaults to `x-agent-issues-db-path`. */
	dbPathHeader?: string;
	/**
	 * Fired once per mismatched request (not deduplicated here - the daemon
	 * itself decides whether to start draining only the first time). Absent
	 * or a differing header value both count as a mismatch, since a client
	 * that sends no header at all is exactly as stale/incompatible as one
	 * sending an old hash.
	 */
	onMismatch?: (details: VersionMismatchDetails) => void;
};

export type CreateJsonRpcAppOptions = {
	authProvider: AuthProvider;
	/**
	 * Opens the `StorageDriver` a request's dispatched method runs against,
	 * given the auth-seam-resolved identity (ADR44) and the client's
	 * resolved project identity, if it sent one (ISS183, read from the
	 * `x-agent-issues-project-identity` header). Cloud callers supply
	 * `(identity, projectIdentity) => new PgStore(pool, identity.tenantId, projectIdentity)`;
	 * the local daemon supplies a `SqliteStore`-opening equivalent instead
	 * (using `workspaceRoot`, since local mode resolves project scope from the
	 * client workspace's resolved project identity) - the gate itself never branches on which backend it's
	 * fronting.
	 */
	createStore: (identity: AuthIdentity, projectIdentity?: string, workspaceRoot?: string, method?: string) => StorageDriver | Promise<StorageDriver>;
	/**
	 * The local daemon's build-content-hash version handshake (ADR45,
	 * ISS188). Omitted entirely by the cloud gate, which has no build-hash
	 * concept - a request is only ever checked against this when the daemon
	 * explicitly supplies it.
	 */
	versionHandshake?: VersionHandshakeOptions;
};

const DEFAULT_BUILD_HASH_HEADER = "x-agent-issues-build-hash";
const DEFAULT_DB_PATH_HEADER = "x-agent-issues-db-path";
const PROJECT_IDENTITY_HEADER = "x-agent-issues-project-identity";
const CORRELATION_ID_HEADER = "x-agent-issues-correlation-id";
const WORKSPACE_ROOT_HEADER = "x-agent-issues-workspace-root";

type VersionCheckResult =
	| { ok: true }
	| { ok: false; code: "daemon-version-mismatch"; expectedBuildHash: string; receivedBuildHash: string | undefined }
	| { ok: false; code: "daemon-db-mismatch"; expectedDbPath: string; receivedDbPath: string | undefined };

function checkVersionHandshake(request: Request, versionHandshake: VersionHandshakeOptions | undefined): VersionCheckResult {
	if (!versionHandshake) return { ok: true };

	const buildHashHeader = versionHandshake.header ?? DEFAULT_BUILD_HASH_HEADER;
	const receivedBuildHash = request.header(buildHashHeader);
	if (receivedBuildHash !== versionHandshake.buildHash) {
		versionHandshake.onMismatch?.({ reason: "build-hash", expectedBuildHash: versionHandshake.buildHash, receivedBuildHash });
		return { ok: false, code: "daemon-version-mismatch", expectedBuildHash: versionHandshake.buildHash, receivedBuildHash };
	}

	if (versionHandshake.dbPath !== undefined) {
		const dbPathHeader = versionHandshake.dbPathHeader ?? DEFAULT_DB_PATH_HEADER;
		const receivedDbPath = request.header(dbPathHeader);
		if (receivedDbPath !== versionHandshake.dbPath) {
			versionHandshake.onMismatch?.({ reason: "db-path", expectedDbPath: versionHandshake.dbPath, receivedDbPath });
			return { ok: false, code: "daemon-db-mismatch", expectedDbPath: versionHandshake.dbPath, receivedDbPath };
		}
	}

	return { ok: true };
}

function versionMismatchErrorBody(versionCheck: Extract<VersionCheckResult, { ok: false }>) {
	const error = versionCheck.code === "daemon-version-mismatch" ? "Daemon build-hash mismatch." : "Daemon db-path mismatch.";
	return { error, ...versionCheck };
}

type AuthResult = { identity: AuthIdentity } | { errorStatus: number; errorBody: { error: string } };

/**
 * Shared by both the JSON-RPC dispatch route and the SSE change-event route:
 * a missing/invalid bearer token is rejected the same way, before either
 * route does anything tenant-scoped.
 */
async function resolveIdentity(request: Request, authProvider: AuthProvider): Promise<AuthResult> {
	const authHeader = request.header("authorization");
	if (!authHeader) {
		return { errorStatus: 401, errorBody: { error: "Missing Authorization header." } };
	}

	try {
		const identity = await authProvider.validateToken(authHeader);
		return { identity };
	} catch {
		return { errorStatus: 401, errorBody: { error: "Invalid or expired bearer token." } };
	}
}

/**
 * The single Postgres gate's JSON-RPC surface (ADR13, ADR14): auth seam ->
 * tenant resolution -> method dispatch -> `PgStore` (which itself opens the
 * one `withTenantTransaction` per ADR9). Per-request tenant scoping always
 * comes from the validated bearer token, never from the request body, so a
 * caller cannot widen its own access by passing a different tenantId in
 * `params` - `PgStore` is constructed with `identity.tenantId` and RLS
 * (ADR9) backstops it even if a handler carelessly forwarded such a field.
 *
 * The gate also owns the change-notification channel (ADR13): `/events` is
 * an SSE stream, scoped per tenant, that the site's live-refresh consumes in
 * cloud mode the same way it already consumes the local file-watch-driven
 * `/events` stream. `writeMethods` (`rpc-methods.js`) marks which JSON-RPC
 * methods are writes; only those trigger a broadcast after they succeed.
 */
export function createJsonRpcApp(options: CreateJsonRpcAppOptions): Express {
	const { authProvider, createStore, versionHandshake } = options;
	const app = express();
	// Canonical synchronization can transfer a whole project's revision chains.
	app.use(express.json({ limit: "50mb" }));
	const changeEvents = new ChangeEventBroadcaster();

	app.get("/events", async (request, response) => {
		const versionCheck = checkVersionHandshake(request, versionHandshake);
		if (!versionCheck.ok) {
			response.status(409).json(versionMismatchErrorBody(versionCheck));
			return;
		}

		const auth = await resolveIdentity(request, authProvider);
		if ("errorStatus" in auth) {
			response.status(auth.errorStatus).json(auth.errorBody);
			return;
		}

		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		});
		response.write("retry: 1000\n");
		response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);

		const unsubscribe = changeEvents.subscribe(auth.identity.tenantId, response);
		request.on("close", unsubscribe);
	});

	app.post("/rpc", async (request, response) => {
		const versionCheck = checkVersionHandshake(request, versionHandshake);
		if (!versionCheck.ok) {
			response.status(409).json(versionMismatchErrorBody(versionCheck));
			return;
		}

		const auth = await resolveIdentity(request, authProvider);
		if ("errorStatus" in auth) {
			response.status(auth.errorStatus).json(auth.errorBody);
			return;
		}

		const identity = auth.identity;
		const rpcRequest = request.body;
		if (!isJsonRpcRequest(rpcRequest)) {
			response.status(400).json({ error: "Malformed JSON-RPC request: expected { jsonrpc: \"2.0\", method, id }." });
			return;
		}
		if (rpcRequest.method === "daemonHealth") {
			const successResponse: JsonRpcSuccessResponse = { jsonrpc: "2.0", id: rpcRequest.id, result: { ready: true } };
			response.status(200).json(successResponse);
			return;
		}

		const handler = rpcMethods[rpcRequest.method];
		if (!handler) {
			const errorResponse: JsonRpcErrorResponse = {
				jsonrpc: "2.0",
				id: rpcRequest.id,
				error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${rpcRequest.method}` }
			};
			response.status(200).json(errorResponse);
			return;
		}

		try {
			// Inside the try on purpose: opening the store is the most common
			// place a request fails for a reason the caller can act on (an
			// unregistered project identity in a fresh workspace, a migration
			// failure, a locked db file). Left outside, the rejection escapes to
			// express' default handler and the caller only ever sees an opaque
			// HTTP 500 instead of the actual message.
			const store = (await createStore(identity, request.header(PROJECT_IDENTITY_HEADER), request.header(WORKSPACE_ROOT_HEADER), rpcRequest.method)).withAuthenticatedIdentity(identity);
			const isWrite = writeMethods.has(rpcRequest.method);
			const changeBefore = isWrite
				? await projectChangeEventForWrite(
					store,
					rpcRequest.method,
					request.header(PROJECT_IDENTITY_HEADER),
					rpcRequest.params,
					undefined,
					request.header(CORRELATION_ID_HEADER)
				)
				: undefined;
			const result = await handler(store, rpcRequest.params);
			const changeAfter = isWrite
				? await projectChangeEventForWrite(
					store,
					rpcRequest.method,
					request.header(PROJECT_IDENTITY_HEADER),
					rpcRequest.params,
					result,
					request.header(CORRELATION_ID_HEADER)
				)
				: undefined;
			const successResponse: JsonRpcSuccessResponse = { jsonrpc: "2.0", id: rpcRequest.id, result };
			response.status(200).json(successResponse);
			if (changeBefore && changeAfter) {
				changeEvents.publishSnapshotChanged(
					identity.tenantId,
					mergeProjectChangeEventDetails(changeBefore, changeAfter)
				);
			}
		} catch (error) {
			const data = error instanceof InstructionFragmentError
				? { instructionFragmentError: true, reason: error.reason, currentSource: error.currentSource, affectedReferences: error.affectedReferences }
				: error instanceof InstructionResetAllError
				? { instructionResetAllError: true, reason: error.reason, currentInspection: error.currentInspection }
				: error instanceof InstructionWriteError
				? { instructionWriteError: true, reason: error.reason, currentSource: error.currentSource }
				: error instanceof CompletionObservationConflictError
				? { observationId: error.observationId }
				: error instanceof SynchronizeConflictError
				? { recordKind: error.recordKind, recordId: error.recordId, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
				: error instanceof EntityConflictError
				? { entityId: error.entityId, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
				: error instanceof EntityRevisionError
					? { entityId: error.entityId, reason: error.reason, ...(error.headRevision !== undefined && { headRevision: error.headRevision }) }
					: error instanceof IssueCommentConflictError
						? { commentId: error.commentId, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
						: error instanceof PlanEntryConflictError
							? { entryId: error.entryId, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
					: error instanceof ContextRevisionError
						? { contextKey: error.contextKey, reason: error.reason, ...(error.term !== undefined && { term: error.term }), ...(error.headRevision !== undefined && { headRevision: error.headRevision }) }
					: error instanceof ContextConflictError
						? { contextKey: error.contextKey, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
						: error instanceof ContextTermConflictError
							? { contextKey: error.contextKey, term: error.term, currentRevision: error.currentRevision, currentContentHash: error.currentContentHash }
						: undefined;
			const errorResponse: JsonRpcErrorResponse = {
				jsonrpc: "2.0",
				id: rpcRequest.id,
				error: { code: JSON_RPC_ERROR_CODES.serverError, message: error instanceof Error ? error.message : "Internal error.", ...(data !== undefined && { data }) }
			};
			response.status(200).json(errorResponse);
		}
	});

	return app;
}
