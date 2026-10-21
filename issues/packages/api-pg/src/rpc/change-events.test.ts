import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../db/test-tenant-cleanup.js";
import { createJsonRpcApp, LocalAuthProvider, type ProjectChangeEvent } from "@agent-issues/core";
import { PgStore } from "../pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

type SseEvent = { type: string; at: string } | ProjectChangeEvent;

/**
 * The gate's SSE endpoint is a genuinely long-lived streaming connection, so
 * these tests start a real HTTP server and read the response body as a
 * stream (supertest buffers the full response after `end`, which an SSE
 * connection never reaches on its own) - matching `index.test.ts`'s
 * real-HTTP-over-`fetch` style for the same reason.
 */
describe("JSON-RPC gate: change/event stream (ADR13)", () => {
	let adminPool: Pool;
	let appPool: Pool;
	let authProvider: LocalAuthProvider;
	let server: Server;
	let baseUrl: string;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });

		const app = createJsonRpcApp({ authProvider, createStore: (identity) => new PgStore(appPool, identity.tenantId) });
		server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		server.close();
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	const openSubscriptions: AbortController[] = [];

	afterEach(() => {
		for (const controller of openSubscriptions) {
			controller.abort();
		}
		openSubscriptions.length = 0;
	});

	async function write(token: string, title: string, projectId?: string) {
		const response = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...(projectId ? { "x-agent-issues-project-identity": projectId } : {})
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title } })
		});
		return await response.json() as { result: { id: string } };
	}

	/**
	 * Collects every event the subscription receives into `events`, in the
	 * background, independent of when a test inspects it - so a test can
	 * assert "still only N events" right after a *different* tenant's write,
	 * which a purely pull-based reader (awaiting the next chunk) could never
	 * distinguish from "an event just hasn't arrived yet".
	 */
	async function subscribe(token: string) {
		const controller = new AbortController();
		openSubscriptions.push(controller);

		const response = await fetch(`${baseUrl}/events`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal
		});

		const events: SseEvent[] = [];
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		void (async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) return;
					buffer += decoder.decode(value, { stream: true });

					let eventEnd: number;
					while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
						const rawEvent = buffer.slice(0, eventEnd);
						buffer = buffer.slice(eventEnd + 2);
						const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data: "));
						if (dataLine) {
							events.push(JSON.parse(dataLine.slice("data: ".length)) as SseEvent);
						}
					}
				}
			} catch {
				// Subscription aborted by the test's afterEach - nothing to do.
			}
		})();

		async function waitForCount(count: number, timeoutMs = 2000): Promise<SseEvent[]> {
			const deadline = Date.now() + timeoutMs;
			while (events.length < count) {
				if (Date.now() > deadline) {
					throw new Error(`Timed out waiting for ${count} SSE event(s); received ${events.length}.`);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return events;
		}

		return { response, events, waitForCount };
	}

	it("subscribes over SSE and receives the initial connected event", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const { response, waitForCount } = await subscribe(token);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const events = await waitForCount(1);
		expect(events[0]?.type).toBe("connected");
	});

	it("broadcasts a snapshot-changed event to the subscribing tenant after a write through the gate", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const { waitForCount } = await subscribe(token);
		await waitForCount(1); // connected

		await write(token, "Triggers a broadcast");

		const events = await waitForCount(2);
		expect(events[1]?.type).toBe("snapshot-changed");
	});

	it("identifies the project and affected initiative after an entity write", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const { waitForCount } = await subscribe(token);
		await waitForCount(1);

		const writeResponse = await write(token, "Scoped initiative", "PROJ1");

		const events = await waitForCount(2);
		expect(events[1]).toMatchObject({
			affectedEntityIds: [writeResponse.result.id],
			affectedInitiativeIds: [writeResponse.result.id],
			category: "entity",
			projectId: "PROJ1",
			type: "snapshot-changed"
		});
	});

	it("marks contains link and unlink events as Project Summary changes", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const rpcWrite = async <Result>(id: number, method: string, params: unknown, projectId?: string) => {
			const response = await fetch(`${baseUrl}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					...(projectId ? { "x-agent-issues-project-identity": projectId } : {})
				},
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
			});
			return await response.json() as { error?: { message: string }; result?: Result };
		};
		const requireResult = <Result>(response: { error?: { message: string }; result?: Result }): Result => {
			expect(response.error).toBeUndefined();
			expect(response.result).toBeDefined();
			return response.result!;
		};
		const project = requireResult(await rpcWrite<{ id: string }>(1, "createEntity", { kind: "project", title: "Scoped project" }));
		const epic = requireResult(await rpcWrite<{ id: string }>(2, "createEntity", { kind: "epic", parentId: project.id, title: "Scoped epic" }, project.id));
		const alternateEpic = requireResult(await rpcWrite<{ id: string }>(3, "createEntity", { kind: "epic", parentId: project.id, title: "Alternate epic" }, project.id));
		const initiative = requireResult(await rpcWrite<{ id: string }>(4, "createEntity", { kind: "initiative", parentId: epic.id, title: "Scoped initiative" }, project.id));
		const alternateParent = requireResult(await rpcWrite<{ created: boolean }>(5, "linkEntities", { fromId: alternateEpic.id, relationType: "contains", toId: initiative.id }, project.id));
		expect(alternateParent.created).toBe(true);
		const { waitForCount } = await subscribe(token);
		await waitForCount(1);

		const unlinkResult = requireResult(await rpcWrite<{ removed: boolean }>(6, "unlinkEntities", { fromId: epic.id, relationType: "contains", toId: initiative.id }, project.id));
		expect(unlinkResult.removed).toBe(true);
		const afterUnlink = await waitForCount(2);
		expect(afterUnlink[1]).toMatchObject({
			affectedEntityIds: expect.arrayContaining([epic.id, initiative.id]),
			affectedInitiativeIds: [initiative.id],
			affectsProjectSummary: true,
			category: "relation",
			projectId: project.id
		});

		const linkResult = requireResult(await rpcWrite<{ created: boolean }>(7, "linkEntities", { fromId: epic.id, relationType: "contains", toId: initiative.id }, project.id));
		expect(linkResult.created).toBe(true);
		const afterLink = await waitForCount(3);
		expect(afterLink[2]).toMatchObject({
			affectedEntityIds: expect.arrayContaining([epic.id, initiative.id]),
			affectedInitiativeIds: [initiative.id],
			affectsProjectSummary: true,
			category: "relation",
			projectId: project.id
		});
	});

	it("retains affected initiative scope after the initiative is deleted", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const { waitForCount } = await subscribe(token);
		await waitForCount(1);
		const created = await write(token, "Deleted initiative", "PROJ1");
		await waitForCount(2);

		await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				"x-agent-issues-project-identity": "PROJ1"
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "deleteEntity", params: { entityId: created.result.id } })
		});

		const events = await waitForCount(3);
		expect(events[2]).toMatchObject({
			affectedEntityIds: [created.result.id],
			affectedInitiativeIds: [created.result.id],
			category: "entity",
			projectId: "PROJ1"
		});
	});

	it("identifies both records and the owner for a Plan-entry linkage write", async () => {
		const tenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const { waitForCount } = await subscribe(token);
		await waitForCount(1);
		const initiative = await write(token, "Plan owner", "PROJ1");
		await waitForCount(2);

		const rpcWrite = async (id: number, method: string, params: unknown, correlationId?: string) => {
			const response = await fetch(`${baseUrl}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					"x-agent-issues-project-identity": "PROJ1",
					...(correlationId ? { "x-agent-issues-correlation-id": correlationId } : {})
				},
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
			});
			return await response.json() as { result: Record<string, unknown> };
		};

		const plan = await rpcWrite(2, "createEntity", { kind: "plan", parentId: initiative.result.id, title: "Delivery Plan" });
		await waitForCount(3);
		const issue = await rpcWrite(3, "createEntity", { kind: "issue", parentId: initiative.result.id, title: "Implement Plan" });
		await waitForCount(4);
		const entry = await rpcWrite(4, "createPlanEntry", { planId: plan.result.id, role: "decision", body: "Use scoped updates." });
		await waitForCount(5);

			await rpcWrite(5, "linkPlanEntryEntity", { entryId: entry.result.id, targetId: issue.result.id }, "write-link-1");

		const events = await waitForCount(6);
		expect(events[5]).toMatchObject({
			affectedEntityIds: expect.arrayContaining([plan.result.id, issue.result.id]),
			affectedInitiativeIds: [initiative.result.id],
			category: "plan-entry",
			correlationId: "write-link-1",
			projectId: "PROJ1"
		});
	});

	it("never broadcasts a write to a different tenant's subscriber", async () => {
		const tenantId = createTestTenantId();
		const otherTenantId = createTestTenantId();
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const otherToken = await authProvider.issueToken({ userId: "user-2", tenantId: otherTenantId });

		const tenantSub = await subscribe(token);
		await tenantSub.waitForCount(1); // connected
		const otherTenantSub = await subscribe(otherToken);
		await otherTenantSub.waitForCount(1); // connected

		await write(token, "Tenant-scoped write");
		await tenantSub.waitForCount(2);
		expect(tenantSub.events[1]?.type).toBe("snapshot-changed");

		// The other tenant's subscriber must still only have its connected
		// event - proving the write above was never broadcast to it.
		expect(otherTenantSub.events).toHaveLength(1);

		// A write for the other tenant's own data is the first (and only)
		// snapshot-changed event it ever receives.
		await write(otherToken, "Other tenant's own write");
		await otherTenantSub.waitForCount(2);
		expect(otherTenantSub.events[1]?.type).toBe("snapshot-changed");

		// ...and that second tenant's write must not have leaked back either.
		expect(tenantSub.events).toHaveLength(2);
	});

	it("rejects a subscription request with no Authorization header", async () => {
		const response = await fetch(`${baseUrl}/events`);
		expect(response.status).toBe(401);
	});
});
