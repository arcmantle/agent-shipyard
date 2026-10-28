import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { createApiServer, LocalAuthProvider, type ApiServerHandle } from "./index.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

describe("createApiServer", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let handle: ApiServerHandle | null = null;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	afterEach(() => {
		handle?.server.close();
		handle = null;
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	it("listens over real HTTP and serves the JSON-RPC gate end to end", async () => {
		const authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
		handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider,
			pool: appPool,
			port: 4491
		});
		await new Promise<void>((resolve) => handle!.server.once("listening", resolve));

		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const response = await fetch(`${handle.url}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Real HTTP round-trip" } })
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result?: { title?: string } };
		expect(body.result?.title).toBe("Real HTTP round-trip");
	});

	it("serves the hosted site with per-user tenant data, isolated events, and no local controls", async () => {
		const publicDirectory = mkdtempSync(path.join(tmpdir(), "hosted-site-"));
		writeFileSync(path.join(publicDirectory, "index.html"), "<!doctype html><title>Logbook</title>");
		writeFileSync(path.join(tmpdir(), "hosted-site-secret.txt"), "outside");
		const authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
		handle = createApiServer({
			authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
			authProvider,
			pool: appPool,
			port: 4492,
			site: { publicDirectory, instructionVersion: "0.0.0" }
		});
		await new Promise<void>((resolve) => handle!.server.once("listening", resolve));
		const [tenantA, tenantB] = [createTestTenantId(), createTestTenantId()];
		const auth = async (tenantId: string, userId: string) => ({ authorization: `Bearer ${await authProvider.issueToken({ userId, tenantId })}` });
		const [userA, userB] = [await auth(tenantA, "user-a"), await auth(tenantB, "user-b")];

		const index = await fetch(`${handle.url}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-security-policy")).toMatch(/script-src 'self';.*frame-ancestors 'none'/);
		expect(index.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await index.text()).toContain("<title>Logbook</title>");
		expect((await fetch(`${handle.url}/%2e%2e/hosted-site-secret.txt`)).status).toBe(404);
		expect((await fetch(`${handle.url}/__agent_issues/stop`, { method: "POST" })).status).not.toBe(200);
		for (const route of ["/site-config.json", "/api/project-summary"]) {
			expect((await fetch(`${handle.url}${route}`)).status).toBe(401);
			expect((await fetch(`${handle.url}${route}`, { headers: { authorization: "Bearer not-a-token" } })).status).toBe(401);
		}

		const events = async (headers: Record<string, string>) => {
			const controller = new AbortController();
			const response = await fetch(`${handle!.url}/events`, { headers, signal: controller.signal });
			const reader = response.body!.getReader();
			let text = "";
			void (async () => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						text += new TextDecoder().decode(value);
					}
				} catch {
					// Aborted at the end of the test.
				}
			})();
			return { read: () => text, close: () => controller.abort() };
		};
		const [eventsA, eventsB] = [await events(userA), await events(userB)];
		try {
			const mutation = await fetch(`${handle.url}/api/project-mutation?tenant=${tenantB}`, {
				method: "POST",
				headers: { ...userA, "content-type": "application/json" },
				body: JSON.stringify({ correlationId: "hosted-write", method: "createEntity", params: { kind: "initiative", title: "Hosted write" } })
			});
			expect(mutation.status).toBe(200);
			await expect.poll(() => eventsA.read()).toContain("hosted-write");
			expect(eventsB.read()).not.toContain("hosted-write");
			const oversized = await fetch(`${handle.url}/api/project-mutation`, {
				method: "POST",
				headers: { ...userA, "content-type": "application/json" },
				body: JSON.stringify({ correlationId: "large", method: "createEntity", params: { title: "x".repeat(6 * 1024 * 1024) } })
			}).catch(() => undefined);
			expect(oversized?.ok).not.toBe(true);

			const configA = (await (await fetch(`${handle.url}/site-config.json?tenant=${tenantB}`, { headers: userA })).json()) as { currentTenant: string; availableTenants: Array<{ id: string }> };
			expect(configA.currentTenant).toBe(tenantA);
			expect(configA.availableTenants.map((tenant) => tenant.id)).toEqual([tenantA]);
			const configB = (await (await fetch(`${handle.url}/site-config.json`, { headers: userB })).json()) as { availableTenants: Array<{ id: string }> };
			expect(configB.availableTenants.map((tenant) => tenant.id)).not.toContain(tenantA);
		} finally {
			eventsA.close();
			eventsB.close();
			rmSync(publicDirectory, { recursive: true, force: true });
			rmSync(path.join(tmpdir(), "hosted-site-secret.txt"), { force: true });
		}
	});
});
