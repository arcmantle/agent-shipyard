import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEntity, ensureDatabase } from "@agent-issues/api-local";
import { startLiveSite } from "./server.js";

const TENANT = "project-summary-performance";

let temporaryDirectory: string | null = null;

afterEach(() => {
	if (temporaryDirectory) {
		rmSync(temporaryDirectory, { force: true, recursive: true });
		temporaryDirectory = null;
	}
});

describe("Project Summary performance", () => {
	it("meets response-time and payload-size targets with real SQLite storage", async () => {
		temporaryDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-project-summary-"));
		const workspace = path.join(temporaryDirectory, "large-project");
		const dbPath = path.join(temporaryDirectory, "agent-issues.db");
		const { db, executor } = await ensureDatabase(dbPath, { tenant: TENANT });
		const project = executor.drizzle.transaction(() => {
			const project = createEntity(executor, { kind: "project", title: "Large project" });
			const epic = createEntity(executor, { kind: "epic", parentId: project.id, title: "Delivery" });
			const detailBody = "Detailed project record content. ".repeat(20);
			for (let initiativeIndex = 0; initiativeIndex < 20; initiativeIndex += 1) {
				const initiative = createEntity(executor, { body: detailBody, kind: "initiative", parentId: epic.id, title: `Initiative ${initiativeIndex}` });
				const prd = createEntity(executor, { body: detailBody, kind: "prd", parentId: initiative.id, title: `Requirements ${initiativeIndex}` });
				for (let issueIndex = 0; issueIndex < 20; issueIndex += 1) {
					createEntity(executor, { body: detailBody, kind: "issue", parentId: initiative.id, title: `Issue ${initiativeIndex}-${issueIndex}` });
				}
				for (let storyIndex = 0; storyIndex < 5; storyIndex += 1) {
					createEntity(executor, { body: detailBody, kind: "userStory", parentId: prd.id, title: `Story ${initiativeIndex}-${storyIndex}` });
				}
			}
			return project;
		});
		db.close();

		const previousNoDaemon = process.env.AGENT_ISSUES_NO_DAEMON;
		process.env.AGENT_ISSUES_NO_DAEMON = "1";
		const handle = await startLiveSite({ currentWorkingDirectory: workspace, dbPath, port: 0, tenant: TENANT });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const summaryResponse = await fetch(`http://127.0.0.1:${port}/api/project-summary?tenant=${TENANT}&project=${project.id}`);
			const summaryBody = await summaryResponse.text();
			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?tenant=${TENANT}&project=${project.id}`);
			const snapshotBody = await snapshotResponse.text();
			const durationMs = Number(summaryResponse.headers.get("x-agent-issues-response-duration-ms"));
			const summaryBytes = Number(summaryResponse.headers.get("x-agent-issues-payload-bytes"));
			const snapshotBytes = Buffer.byteLength(snapshotBody);

			expect(summaryResponse.status).toBe(200);
			expect(snapshotResponse.status).toBe(200);
			expect(durationMs).toBeLessThan(500);
			expect(summaryBytes).toBe(Buffer.byteLength(summaryBody));
			expect(summaryBytes).toBeLessThanOrEqual(snapshotBytes * 0.2);
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
			if (previousNoDaemon === undefined) {
				delete process.env.AGENT_ISSUES_NO_DAEMON;
			} else {
				process.env.AGENT_ISSUES_NO_DAEMON = previousNoDaemon;
			}
		}
	}, 15_000);
});