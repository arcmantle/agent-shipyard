import { PublicClientApplication } from "@azure/msal-node";

import type { DeviceCodeLoginFn } from "../cli/commands/auth.js";

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
	const app = new PublicClientApplication({
		auth: {
			clientId,
			authority: `https://login.microsoftonline.com/${tenantId}`
		}
	});

	const result = await app.acquireTokenByDeviceCode({
		scopes: ["User.Read"],
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
	const expiresAt = (result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000)).toISOString();

	return {
		tenantId: resolvedTenantId,
		userId,
		displayName: result.account?.name ?? claims.name,
		accessToken: result.accessToken,
		expiresAt
	};
};
