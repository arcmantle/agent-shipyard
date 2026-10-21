import { timingSafeEqual } from "node:crypto";

import { resolveLocalUsername, type AuthIdentity, type AuthProvider } from "@agent-issues/core";

export type DaemonTokenAuthProviderOptions = {
	/** The current daemon instance's own minted token (ISS184), compared against every request's bearer token. */
	token: string;
	/** The well-known local tenant every request resolves to - local mode has exactly one tenant per OS user (`resolveWellKnownLocalTenantId`), unlike cloud's per-token tenant claim. */
	tenantId: string;
};

function timingSafeEqualStrings(a: string, b: string): boolean {
	const bufferA = Buffer.from(a);
	const bufferB = Buffer.from(b);
	if (bufferA.length !== bufferB.length) return false;
	return timingSafeEqual(bufferA, bufferB);
}

/**
 * The local daemon's own `AuthProvider` (ISS184, ADR44/ADR46): unlike
 * `LocalAuthProvider`/`EntraIdAuthProvider`, this never issues or decodes a
 * JWT - it just constant-time-compares the presented bearer token against
 * the one per-instance token this daemon minted and stored via the native
 * OS credential store at spawn time. A match always resolves to the same
 * well-known local tenant, since local mode's daemon fronts exactly one
 * tenant per OS user, not a variable claim carried by the token itself.
 */
export class DaemonTokenAuthProvider implements AuthProvider {
	private readonly token: string;
	private readonly tenantId: string;

	public constructor(options: DaemonTokenAuthProviderOptions) {
		this.token = options.token;
		this.tenantId = options.tenantId;
	}

	public async validateToken(bearerToken: string): Promise<AuthIdentity> {
		const provided = bearerToken.replace(/^Bearer\s+/i, "");

		if (!timingSafeEqualStrings(provided, this.token)) {
			throw new Error("Invalid daemon token.");
		}

		const username = resolveLocalUsername();
		return { userId: `local:${username}`, tenantId: this.tenantId, displayName: username };
	}
}
