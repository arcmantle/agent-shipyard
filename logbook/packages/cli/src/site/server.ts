import { existsSync, statSync } from "node:fs";
import { createServer, request as sendRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { readBuildContentHash, resolveDatabasePath, resolveTenantSlug } from "@agent-issues/api-local";
import { ConfirmationTokenStore, handleSiteRequest, type OpenSiteStore, type SiteRouteOptions } from "@agent-issues/core";
import { getBuiltSiteAssetPath, getContentType } from "./assets.js";
import { subscribeToCloudEvents } from "./cloud-events-relay.js";
import type { SavedLoginStoreOptions } from "../auth/auth-session.js";
import { openStorageDriver } from "../runtime/open-storage-driver.js";
import { getInstructionVersion } from "../runtime/instruction-version.js";

export type { OpenedSiteStore, OpenSiteStore, SiteStoreScope } from "@agent-issues/core";

export type LiveSiteInfo = {
	dbPath: string;
	host: string;
	port: number;
	url: string;
	defaultTenant: string;
};

export type LiveSiteHandle = {
	info: LiveSiteInfo;
	server: Server;
	close: () => void;
};

export type StopLiveSiteResult = {
	host: string;
	port: number;
	url: string;
	reachable: boolean;
	stopped: boolean;
};

const LIVE_SITE_STOP_PATH = "/__agent_issues/stop";

function computeFileStatSignature(dbPath: string): string {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
		.map((candidate) => {
			if (!existsSync(candidate)) {
				return `${candidate}:missing`;
			}

			const stats = statSync(candidate);
			return `${candidate}:${stats.size}:${stats.mtimeMs}`;
		})
		.join("|");
}

export async function startLiveSite(input: {
	dbPath?: string;
	host?: string;
	port?: number;
	tenant?: string;
	currentWorkingDirectory?: string;
	/** Overrides the local-mode snapshot-signature poll interval; defaults to 1000ms. Test-only knob. */
	pollIntervalMs?: number;
	/** Overrides local file signature reads. Test-only knob. */
	readLocalSignature?: (dbPath: string) => string;
	/**
	 * Overrides how `auth-session.ts` reaches the native OS credential store
	 * (ISS185, ADR46) for the remote saved-login lookup. Production
	 * never sets this - the real OS tool is used. Tests inject an
	 * in-memory fake so a remote-routed site server never shells out to the
	 * real credential store.
	 */
	credentialStoreOptions?: SavedLoginStoreOptions;
}): Promise<LiveSiteHandle> {
	const currentWorkingDirectory = input.currentWorkingDirectory;
	const credentialStoreOptions = input.credentialStoreOptions;
	const defaultTenant = resolveTenantSlug({ currentWorkingDirectory, tenant: input.tenant });
	const dbPath = resolveDatabasePath(input.dbPath, { tenant: input.tenant });
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4173;
	const pollIntervalMs = input.pollIntervalMs ?? 1000;
	const readLocalSignature = input.readLocalSignature ?? computeFileStatSignature;
	const info: LiveSiteInfo = {
		dbPath,
		defaultTenant,
		host,
		port,
		url: `http://${host}:${port}`
	};
	const clients = new Set<ServerResponse>();
	const confirmationTokens = new ConfirmationTokenStore(Date.now);
	const openStore: OpenSiteStore = (scope) => openStorageDriver({
		dbPath,
		databaseOptions: { currentWorkingDirectory, tenant: scope.tenant, projectIdentity: scope.projectIdentity },
		authSessionOptions: credentialStoreOptions,
		correlationId: scope.correlationId,
		localDaemon: { buildHash: readBuildContentHash() }
	});

	// Resolved once at startup (ADR13, ADR18): decides whether live-refresh
	// polls the local file or relays the cloud API's own SSE channel (ISS56).
	// Snapshot/site-config reads re-resolve per request through `withStore`
	// instead, since a long-lived cloud session could expire mid-run.
	const opened = await openStorageDriver({
		dbPath: input.dbPath,
		databaseOptions: { currentWorkingDirectory, tenant: input.tenant },
		authSessionOptions: credentialStoreOptions,
		localDaemon: { buildHash: readBuildContentHash() }
	});
	await opened.store.close();

	let databaseSignature =
		opened.backend === "local"
			? readLocalSignature(dbPath)
			: undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let pollingStopped = false;
	let stopCloudEventsRelay: (() => void) | undefined;
	let stopServer: () => void;

	const server = createServer((request, response) => {
		void handleRequest(request, response, stopServer, {
			openStore,
			clients,
			defaultTenant,
			confirmationTokens,
			instructionVersion: getInstructionVersion,
			resolveAsset: resolveBuiltSiteAsset,
			onLocalMutation: (event, signature) => {
				databaseSignature = signature;
				broadcast(clients, JSON.stringify(event));
			}
		}).catch((error) => {
			process.stderr.write(`Live site request failed: ${error instanceof Error ? error.message : String(error)}\n`);
			if (response.writableEnded) {
				return;
			}
			if (response.headersSent) {
				response.end();
				return;
			}
			writeText(response, 500, "Internal Server Error");
		});
	});
	const stopBackgroundWork = () => {
		pollingStopped = true;
		if (pollTimer) {
			clearTimeout(pollTimer);
		}
		stopCloudEventsRelay?.();
	};
	const closeClients = () => {
		for (const client of clients) {
			client.end();
		}
		clients.clear();
	};
	stopServer = () => {
		stopBackgroundWork();
		closeClients();
		server.close();
	};

	if (opened.backend === "local") {
		// A self-rescheduling `setTimeout` (rather than `setInterval`) so a
		// slow tick through the storage-driver seam can never overlap with
		// the next one - the next poll is only scheduled once the current
		// one's `getSnapshotSignature()` call has resolved (ISS191).
		const scheduleNextPoll = () => {
			if (pollingStopped) {
				return;
			}

			pollTimer = setTimeout(() => {
				void Promise.resolve()
					.then(() => readLocalSignature(dbPath))
					.then((nextSignature) => {
						if (nextSignature !== databaseSignature) {
							databaseSignature = nextSignature;
							broadcast(clients, JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString(), category: "unknown" }));
						}
					})
					.catch((error) => {
						process.stderr.write(`Live site change poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
					})
					.finally(scheduleNextPoll);
			}, pollIntervalMs);
		};

		scheduleNextPoll();
	} else if (opened.cloudConnection) {
		stopCloudEventsRelay = subscribeToCloudEvents(opened.cloudConnection, (event) => {
			broadcast(clients, JSON.stringify(event));
		});
	}

	server.on("close", () => {
		stopBackgroundWork();
		closeClients();
	});

	server.on("error", () => {
		stopBackgroundWork();
		closeClients();
	});

	server.listen(port, host);

	return {
		info,
		server,
		close: stopServer
	};
}

export async function stopLiveSite(input: { host?: string; port?: number }): Promise<StopLiveSiteResult> {
	const host = input.host ?? "127.0.0.1";
	const port = input.port ?? 4173;
	const url = `http://${host}:${port}`;

	return await new Promise<StopLiveSiteResult>((resolve, reject) => {
		let timedOut = false;
		const request = sendRequest(
			{
				host,
				method: "POST",
				path: LIVE_SITE_STOP_PATH,
				port
			},
			(response) => {
				response.resume();
				response.once("end", () => {
					resolve({
						host,
						port,
						reachable: true,
						url,
						stopped: response.statusCode === 200
					});
				});
			}
		);

		request.setTimeout(500, () => {
			timedOut = true;
			request.destroy(new Error("Timed out waiting for the live site stop response."));
		});

		request.once("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			if (timedOut) {
				resolve({ host, port, reachable: true, url, stopped: false });
				return;
			}

			if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
				resolve({ host, port, reachable: false, url, stopped: false });
				return;
			}

			reject(error);
		});

		request.end();
	});
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	stopServer: () => void,
	options: SiteRouteOptions
): Promise<void> {
	const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

	if (requestUrl.pathname === LIVE_SITE_STOP_PATH) {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}

		writeText(response, 200, "Stopping live site");
		setImmediate(() => {
			stopServer();
		});
		return;
	}

	await handleSiteRequest(request, response, options);
}

function resolveBuiltSiteAsset(pathname: string): { path: string; contentType: string } | undefined {
	const assetPath = getBuiltSiteAssetPath(pathname);
	return assetPath ? { path: assetPath, contentType: getContentType(assetPath) } : undefined;
}

function broadcast(clients: Set<ServerResponse>, payload: string) {
	for (const client of clients) {
		client.write(`data: ${payload}\n\n`);
	}
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}