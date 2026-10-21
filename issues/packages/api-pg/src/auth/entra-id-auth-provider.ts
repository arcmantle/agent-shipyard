import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { AuthIdentity, AuthProvider } from "@agent-issues/core";

export type EntraIdAuthProviderOptions = {
	/** The Entra ID (Azure AD) tenant GUID this provider trusts tokens from. */
	tenantId: string;
	/** The Entra ID app registration's client (application) GUID; validated as the token audience. */
	clientId: string;
	/**
	 * Overrides the discovery-derived JWKS key source. Production leaves this
	 * unset and fetches Entra's live JWKS; tests inject a local key set
	 * (`jose.createLocalJWKSet`) so token-validation logic is exercised without
	 * a real Azure tenant.
	 */
	jwks?: JWTVerifyGetKey;
};

/**
 * Concrete Entra ID implementation of the auth-provider seam (ADR12).
 * Verifies an Entra-issued JWT's signature/issuer/audience/expiry against
 * Entra's JWKS and extracts the stable identity from the `oid`/`tid` claims.
 * Only JWT verification is exercised by this repo's tests; the interactive
 * device-login flow that actually produces a real Entra token is a human
 * verification step (see ISS32's HITL acceptance criterion and the Azure
 * setup guide).
 */
export class EntraIdAuthProvider implements AuthProvider {
	private readonly tenantId: string;
	private readonly clientId: string;
	private readonly issuer: string;
	private readonly jwks: JWTVerifyGetKey;

	public constructor(options: EntraIdAuthProviderOptions) {
		this.tenantId = options.tenantId;
		this.clientId = options.clientId;
		this.issuer = `https://login.microsoftonline.com/${options.tenantId}/v2.0`;
		this.jwks =
			options.jwks ??
			createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`));
	}

	public async validateToken(bearerToken: string): Promise<AuthIdentity> {
		const token = bearerToken.replace(/^Bearer\s+/i, "");

		const { payload } = await jwtVerify(token, this.jwks, {
			issuer: this.issuer,
			audience: this.clientId
		});

		const userId = typeof payload.oid === "string" ? payload.oid : undefined;
		const tenantId = typeof payload.tid === "string" ? payload.tid : undefined;
		const displayName = typeof payload.name === "string" ? payload.name : undefined;

		if (!userId || !tenantId) {
			throw new Error("Entra ID token is missing required oid/tid claims.");
		}

		if (tenantId !== this.tenantId) {
			throw new Error(`Entra ID token tenant mismatch: expected ${this.tenantId}, got ${tenantId}.`);
		}

		return { userId, tenantId, ...(displayName !== undefined && { displayName }) };
	}
}
