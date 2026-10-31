/** Entra app roles; an identity with roles but none of these can only read. */
export const LOGBOOK_READER_ROLE = "Logbook.Reader";
export const LOGBOOK_WRITER_ROLE = "Logbook.Writer";
export const LOGBOOK_ADMIN_ROLE = "Logbook.Admin";

export type AuthIdentity = {
	userId: string;
	tenantId: string;
	displayName?: string;
	/** Set by providers that issue app roles; undefined means the provider has no role concept. */
	roles?: readonly string[];
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
