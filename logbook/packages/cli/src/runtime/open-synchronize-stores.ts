import { HttpStore, type StorageDriver } from "@agent-issues/core";
import { openLocalDaemonStore, readBuildContentHash, resolveDatabasePath, type DatabaseLocationOptions, type LocalDaemonStoreOptions } from "@agent-issues/api-local";
import { getActiveSavedLogin, type SavedLoginStoreOptions } from "../auth/auth-session.js";
import { ensureFreshSavedLogin, type RefreshEntraSessionFn } from "../auth/saved-login-refresh.js";
import { spawnLocalDaemon } from "../daemon/local-daemon-store.js";
import { resolveProjectIdentity } from "./project-identity.js";

export type OpenSynchronizeStoresOptions = {
	/** The local source database path. */
	dbPath?: string;
	databaseOptions?: DatabaseLocationOptions;
	authSessionOptions?: SavedLoginStoreOptions;
	/** Injectable for tests; defaults to the real MSAL silent refresh. */
	refreshEntraSession?: RefreshEntraSessionFn;
	localDaemon?: LocalDaemonStoreOptions;
};

export type OpenSynchronizeStoresResult = {
	local: StorageDriver;
	cloud: StorageDriver;
	destination: { name: string; serviceUrl: string; tenantId: string };
};

/**
 * Opens the local source and the globally active remote saved login as the
 * synchronization destination. Synchronization cannot target the local login
 * because its source is already local.
 */
export async function openSynchronizeStores(options: OpenSynchronizeStoresOptions = {}): Promise<OpenSynchronizeStoresResult> {
	const currentWorkingDirectory = options.databaseOptions?.currentWorkingDirectory ?? process.cwd();
	const { identity: projectIdentity } = resolveProjectIdentity(currentWorkingDirectory);
	const savedLogin = await getActiveSavedLogin(options.authSessionOptions);

	if (savedLogin.kind === "local") {
		throw new Error('Synchronization requires an active remote saved login. Run "agent-issues auth switch <name>" or "agent-issues auth login" first.');
	}

	const activeLogin = await ensureFreshSavedLogin(savedLogin, {
		storeOptions: options.authSessionOptions,
		refreshEntraSession: options.refreshEntraSession
	});

	const dbPath = resolveDatabasePath(options.dbPath, options.databaseOptions);
	const local = await openLocalDaemonStore({
		...options.localDaemon,
		buildHash: options.localDaemon?.buildHash ?? readBuildContentHash(),
		credentialStoreOptions: options.localDaemon?.credentialStoreOptions ?? options.authSessionOptions,
		homeDirectory: options.localDaemon?.homeDirectory ?? options.authSessionOptions?.homeDirectory,
		spawn: options.localDaemon?.spawn ?? (() => spawnLocalDaemon({ dbPath: options.localDaemon?.dbPath ?? dbPath })),
		dbPath: options.localDaemon?.dbPath ?? dbPath,
		projectIdentity,
		workspaceRoot: currentWorkingDirectory
	});
	const cloud = new HttpStore({
		baseUrl: activeLogin.serviceUrl,
		bearerToken: activeLogin.accessToken,
		tenantId: activeLogin.tenantId,
		projectIdentity
	});

	return {
		local,
		cloud,
		destination: { name: activeLogin.name, serviceUrl: activeLogin.serviceUrl, tenantId: activeLogin.tenantId }
	};
}
