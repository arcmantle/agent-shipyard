import { saveSavedLogin, type EntraRefreshState, type RemoteSavedLogin, type SavedLoginStoreOptions } from "./auth-session.js";

export type RefreshedEntraSession = {
	accessToken: string;
	expiresAt: string;
	entraRefresh: EntraRefreshState;
};

export type RefreshEntraSessionFn = (state: EntraRefreshState) => Promise<RefreshedEntraSession>;

export type EnsureFreshSavedLoginOptions = {
	storeOptions?: SavedLoginStoreOptions;
	/** Injectable for tests; defaults to the real MSAL silent refresh. */
	refreshEntraSession?: RefreshEntraSessionFn;
};

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a remote login with a usable access token. When the token is near
 * expiry, it is silently renewed with the saved refresh token and saved again,
 * so a new device-code login is necessary only when the refresh token is invalid.
 */
export async function ensureFreshSavedLogin(login: RemoteSavedLogin, options: EnsureFreshSavedLoginOptions = {}): Promise<RemoteSavedLogin> {
	const expiresAt = Date.parse(login.expiresAt);
	const now = Date.now();
	const expiredMessage = `Saved login "${login.name}" has expired. Run "agent-issues auth login --name ${login.name} --url ${login.serviceUrl}" to refresh it.`;

	if (!login.entraRefresh) {
		if (expiresAt <= now) throw new Error(expiredMessage);
		return login;
	}
	if (expiresAt - REFRESH_MARGIN_MS > now) return login;

	const refresh = options.refreshEntraSession ?? (await import("./entra-device-login.js")).refreshEntraSession;
	let refreshed: RefreshedEntraSession;
	try {
		refreshed = await refresh(login.entraRefresh);
	} catch (error) {
		throw new Error(expiredMessage, { cause: error });
	}

	const updated: RemoteSavedLogin = { ...login, ...refreshed };
	await saveSavedLogin(updated, options.storeOptions);
	return updated;
}
