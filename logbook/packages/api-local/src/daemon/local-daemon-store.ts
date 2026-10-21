import { HttpStore, resolveWellKnownLocalTenantId, type HttpStoreOptions } from "@agent-issues/core";
import { readDaemonToken, type DaemonTokenStoreOptions } from "../auth/daemon-token.js";
import {
	callDaemonWithVersionHandshakeRetry,
	ensureDaemonRunning,
	type CallDaemonWithVersionHandshakeRetryOptions
} from "./daemon-lifecycle.js";

const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5000;

export type LocalDaemonStoreOptions = Omit<CallDaemonWithVersionHandshakeRetryOptions, "spawn"> & {
	spawn?: CallDaemonWithVersionHandshakeRetryOptions["spawn"];
	buildHash?: string;
	dbPath?: string;
	credentialStoreOptions?: DaemonTokenStoreOptions;
	workspaceRoot?: string;
	projectIdentity?: string;
	correlationId?: string;
	requestTimeoutMs?: number;
};

type ResolvedLocalDaemonStoreOptions = LocalDaemonStoreOptions & Pick<CallDaemonWithVersionHandshakeRetryOptions, "spawn">;

export class LocalDaemonStore extends HttpStore {
	public constructor(lifecycleOptions: ResolvedLocalDaemonStoreOptions, httpOptions: Omit<HttpStoreOptions, "baseUrl">) {
		const requestTimeoutMs = lifecycleOptions.requestTimeoutMs ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
		const timeoutFetch = createStartupTimeoutFetch(httpOptions.fetchImpl ?? fetch, requestTimeoutMs);
		super({
			...httpOptions,
			baseUrl: "http://127.0.0.1:0",
			fetchImpl: timeoutFetch.fetch
		});
		this.lifecycleOptions = lifecycleOptions;
		this.requestTimeoutMs = requestTimeoutMs;
		this.disableRequestTimeout = timeoutFetch.disable;
	}

	protected lifecycleOptions: ResolvedLocalDaemonStoreOptions;
	protected requestTimeoutMs: number;
	protected disableRequestTimeout: () => void;
	protected daemonPort: number | undefined;

	public async confirmReady(): Promise<void> {
		await this.call("daemonHealth");
		this.disableRequestTimeout();
	}

	protected override async call<T>(method: string, params?: unknown): Promise<T> {
		const dbPath = this.lifecycleOptions.dbPath;
		let attempt = 0;
		try {
			return await callDaemonWithVersionHandshakeRetry(this.lifecycleOptions, async (port) => {
				if (attempt > 0 || (this.daemonPort !== undefined && this.daemonPort !== port)) {
					const freshToken = await readDaemonToken({ ...this.lifecycleOptions.credentialStoreOptions, dbPath });
					if (freshToken) this.options.bearerToken = freshToken;
				}
				attempt++;
				this.daemonPort = port;
				this.options.baseUrl = `http://127.0.0.1:${port}`;
				return super.call<T>(method, params);
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "TimeoutError") {
				throw new Error(`Local daemon request timed out after ${this.requestTimeoutMs}ms. Request: ${method}.`, { cause: error });
			}
			throw error;
		}
	}
}

export async function openLocalDaemonStore(options: LocalDaemonStoreOptions): Promise<LocalDaemonStore> {
	const lifecycleOptions: ResolvedLocalDaemonStoreOptions = {
		...options,
		spawn: options.spawn ?? (() => {
			throw new Error("Cannot start the local daemon because no spawn function was supplied.");
		})
	};
	await ensureDaemonRunning(lifecycleOptions);
	const token = await readDaemonToken({ ...options.credentialStoreOptions, dbPath: options.dbPath });
	if (!token) throw new Error("Local daemon is running but no daemon token was found in the OS credential store.");

	const store = new LocalDaemonStore(lifecycleOptions, {
		bearerToken: token,
		tenantId: resolveWellKnownLocalTenantId(),
		buildHash: options.buildHash,
		correlationId: options.correlationId,
		dbPath: options.dbPath,
		projectIdentity: options.projectIdentity,
		workspaceRoot: options.workspaceRoot
	});
	try {
		await store.confirmReady();
		return store;
	} catch (error) {
		await store.close();
		throw error;
	}
}

function createStartupTimeoutFetch(fetchImpl: typeof fetch, timeoutMs: number): { fetch: typeof fetch; disable: () => void } {
	let enabled = true;
	return {
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			if (!enabled) {
				return fetchImpl(input, init);
			}
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
			return fetchImpl(input, { ...init, signal });
		}) as typeof fetch,
		disable: () => {
			enabled = false;
		}
	};
}