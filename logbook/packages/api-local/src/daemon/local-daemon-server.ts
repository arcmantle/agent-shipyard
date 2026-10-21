import { createServer, type Server } from "node:http";

import { createJsonRpcApp, resolveWellKnownLocalTenantId, type AuthProvider, type InstructionBundle, type StorageDriver } from "@agent-issues/core";

import { readBuildContentHash } from "./build-info.js";
import { resolveDatabasePath, resolveTenantRootPath } from "../db/database.js";
import { clearDaemonToken, mintDaemonToken, saveDaemonToken, type DaemonTokenStoreOptions } from "../auth/daemon-token.js";
import { DaemonTokenAuthProvider } from "../auth/daemon-token-auth-provider.js";
import { clearDaemonStateIfOwned, saveDaemonState, type DaemonStateStoreOptions } from "./daemon-state.js";
import { openSqliteStore } from "../sqlite-store.js";

type OpenDaemonStore = typeof openSqliteStore;
type DaemonStore = Awaited<ReturnType<OpenDaemonStore>>["store"];

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function resolveIdleTimeoutMs(idleTimeoutMs?: number): number {
	if (idleTimeoutMs !== undefined) return idleTimeoutMs;

	const envValue = process.env.AGENT_ISSUES_DAEMON_IDLE_MS;
	if (envValue !== undefined) {
		const parsed = Number(envValue);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}

	return DEFAULT_IDLE_TIMEOUT_MS;
}

export interface LocalDaemonServerOptions extends DaemonStateStoreOptions {
	host?: string;
	port?: number;
	/** Sqlite db file the daemon fronts (defaults to the well-known local db path, see `openSqliteStore`). */
	dbPath?: string;
	/**
	 * Overrides the daemon's auth seam - tests use this to keep the ISS186
	 * tracer-bullet's `LocalAuthProvider` fixture working unchanged. Production
	 * omits this: the daemon mints its own per-instance token (ISS184, ADR44),
	 * persists it via the native OS credential store, and gates every request
	 * with `DaemonTokenAuthProvider` instead.
	 */
	authProvider?: AuthProvider;
	/** Pass-through to the native OS credential store (ADR46) backing the default token auth; tests inject a fake runner so no real credential tool is touched. */
	credentialStoreOptions?: DaemonTokenStoreOptions;
	/** Idle window before self-terminating (ADR44). Defaults to `AGENT_ISSUES_DAEMON_IDLE_MS`, then 10 minutes. Reset on every request. */
	idleTimeoutMs?: number;
	/** Invoked instead of `process.exit(0)` once the idle timer elapses, or once a version-mismatch drain completes; injectable so tests can observe self-termination without killing the test process. */
	onIdleExit?: () => void;
	/**
	 * This daemon instance's own build-content-hash (ADR45, ISS188);
	 * defaults to reading this install's own `dist/build-info.json`. Tests
	 * override it directly to simulate a stale/fresh daemon pair without
	 * needing two real builds.
	 */
	buildHash?: string;
	/** Injectable store opener for daemon initialization recovery tests. */
	openStore?: OpenDaemonStore;
	instructionBundle?: InstructionBundle;
}

export interface LocalDaemonServerHandle {
	server: Server;
	/** Stops accepting new connections, closes every `SqliteStore` opened while running, and clears the daemon state file and token. */
	close: () => Promise<void>;
}

/**
 * Wraps `SqliteStore` behind the exact same JSON-RPC gate the cloud API uses
 * (ADR44): the local daemon's tracer bullet (ISS186), now with the lifecycle
 * half of ADR44 (ISS189) and the per-instance token auth half (ISS184) - it
 * advertises itself via the state file once listening, gates requests with
 * its own minted token by default, and self-terminates after an idle window
 * with no requests, so a lazily-spawned daemon doesn't linger forever as an
 * orphaned background process. One `SqliteStore` is opened per distinct
 * tenant seen in a request's resolved identity and reused across requests
 * rather than reopened per call - unlike cloud's `new PgStore(pool, tenantId)`
 * per request, which is cheap because it only borrows a pooled connection,
 * opening a `SqliteStore` does real file I/O, so the daemon caches one per
 * tenant for its own lifetime instead.
 *
 * Also carries the version/db-path handshake (ISS188/ADR45, ISS190): a
 * request whose build-hash header disagrees with this instance's own
 * `buildHash`, or whose db-path header disagrees with this instance's own
 * resolved `dbPath`, is rejected (409) before it ever reaches auth or
 * dispatch, and the daemon starts draining - once every already-in-flight
 * request has finished, it self-terminates (drain-then-exit, never a hard
 * kill mid-request) so a fresh daemon (bound to the newer build, or the
 * newly-requested db) can be spawned in its place.
 */
