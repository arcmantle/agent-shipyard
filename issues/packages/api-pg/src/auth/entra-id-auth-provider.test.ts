import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AuthProvider } from "@agent-issues/core";
import { EntraIdAuthProvider } from "./entra-id-auth-provider.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const CLIENT_ID = "22222222-2222-2222-2222-222222222222";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

type TestKeys = {
	privateKey: CryptoKey;
	jwks: ReturnType<typeof createLocalJWKSet>;
};

async function generateTestKeys(): Promise<TestKeys> {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
	return { privateKey, jwks };
}

async function signTestToken(
	privateKey: CryptoKey,
	claims: { oid?: string; tid?: string; name?: string; iss?: string; aud?: string; expiresInSeconds?: number }
): Promise<string> {
	const {
		oid = "user-object-id",
		tid = TENANT_ID,
		name,
		iss = ISSUER,
		aud = CLIENT_ID,
		expiresInSeconds = 3600
	} = claims;

	return new SignJWT({ oid, tid, name })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(iss)
		.setAudience(aud)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
		.sign(privateKey);
}

describe("EntraIdAuthProvider", () => {
	let keys: TestKeys;

	beforeAll(async () => {
		keys = await generateTestKeys();
	});

	it("validates a well-formed Entra ID token and yields the stable identity", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await signTestToken(keys.privateKey, { oid: "user-abc", tid: TENANT_ID });

		const identity = await provider.validateToken(`Bearer ${token}`);

		expect(identity).toEqual({ userId: "user-abc", tenantId: TENANT_ID });
	});

	it("returns the trusted Entra name claim as the display name", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await signTestToken(keys.privateKey, { oid: "user-abc", tid: TENANT_ID, name: "Ada Lovelace" });

		await expect(provider.validateToken(token)).resolves.toEqual({ userId: "user-abc", tenantId: TENANT_ID, displayName: "Ada Lovelace" });
	});

	it("accepts a bare token with no 'Bearer ' prefix", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await signTestToken(keys.privateKey, { oid: "user-abc", tid: TENANT_ID });

		const identity = await provider.validateToken(token);

		expect(identity).toEqual({ userId: "user-abc", tenantId: TENANT_ID });
	});

	it("rejects a token whose issuer belongs to a different tenant", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const otherTenantId = "33333333-3333-3333-3333-333333333333";
		const token = await signTestToken(keys.privateKey, {
			iss: `https://login.microsoftonline.com/${otherTenantId}/v2.0`,
			tid: otherTenantId
		});

		await expect(provider.validateToken(token)).rejects.toThrow();
	});

	it("rejects a token whose tid claim mismatches the configured tenant (defense in depth)", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const otherTenantId = "33333333-3333-3333-3333-333333333333";
		const token = await signTestToken(keys.privateKey, { tid: otherTenantId });

		await expect(provider.validateToken(token)).rejects.toThrow(/tenant mismatch/);
	});

	it("rejects a token issued for a different client (audience)", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await signTestToken(keys.privateKey, { aud: "44444444-4444-4444-4444-444444444444" });

		await expect(provider.validateToken(token)).rejects.toThrow();
	});

	it("rejects an expired token", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await signTestToken(keys.privateKey, { expiresInSeconds: -60 });

		await expect(provider.validateToken(token)).rejects.toThrow();
	});

	it("rejects a token missing the oid/tid claims", async () => {
		const provider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer(ISSUER)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
			.sign(keys.privateKey);

		await expect(provider.validateToken(token)).rejects.toThrow(/oid\/tid/);
	});

	it("is swappable behind the AuthProvider seam alongside a fake provider", async () => {
		const fakeProvider: AuthProvider = {
			async validateToken(bearerToken: string) {
				return { userId: `fake-${bearerToken}`, tenantId: "fake-tenant" };
			}
		};

		async function resolveIdentity(provider: AuthProvider, token: string) {
			return provider.validateToken(token);
		}

		const entraProvider = new EntraIdAuthProvider({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks });
		const entraToken = await signTestToken(keys.privateKey, { oid: "user-abc", tid: TENANT_ID });

		expect(await resolveIdentity(entraProvider, entraToken)).toEqual({ userId: "user-abc", tenantId: TENANT_ID });
		expect(await resolveIdentity(fakeProvider, "token-123")).toEqual({ userId: "fake-token-123", tenantId: "fake-tenant" });
	});
});
