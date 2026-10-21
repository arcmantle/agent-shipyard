import type { Pool } from "pg";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApiServer, type AuthProvider } from "./index.js";

describe("service metadata", () => {
	it("serves explicit Entra discovery metadata over unauthenticated GET only without database access", async () => {
		const validateToken = vi.fn();
		const query = vi.fn();
		const handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider: { validateToken } satisfies AuthProvider,
			pool: { query } as unknown as Pool,
			port: 0
		});

		try {
			const getResponse = await request(handle.server).get("/.well-known/agent-issues");
			expect(getResponse.status).toBe(200);
			expect(getResponse.headers["content-type"]).toMatch(/^application\/json/);
			expect(getResponse.body).toEqual({
				auth: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" }
			});

			const postResponse = await request(handle.server).post("/.well-known/agent-issues");
			expect(postResponse.status).toBe(404);
			expect(validateToken).not.toHaveBeenCalled();
			expect(query).not.toHaveBeenCalled();
		} finally {
			handle.server.close();
		}
	});
});