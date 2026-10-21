import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backfillBodies } from "./body-backfill.js";
import { createEntity, ensureDatabase, getDatabaseSnapshot, linkEntities, SqliteStore } from "@agent-issues/api-local";

let tempDir: string | null = null;
let database: { close(): void } | null = null;

async function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backfill-"));
	const result = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	database = result.db;
	return result.executor;
}

afterEach(() => {
	database?.close();
	database = null;
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("body backfill", () => {
	it("fills empty initiative, issue, PRD, and user story bodies with their recipes", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = await backfillBodies(new SqliteStore(db), { kinds: ["initiative", "issue", "prd", "userStory"] });
		const snapshot = getDatabaseSnapshot(db);
		const reloadedInitiative = snapshot.entities.find((entity) => entity.id === initiative.id);
		const reloadedIssue = snapshot.entities.find((entity) => entity.id === issue.id);
		const reloadedPrd = snapshot.entities.find((entity) => entity.id === prd.id);
		const reloadedStory = snapshot.entities.find((entity) => entity.id === story.id);

		expect(result.updated).toBe(4);
		expect(reloadedInitiative?.body).toContain("## Purpose");
		expect(reloadedInitiative?.body).toContain("## Scope");
		expect(reloadedInitiative?.body).toContain("## Success Conditions");
		expect(reloadedInitiative?.body).toContain("## Non-Goals");
		expect(reloadedInitiative?.bodySource).toBe("generated");
		expect(reloadedInitiative?.body).toContain("Not derived from tracker metadata.");
		expect(reloadedIssue?.body).toContain("## Work Mode");
		expect(reloadedIssue?.body).toContain("## Outcome");
		expect(reloadedIssue?.body).toContain("## Work Plan");
		expect(reloadedIssue?.body).toContain("## Acceptance Criteria");
		expect(reloadedIssue?.body).toContain("## Verification");
		expect(reloadedIssue?.body).toContain("## Notes");
		expect(reloadedIssue?.bodySource).toBe("generated");
		expect(reloadedIssue?.body).toContain("Not derived from tracker metadata.");
		expect(reloadedPrd?.body).toContain("## Problem Statement");
		expect(reloadedPrd?.body).toContain("## Solution");
		expect(reloadedPrd?.body).not.toContain("## User Stories");
		expect(reloadedPrd?.body).toContain("## Implementation Decisions");
		expect(reloadedPrd?.body).toContain("## Testing Decisions");
		expect(reloadedPrd?.body).toContain("## Out of Scope");
		expect(reloadedPrd?.body).toContain("## Further Notes");
		expect(reloadedPrd?.bodySource).toBe("generated");
		expect(reloadedPrd?.body).toContain("Not derived from tracker metadata.");
		expect(reloadedStory?.body).toContain("As an actor, I want Not derived from tracker metadata.");
		expect(reloadedStory?.body).toContain("## Acceptance Criteria");
		expect(reloadedStory?.body).toContain("## Boundaries");
		expect(reloadedStory?.bodySource).toBe("generated");
		expect(reloadedStory?.body).toContain("Not derived from tracker metadata.");
	});

	it("backfills a project with the project recipe and derived-content markers", async () => {
		const db = await openTestDatabase();
		const store = new SqliteStore(db);
		const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project");
		if (!project) {
			throw new Error("Test database must contain an active project.");
		}

		const result = await backfillBodies(store, { kinds: ["project"] });
		const body = (await store.getEntityDetails(project.id)).entity.body;

		expect(result.updated).toBe(1);
		expect(body).toContain("## Purpose");
		expect(body).toContain("## Scope");
		expect(body).toContain("## Success Conditions");
		expect(body).toContain("## Non-Goals");
		expect(body).toContain("Not derived from tracker metadata.");
	});

	it("backfills an epic with the epic recipe and derived-content markers", async () => {
		const db = await openTestDatabase();
		const store = new SqliteStore(db);
		const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project");
		if (!project) {
			throw new Error("Test database must contain an active project.");
		}
		const epic = createEntity(db, { kind: "epic", parentId: project.id, title: "Console Work" });

		const result = await backfillBodies(store, { kinds: ["epic"] });
		const body = (await store.getEntityDetails(epic.id)).entity.body;

		expect(result.updated).toBeGreaterThanOrEqual(1);
		expect(body).toContain("## Purpose");
		expect(body).toContain("## Scope");
		expect(body).toContain("## Success Conditions");
		expect(body).toContain("## Non-Goals");
		expect(body).toContain("Not derived from tracker metadata.");
	});

	it("backfills a version with the version recipe and derived-content markers", async () => {
		const db = await openTestDatabase();
		const store = new SqliteStore(db);
		const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project");
		if (!project) {
			throw new Error("Test database must contain an active project.");
		}
		const version = createEntity(db, { kind: "version", parentId: project.id, title: "1.0.0" });

		const result = await backfillBodies(store, { kinds: ["version"] });
		const body = (await store.getEntityDetails(version.id)).entity.body;

		expect(result.updated).toBe(1);
		expect(body).toContain("## Release Intent");
		expect(body).toContain("## Compatibility and Migration Notes");
		expect(body).toContain("Not derived from tracker metadata.");
	});

	it("does not overwrite existing bodies unless force is enabled", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, {
			kind: "issue",
			parentId: initiative.id,
			title: "Render detail pane",
			body: "Existing authored issue body."
		});

		const first = await backfillBodies(new SqliteStore(db), { kinds: ["issue"] });
		let snapshot = getDatabaseSnapshot(db);
		expect(first.updated).toBe(0);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("Existing authored issue body.");

		const second = await backfillBodies(new SqliteStore(db), { force: true, kinds: ["issue"] });
		snapshot = getDatabaseSnapshot(db);
		expect(second.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).not.toBe("Existing authored issue body.");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toContain("## Work Mode");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("generated");
	});

	it("reclassifies legacy generated bodies without overwriting authored prose", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });

		const first = await backfillBodies(new SqliteStore(db), { kinds: ["issue"] });
		expect(first.updated).toBe(1);

		// Recreate a legacy row: the body backfill generated is still there, but
		// marked `authored` the way rows written before body-source tracking are.
		// Done through the seam rather than raw SQL - the CLI is a storage-driver
		// client and has no business reaching past it into the ORM.
		const legacyStore = new SqliteStore(db);
		const generated = (await legacyStore.getEntityDetails(issue.id)).entity;
		await legacyStore.setEntityBody({
			entityId: issue.id,
			body: generated.body,
			bodySource: "authored",
			expectedRevision: generated.revision,
			expectedContentHash: generated.contentHash
		});

		const legacySnapshot = getDatabaseSnapshot(db);
		const legacyIssue = legacySnapshot.entities.find((entity) => entity.id === issue.id);
		expect(legacyIssue?.bodySource).toBe("authored");

		const second = await backfillBodies(new SqliteStore(db), { kinds: ["issue"] });
		const snapshot = getDatabaseSnapshot(db);
		expect(second.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("generated");
	});

	it("supports filtering by kind", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = await backfillBodies(new SqliteStore(db), { kinds: ["userStory"] });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.body).toContain("## Acceptance Criteria");
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.bodySource).toBe("generated");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
	});

	it("supports filtering initiative backfills by kind", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });

		const result = await backfillBodies(new SqliteStore(db), { kinds: ["initiative"] });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.updated).toBe(1);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toContain("## Purpose");
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toContain("## Success Conditions");
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.bodySource).toBe("generated");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
	});

	it("backfills ADR bodies with the ADR recipe and derived-content markers", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const olderAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use HTML templates" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use deterministic SVG graphs" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship the graph" });
		linkEntities(db, { fromId: adr.id, relationType: "constrains", toId: issue.id });
		linkEntities(db, { fromId: adr.id, relationType: "supersedes", toId: olderAdr.id });

		const result = await backfillBodies(new SqliteStore(db), { kinds: ["adr"] });
		const snapshot = getDatabaseSnapshot(db);
		const reloadedAdr = snapshot.entities.find((entity) => entity.id === adr.id);

		expect(result.updated).toBe(2);
		expect(reloadedAdr?.body).toContain("## Status");
		expect(reloadedAdr?.body).toContain("## Context");
		expect(reloadedAdr?.body).toContain("## Decision");
		expect(reloadedAdr?.body).toContain("## Consequences");
		expect(reloadedAdr?.bodySource).toBe("generated");
		expect(reloadedAdr?.body).toContain("Not derived from tracker metadata.");
	});

	it("reports updates during dry-run without mutating stored bodies", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail pane" });
		linkEntities(db, { fromId: issue.id, relationType: "fixes", toId: story.id });

		const result = await backfillBodies(new SqliteStore(db), { dryRun: true });
		const snapshot = getDatabaseSnapshot(db);

		expect(result.dryRun).toBe(true);
		expect(result.updated).toBe(6);
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === initiative.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === issue.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === prd.id)?.bodySource).toBe("authored");
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.body).toBe("");
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.bodySource).toBe("authored");
	});
});