export function createLocalDaemonServer(options: LocalDaemonServerOptions): LocalDaemonServerHandle {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const idleTimeoutMs = resolveIdleTimeoutMs(options.idleTimeoutMs);
	const buildHash = options.buildHash ?? readBuildContentHash();
	const dbPath = resolveDatabasePath(options.dbPath);
	const openStore = options.openStore ?? openSqliteStore;

	// A caller-supplied `authProvider` (tests) skips minting/persisting a token entirely.
	const mintedToken = options.authProvider ? undefined : mintDaemonToken();
	const authProvider =
		options.authProvider ?? new DaemonTokenAuthProvider({ token: mintedToken!, tenantId: resolveWellKnownLocalTenantId() });

	const storesByWorkspace = new Map<string, Promise<DaemonStore>>();
	const instructionInitialization = new WeakMap<DaemonStore, Promise<void>>();
	async function getOrOpenStore(tenantId: string, projectIdentity?: string, workspaceRoot?: string, method?: string): Promise<StorageDriver> {
		const currentWorkingDirectory = workspaceRoot ? resolveTenantRootPath(workspaceRoot) : process.cwd();
		const storeKey = `${tenantId}:${projectIdentity ?? currentWorkingDirectory}`;
		let store = storesByWorkspace.get(storeKey);
		if (!store) {
			store = openStore(dbPath, { currentWorkingDirectory, projectIdentity, tenant: tenantId })
				.then((opened) => opened.store)
				.catch((error: unknown) => {
					if (storesByWorkspace.get(storeKey) === store) storesByWorkspace.delete(storeKey);
					throw error;
				});
			storesByWorkspace.set(storeKey, store);
		}
		const opened = await store;
		if (method?.includes("Instruction") && options.instructionBundle) {
			let initialization = instructionInitialization.get(opened);
			if (!initialization) {
				initialization = opened.importInstructionBundle(options.instructionBundle);
				instructionInitialization.set(opened, initialization);
			}
			await initialization;
		}
		return opened;
	}

	async function closeAllStores(): Promise<void> {
		for (const storePromise of storesByWorkspace.values()) {
			const store = await storePromise;
			await store.close();
		}
	}

	// Guards every self-initiated or caller-initiated shutdown path (idle timeout, drain completion, explicit `close()`) so cleanup only ever runs once.
	let shuttingDown = false;
	async function cleanupResources(): Promise<void> {
		await closeAllStores();
		const clearedOwnedState = clearDaemonStateIfOwned(process.pid, { ...options, dbPath });
		if (clearedOwnedState && mintedToken !== undefined) {
			await clearDaemonToken({ ...options.credentialStoreOptions, dbPath });
		}
	}

	async function selfExit(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (idleTimer) clearTimeout(idleTimer);
		await cleanupResources();
		server.close();
		(options.onIdleExit ?? (() => process.exit(0)))();
	}

	let idleTimer: NodeJS.Timeout | undefined;
	function resetIdleTimer(): void {
		if (idleTimer) clearTimeout(idleTimer);
		if (idleTimeoutMs <= 0) return;

		idleTimer = setTimeout(() => void selfExit(), idleTimeoutMs);
		idleTimer.unref();
	}

	// Set once any request reveals a build-hash mismatch (ISS188); the daemon then self-exits (drain-then-exit) as soon as no request is in flight, rather than tearing down requests other terminals may still be relying on.
	let draining = false;
	let inFlightCount = 0;
	function onRequestFinished(): void {
		inFlightCount--;
		if (draining && inFlightCount === 0) void selfExit();
	}

	const app = createJsonRpcApp({
		authProvider,
		createStore: (identity, projectIdentity, workspaceRoot, method) => getOrOpenStore(identity.tenantId, projectIdentity, workspaceRoot, method),
		versionHandshake: {
			buildHash,
			dbPath,
			onMismatch: () => {
				draining = true;
			}
		}
	});
	const server = createServer(app);

	async function close(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (idleTimer) clearTimeout(idleTimer);
		if (server.listening) {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		await cleanupResources();
	}

	app.post("/daemon/stop", async (request, response) => {
		const authHeader = request.header("authorization");
		if (!authHeader) {
			response.status(401).json({ error: "Missing Authorization header." });
			return;
		}

		try {
			await authProvider.validateToken(authHeader);
		} catch {
			response.status(401).json({ error: "Invalid or expired bearer token." });
			return;
		}

		response.status(202).json({ stopping: true });
		response.once("finish", () => void close());
	});

	server.on("request", (_request, response) => {
		resetIdleTimer();
		inFlightCount++;
		response.on("finish", onRequestFinished);
	});

	void (async () => {
		if (mintedToken !== undefined) {
			await saveDaemonToken(mintedToken, { ...options.credentialStoreOptions, dbPath });
		}
		server.listen(port, host, () => {
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			// Same reasoning as `cleanupResources` above: key by the resolved `dbPath`, not the raw option.
			saveDaemonState({ pid: process.pid, port: boundPort }, { ...options, dbPath });
			resetIdleTimer();
		});
	})();

	return {
		server,
		close
	};
}
