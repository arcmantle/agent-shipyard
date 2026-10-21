import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { LocalAuthProvider } from "@agent-issues/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createPgPool, migratePgDatabase } from "./db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "./db/test-tenant-cleanup.js";
import { createApiServer, type ApiServerHandle } from "./index.js";
import { PgStore } from "./pg-store.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const schemaName = `project_summary_performance_${randomUUID().replace(/-/g, "_")}`;
const schemaOptions = `-c search_path=${schemaName}`;
let adminPool: Pool;
let appPool: Pool;
let authProvider: LocalAuthProvider;
let handle: ApiServerHandle;

beforeAll(async () => {
	adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: schemaOptions });
	const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await databasePool.query(`CREATE SCHEMA ${schemaName}`);
		await migratePgDatabase(adminPool);
		await databasePool.query(`GRANT USAGE ON SCHEMA ${schemaName} TO agent_issues_app`);
		await databasePool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaName} TO agent_issues_app`);
	} finally {
		await databasePool.end();
	}

	appPool = new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions });
	authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	handle = createApiServer({
		authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
		authProvider,
		pool: appPool,
		port: 0
	});
	await new Promise<void>((resolve) => handle.server.once("listening", resolve));
});

afterAll(async () => {
	await new Promise<void>((resolve, reject) => {
		handle.server.close((error) => error ? reject(error) : resolve());
	});
	await cleanupTestTenants(adminPool);
	const databasePool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	try {
		await databasePool.query(`DROP SCHEMA ${schemaName} CASCADE`);
	} finally {
		await Promise.all([databasePool.end(), adminPool.end(), appPool.end()]);
	}
});

describe("Project Summary performance", () => {
	it("meets response-time and payload-size targets with real PostgreSQL storage", async () => {
		const tenantId = createTestTenantId();
		const projectIdentity = `project-summary-performance-${randomUUID()}`;
		const seedStore = new PgStore(
			new Pool({ connectionString: APP_CONNECTION_STRING, options: schemaOptions }),
			tenantId,
			projectIdentity
		);
		const detailBody = "Detailed project record content. ".repeat(20);

		try {
			for (let initiativeIndex = 0; initiativeIndex < 20; initiativeIndex += 1) {
				const initiative = await seedStore.createEntity({
					body: detailBody,
					kind: "initiative",
					title: `Initiative ${initiativeIndex}`
				});
				const prd = await seedStore.createEntity({
					body: detailBody,
					kind: "prd",
					parentId: initiative.id,
					title: `Requirements ${initiativeIndex}`
				});
				for (let issueIndex = 0; issueIndex < 20; issueIndex += 1) {
					await seedStore.createEntity({
						body: detailBody,
						kind: "issue",
						parentId: initiative.id,
						title: `Issue ${initiativeIndex}-${issueIndex}`
					});
				}
				for (let storyIndex = 0; storyIndex < 5; storyIndex += 1) {
					await seedStore.createEntity({
						body: detailBody,
						kind: "userStory",
						parentId: prd.id,
						title: `Story ${initiativeIndex}-${storyIndex}`
					});
				}
			}

			const discovery = await seedStore.getProjectDiscovery();
			expect(discovery.kind).toBe("available");
			if (discovery.kind !== "available") {
				return;
			}
			const project = discovery.projects.find((entry) => entry.project.title === projectIdentity)?.project;
			expect(project).toBeDefined();
			if (!project) {
				return;
			}

			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
			const startedAt = performance.now();
			const summaryResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
				body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "getProjectSummary", params: { projectId: project.id } }),
				headers: {
					authorization: `Bearer ${bearerToken}`,
					"content-type": "application/json",
					"x-agent-issues-project-identity": projectIdentity
				},
				method: "POST"
			});
			const summaryBody = await summaryResponse.text();
			const durationMs = performance.now() - startedAt;
			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
				body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "getDatabaseSnapshot", params: { projectId: project.id } }),
				headers: {
					authorization: `Bearer ${bearerToken}`,
					"content-type": "application/json",
					"x-agent-issues-project-identity": projectIdentity
				},
				method: "POST"
			});
			const snapshotBody = await snapshotResponse.text();
			const summaryPayload = JSON.parse(summaryBody) as { error?: unknown; result?: { kind?: string } };
			const snapshotPayload = JSON.parse(snapshotBody) as { error?: unknown; result?: unknown };

			expect(summaryResponse.status).toBe(200);
			expect(snapshotResponse.status).toBe(200);
			expect(summaryPayload).not.toHaveProperty("error");
			expect(summaryPayload.result?.kind).toBe("available");
			expect(snapshotPayload).not.toHaveProperty("error");
			expect(durationMs).toBeLessThan(500);
			expect(Buffer.byteLength(summaryBody)).toBeLessThanOrEqual(Buffer.byteLength(snapshotBody) * 0.2);
		} finally {
			await seedStore.close();
		}
	}, 120_000);
});