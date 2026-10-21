import { jwtVerify, SignJWT } from "jose";

import type { AuthIdentity, AuthProvider } from "./auth-provider.js";

export type LocalAuthProviderOptions = {
	/**
	 * Shared secret used to sign and validate locally-issued dev credentials.
	 * Required with no default, so `LocalAuthProvider` can never be silently
	 * enabled without an explicit opt-in secret (ADR21).
	 */
	secret: string;
};

const ISSUER = "agent-issues-local-auth";

/**
 * Dev-only concrete implementation of the auth-provider seam (ADR12, ADR21):
 * issues and validates a locally-signed credential with no network call and
 * no Azure tenant. Unlike `EntraIdAuthProvider`, this provider also issues
 * its own tokens, since there is no external identity provider to obtain one
 * from locally. For local development and AFK testing of the cloud auth
 * path only; callers must gate its use behind an explicit opt-in and must
 * never wire it up as a deployment default.
 */
export class LocalAuthProvider implements AuthProvider {
	private readonly key: Uint8Array;

	public constructor(options: LocalAuthProviderOptions) {
		this.key = new TextEncoder().encode(options.secret);
	}

	public async issueToken(identity: AuthIdentity, expiresInSeconds = 3600): Promise<string> {
		return new SignJWT({ userId: identity.userId, tenantId: identity.tenantId, displayName: identity.displayName })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer(ISSUER)
			.setIssuedAt()
			.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
			.sign(this.key);
	}

	public async validateToken(bearerToken: string): Promise<AuthIdentity> {
		const token = bearerToken.replace(/^Bearer\s+/i, "");

		const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER });

		const userId = typeof payload.userId === "string" ? payload.userId : undefined;
		const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : undefined;
		const displayName = typeof payload.displayName === "string" ? payload.displayName : undefined;

		if (!userId || !tenantId) {
			throw new Error("Local auth token is missing required userId/tenantId claims.");
		}

		return { userId, tenantId, ...(displayName !== undefined && { displayName }) };
	}
}
