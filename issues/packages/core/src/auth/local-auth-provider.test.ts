import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import type { AuthProvider } from "./auth-provider.js";
import { LocalAuthProvider } from "./local-auth-provider.js";

const SECRET = "test-only-local-dev-secret";

describe("LocalAuthProvider", () => {
	it("issues a locally-signed credential and validates it back to the same identity", async () => {
		const provider = new LocalAuthProvider({ secret: SECRET });

		const token = await provider.issueToken({ userId: "user-1", tenantId: "local-dev" });
		const identity = await provider.validateToken(token);

		expect(identity).toEqual({ userId: "user-1", tenantId: "local-dev" });
	});

	it("preserves an optional display name in a locally-signed credential", async () => {
		const provider = new LocalAuthProvider({ secret: SECRET });

		const token = await provider.issueToken({ userId: "user-1", tenantId: "local-dev", displayName: "Ada Lovelace" });

		await expect(provider.validateToken(token)).resolves.toEqual({ userId: "user-1", tenantId: "local-dev", displayName: "Ada Lovelace" });
	});

	it("accepts a bare token with no 'Bearer ' prefix", async () => {
		const provider = new LocalAuthProvider({ secret: SECRET });

		const token = await provider.issueToken({ userId: "user-1", tenantId: "local-dev" });
		const identity = await provider.validateToken(`Bearer ${token}`);

		expect(identity).toEqual({ userId: "user-1", tenantId: "local-dev" });
	});

	it("rejects a token signed with a different secret", async () => {
		const issuer = new LocalAuthProvider({ secret: SECRET });
		const validator = new LocalAuthProvider({ secret: "a-different-secret" });

		const token = await issuer.issueToken({ userId: "user-1", tenantId: "local-dev" });

		await expect(validator.validateToken(token)).rejects.toThrow();
	});

	it("rejects an expired token", async () => {
		const provider = new LocalAuthProvider({ secret: SECRET });

		const token = await provider.issueToken({ userId: "user-1", tenantId: "local-dev" }, -60);

		await expect(provider.validateToken(token)).rejects.toThrow();
	});

	it("rejects a token missing the userId/tenantId claims", async () => {
		const provider = new LocalAuthProvider({ secret: SECRET });
		const key = new TextEncoder().encode(SECRET);
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer("agent-issues-local-auth")
			.setIssuedAt()
			.setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
			.sign(key);

		await expect(provider.validateToken(token)).rejects.toThrow(/userId\/tenantId/);
	});

	it("is swappable behind the same AuthProvider seam as a second real provider", async () => {
		async function resolveIdentity(provider: AuthProvider, token: string) {
			return provider.validateToken(token);
		}

		const provider: AuthProvider = new LocalAuthProvider({ secret: SECRET });
		const token = await new LocalAuthProvider({ secret: SECRET }).issueToken({ userId: "user-1", tenantId: "local-dev" });

		expect(await resolveIdentity(provider, token)).toEqual({ userId: "user-1", tenantId: "local-dev" });
	});
});
