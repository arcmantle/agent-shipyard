import { PublicClientApplication, type AuthenticationResult } from "@azure/msal-node";

import type { DeviceCodeLoginFn } from "../cli/commands/auth.js";
import type { RefreshEntraSessionFn } from "./saved-login-refresh.js";

/**
 * Real Entra ID device-code login (ADR12's client-side leg). This is the
 * genuine HITL boundary for ISS32: it requires a human to open the printed
 * verification URL in a browser and enter the device code against a real
 * Azure app registration. Not unit-tested for that reason - see
 * docs/auth-entra-id-setup.md for how to obtain the tenant/client IDs this
 * needs, and `agent-issues auth login --help` for usage. Remote-login tests
 * cover everything downstream of this exchange with a fake implementation
 * of `DeviceCodeLoginFn`.
 */
export const acquireEntraDeviceCodeSession: DeviceCodeLoginFn = async ({ tenantId, clientId, onDeviceCode }) => {
	const app = createApplication(clientId, tenantId);

	const result = await app.acquireTokenByDeviceCode({
		scopes: apiScopes(clientId),
		deviceCodeCallback: (response) => {
			onDeviceCode(response.message);
		}
	});

	if (!result) {
		throw new Error("Entra ID device-code login did not return a token.");
	}

	const claims = result.idTokenClaims as { oid?: string; tid?: string; name?: string };
	const userId = claims.oid ?? result.uniqueId;
	const resolvedTenantId = claims.tid ?? result.tenantId ?? tenantId;

	return {
		tenantId: resolvedTenantId,
		userId,
		displayName: result.account?.name ?? claims.name,
		accessToken: result.accessToken,
		expiresAt: toExpiresAt(result),
		...(result.account && {
			entraRefresh: {
				clientId,
				authorityTenantId: tenantId,
				homeAccountId: result.account.homeAccountId,
				tokenCache: app.getTokenCache().serialize()
			}
		})
	};
};

/** Renews the access token silently with the refresh token in the saved MSAL cache. */
export const refreshEntraSession: RefreshEntraSessionFn = async (state) => {
	const app = createApplication(state.clientId, state.authorityTenantId);
	const cache = app.getTokenCache();
	cache.deserialize(state.tokenCache);

	const account = await cache.getAccountByHomeId(state.homeAccountId);
	if (!account) {
		throw new Error("The saved Entra ID token cache does not contain the login account.");
	}

	const result = await app.acquireTokenSilent({ account, scopes: apiScopes(state.clientId) });
	return {
		accessToken: result.accessToken,
		expiresAt: toExpiresAt(result),
		entraRefresh: { ...state, tokenCache: cache.serialize() }
	};
};

function createApplication(clientId: string, tenantId: string): PublicClientApplication {
	return new PublicClientApplication({
		auth: {
			clientId,
			authority: `https://login.microsoftonline.com/${tenantId}`
		}
	});
}

// The API accepts only its own delegated scope, never Microsoft Graph tokens.
function apiScopes(clientId: string): string[] {
	return [`api://${clientId}/access_as_user`];
}

function toExpiresAt(result: AuthenticationResult): string {
	return (result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000)).toISOString();
}
