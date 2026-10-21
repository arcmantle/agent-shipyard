export type AuthIdentity = {
	userId: string;
	tenantId: string;
	displayName?: string;
};

/**
 * Cloud auth as a provider seam (ADR12): validates a bearer token and yields
 * a stable {userId, tenantId}. Entra ID is the first concrete implementation;
 * a future self-hosted or non-Azure deployment swaps the provider, not the
 * core that consumes it.
 */
export interface AuthProvider {
	validateToken(bearerToken: string): Promise<AuthIdentity>;
}
