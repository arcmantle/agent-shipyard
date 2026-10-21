import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveMigratedEntityIdentity, PlanEntryConflictError } from "@agent-issues/core";
import { ensureDatabase } from "../../db/database.js";
import type { SqliteInternalConnection } from "../../db/sqlite-executor.js";
import { createIssueComment } from "../issue-comment/store.js";
import { createPlanEntry, deletePlanEntry, listPlanEntries, listPlanEntryHistory, updatePlanEntry } from "../plan-entry/store.js";
import { createEntity, deleteEntity, getDatabaseSnapshot, getEntityDetails, getInitiativeBundle, linkEntities, listAllRelations, listEntities, listEntityHistory, listOrphans, materializeEntityRevision, moveEntity, restoreEntityRevision, setEntityBody, unlinkEntities, updateEntity, updateEntityStatus } from "./store.js";

const CANONICAL_ID_SUFFIX = "_[0-7][0-9A-HJKMNP-TV-Z]{25}";
const DEFAULT_PROJECT_STABLE_ID = deriveMigratedEntityIdentity("project", "PROJ0").stableId;
const DEFAULT_EPIC_STABLE_ID = deriveMigratedEntityIdentity("epic", "EPIC0").stableId;

function statusOf(db: SqliteInternalConnection, entityId: string): string {
	return getEntityDetails(db, entityId).entity.status;
}

let tempDir: string | null = null;

async function openTestDatabase(): Promise<SqliteInternalConnection> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-store-"));
	const { executor } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
	return executor;
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}
});

describe("kind-specific entity types", () => {
	it("stores typed Pioneer issues and rejects invalid kinds and parents", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Pioneer work" });
		const ordinaryIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ordinary issue" });
		const map = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Pioneer map", type: "pioneer-map" });
		const ticket = createEntity(db, { kind: "issue", parentId: map.id, title: "Pioneer ticket", type: "pioneer-ticket" });

		expect(ordinaryIssue.type).toBeNull();
		expect(map.type).toBe("pioneer-map");
		expect(ticket.type).toBe("pioneer-ticket");
		expect(() => createEntity(db, { kind: "initiative", title: "Invalid specialized kind", type: "pioneer-map" })).toThrow("Invalid entity type: pioneer-map");
		expect(() => createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ticket without map", type: "pioneer-ticket" })).toThrow("pioneer-ticket requires a pioneer-map parent.");
		expect(() => updateEntity(db, { entityId: ordinaryIssue.id, type: "pioneer-ticket", expectedRevision: ordinaryIssue.revision, expectedContentHash: ordinaryIssue.contentHash })).toThrow("pioneer-ticket requires a pioneer-map parent.");
		expect(() => updateEntity(db, { entityId: map.id, type: null, expectedRevision: map.revision, expectedContentHash: map.contentHash })).toThrow("Cannot remove pioneer-map type while it has pioneer-ticket children.");
		expect(() => moveEntity(db, { entityId: map.id, newParentId: ordinaryIssue.id })).toThrow("pioneer-map requires an initiative parent.");
		expect(() => moveEntity(db, { entityId: ticket.id, newParentId: ordinaryIssue.id })).toThrow("pioneer-ticket requires a pioneer-map parent.");

		const restorableMap = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Restorable map", type: "pioneer-map" });
		const removedType = updateEntity(db, { entityId: restorableMap.id, type: null, expectedRevision: restorableMap.revision, expectedContentHash: restorableMap.contentHash });
		const restored = restoreEntityRevision(db, { entityId: restorableMap.id, revision: 1, expectedRevision: removedType.revision, expectedContentHash: removedType.contentHash });
		expect(restored.type).toBe("pioneer-map");
		expect(getEntityDetails(db, restorableMap.id).entity.type).toBe("pioneer-map");
	});
});

describe("issue comments", () => {
	it("does not reject a comment because an unrelated legacy Plan has no Initiative parent", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Plan owner" });
		const plan = createEntity(db, { kind: "plan", parentId: initiative.id, title: "Legacy Plan" });
		const issue = createEntity(db, { kind: "issue", title: "Comment target" });
		db.drizzle.run(sql`DELETE FROM relations WHERE tenant_id = ${db.tenantId} AND from_id = ${initiative.id} AND to_id = ${plan.id} AND type = 'owns'`);

		expect(createIssueComment(db, { issueId: issue.reference, body: "Valid comment." }, "author")).toMatchObject({ issueId: issue.id, body: "Valid comment." });
	});
});

describe("project-scoped ADRs", () => {
	it("exposes a parentless ADR as a project-scoped ADR in the snapshot", async () => {
		const db = await openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).toContain(adr.id);
	});

	it("keeps project-scoped ADRs out of the orphan list", async () => {
		const db = await openTestDatabase();
		const adr = createEntity(db, { kind: "adr", title: "Use deterministic SVG graphs" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.orphans.map((entity) => entity.id)).not.toContain(adr.id);
		expect(listOrphans(db).map((entity) => entity.id)).not.toContain(adr.id);
	});

	it("does not treat an initiative-recorded ADR as project-scoped", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const recordedAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Adopt signals" });

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.projectAdrs.map((entity) => entity.id)).not.toContain(recordedAdr.id);
	});

	it("includes project and epic ADRs in the project snapshot", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Console" });
		const epic = createEntity(db, { kind: "epic", parentId: project.id, title: "Viewer" });
		const projectAdr = createEntity(db, { kind: "adr", parentId: project.id, title: "Use signals" });
		const epicAdr = createEntity(db, { kind: "adr", parentId: epic.id, title: "Use Lit" });

		const result = getDatabaseSnapshot(db, { projectId: project.id });
		if (result.kind === "unavailable") {
			throw new Error("Expected project snapshot to be available.");
		}

		expect(result.snapshot.projectAdrs.map((entity) => entity.id)).toEqual(expect.arrayContaining([projectAdr.id, epicAdr.id]));
	});
});
describe("database snapshot issue conversations", () => {
	it("includes an issue's newest comment page", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Discuss snapshot data" });
		const comment = createIssueComment(db, { issueId: issue.id, body: "Show this comment in the site." }, "test-user");

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot).toMatchObject({
			issueComments: {
				[issue.id]: {
					comments: [expect.objectContaining({ id: comment.id, body: "Show this comment in the site." })],
					nextBefore: null,
					total: 1
				}
			}
		});
	});
});

describe("database snapshot Plan entries", () => {
	it("does not append history when guarded Plan-entry writes affect no rows", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Plan owner" });
		const plan = createEntity(db, { kind: "plan", parentId: initiative.id, title: "Concurrent Plan" });
		const updatedEntry = createPlanEntry(db, { planId: plan.id, role: "question", body: "Initial question" }, "test-user");
		const updateRun = vi.spyOn(db.drizzle, "run").mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

		expect(() => updatePlanEntry(db, {
			entryId: updatedEntry.id,
			body: "Updated question",
			expectedRevision: updatedEntry.revision,
			expectedContentHash: updatedEntry.contentHash
		}, "test-user")).toThrow(PlanEntryConflictError);
		updateRun.mockRestore();
		expect(listPlanEntryHistory(db, { entryId: updatedEntry.id })).toHaveLength(1);

		const deletedEntry = createPlanEntry(db, { planId: plan.id, role: "question", body: "Deleted question" }, "test-user");
		const deleteRun = vi.spyOn(db.drizzle, "run").mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });

		expect(() => deletePlanEntry(db, {
			entryId: deletedEntry.id,
			expectedRevision: deletedEntry.revision,
			expectedContentHash: deletedEntry.contentHash
		}, "test-user")).toThrow(PlanEntryConflictError);
		deleteRun.mockRestore();
		expect(listPlanEntryHistory(db, { entryId: deletedEntry.id })).toHaveLength(1);
	});

	it("preserves creation order when entries are created in the same clock tick", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
		try {
			const db = await openTestDatabase();
			const initiative = createEntity(db, { kind: "initiative", title: "Plan owner" });
			const plan = createEntity(db, { kind: "plan", parentId: initiative.id, title: "Ordered Plan" });
			const first = createPlanEntry(db, { planId: plan.id, role: "question", body: "First entry" }, "test-user");
			const second = createPlanEntry(db, { planId: plan.id, role: "question", body: "Second entry" }, "test-user");

			expect(listPlanEntries(db, { planId: plan.id }).map((entry) => entry.id)).toEqual([first.id, second.id]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("includes active, superseded, and tombstoned entries for each scoped Plan", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Plan owner" });
		const plan = createEntity(db, { kind: "plan", parentId: initiative.id, title: "Snapshot Plan" });
		const question = createPlanEntry(db, { planId: plan.id, role: "question", body: "Which entries are visible?" }, "test-user");
		const decision = createPlanEntry(db, { planId: plan.id, role: "decision", body: "All entries remain in history.", supersededEntryIds: [question.id] }, "test-user");
		const deleted = createPlanEntry(db, { planId: plan.id, role: "consideration", body: "Keep tombstones.", }, "test-user");
		deletePlanEntry(db, { entryId: deleted.id, expectedRevision: deleted.revision, expectedContentHash: deleted.contentHash }, "test-user");

		const snapshot = getDatabaseSnapshot(db);

		expect(snapshot.planEntries).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: question.id, supersededEntryIds: [] }),
			expect.objectContaining({ id: decision.id, supersededEntryIds: [question.id] }),
			expect.objectContaining({ id: deleted.id, tombstone: true })
		]));
	});
});

describe("tombstoned entity reads", () => {
	it("excludes tombstoned related entities from details and initiative bundles", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Live initiative" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Deleted issue" });
		const subIssue = createEntity(db, { kind: "issue", parentId: issue.id, title: "Hidden descendant" });

		db.drizzle.run(sql`UPDATE entities SET tombstone = TRUE WHERE tenant_id = ${db.tenantId} AND id = ${issue.id}`);

		expect(getEntityDetails(db, initiative.id).outgoing).toEqual([]);
		expect(getInitiativeBundle(db, initiative.id).entities.map((entity) => entity.id)).not.toContain(issue.id);
		expect(getInitiativeBundle(db, initiative.id).entities.map((entity) => entity.id)).not.toContain(subIssue.id);
		expect(listAllRelations(db)).not.toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: issue.id }));
	});
});

describe("project scoping (ISS166)", () => {
	it("scopes list and snapshot to the workspace's resolved project", async () => {
		const db = await openTestDatabase();
		// Lives in the tenant's default sentinel project (PROJ0).
		const defaultIssue = createEntity(db, { kind: "issue", title: "Default project issue" });

		// A second project, fully populated through the structural chain.
		const project = createEntity(db, { kind: "project", title: "Second Project" });
		const epic = createEntity(db, { kind: "epic", parentId: project.id, title: "Second Epic" });
		const initiative = createEntity(db, { kind: "initiative", parentId: epic.id, title: "Second Initiative" });
		const scopedIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Second issue" });

		// Resolve this invocation to the second project (normally derived from cwd).
		db.currentProjectId = project.id;

		const issueIds = listEntities(db, "issue").map((entity) => entity.id);
		expect(issueIds).toContain(scopedIssue.id);
		expect(issueIds).not.toContain(defaultIssue.id);

		const snapshotIds = getDatabaseSnapshot(db).entities.map((entity) => entity.id);
		expect(snapshotIds).toEqual(expect.arrayContaining([project.id, epic.id, initiative.id, scopedIssue.id]));
		expect(snapshotIds).not.toContain(defaultIssue.id);
		expect(snapshotIds).not.toContain("PROJ0");
	});

	it("attaches a parentless orphan issue to the current project so it stays scoped there", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Second Project" });
		db.currentProjectId = project.id;

		const orphan = createEntity(db, { kind: "issue", title: "Loose issue" });
		expect(listEntities(db, "issue").map((entity) => entity.id)).toContain(orphan.id);

		// The same orphan must not bleed into the default project's scope.
		db.currentProjectId = "PROJ0";
		expect(listEntities(db, "issue").map((entity) => entity.id)).not.toContain(orphan.id);
	});
});

describe("record bodies", () => {
	it("keeps one edited entity's history valid when relation replay changes parent ordering", async () => {
		const db = await openTestDatabase();
		const canonicalParent = createEntity(db, { kind: "initiative", title: "Canonical parent" });
		const annotationParent = createEntity(db, { kind: "initiative", title: "Structural annotation" });
		const issue = createEntity(db, { kind: "issue", parentId: canonicalParent.id, title: "Editable issue" });

		const edited = setEntityBody(db, {
			entityId: issue.id,
			body: "Edited once.",
			expectedRevision: issue.revision,
			expectedContentHash: issue.contentHash
		});
		db.drizzle.run(sql`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
			VALUES (${db.tenantId}, ${annotationParent.id}, ${issue.id}, 'tracks', '1900-01-01T00:00:00.000Z')`);

		expect(listEntityHistory(db, issue.id)).toEqual([
			expect.objectContaining({ version: 1, parentId: canonicalParent.id }),
			expect.objectContaining({ version: edited.revision, parentId: canonicalParent.id, body: "Edited once." })
		]);
		expect(materializeEntityRevision(db, { entityId: issue.id, revision: 1 })).toMatchObject({
			parentId: canonicalParent.id,
			body: ""
		});
	});

	it("persists and returns the authored body when creating an entity", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, {
			kind: "issue",
			title: "Add body column",
			body: "# Heading\n\nSome **authored** markdown."
		});

		expect(issue.body).toBe("# Heading\n\nSome **authored** markdown.");
		expect(issue.bodySource).toBe("authored");

		const reloaded = getEntityDetails(db, issue.id);
		expect(reloaded.entity.body).toBe("# Heading\n\nSome **authored** markdown.");
		expect(reloaded.entity.bodySource).toBe("authored");
	});

	it("defaults the body to an empty string when none is provided", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "No body" });

		expect(issue.body).toBe("");
		expect(issue.bodySource).toBe("authored");
	});

	it("updates the authored body of an existing entity", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Editable" });

		const updated = setEntityBody(db, { entityId: issue.id, body: "## Rewritten body", expectedRevision: issue.revision, expectedContentHash: issue.contentHash });

		expect(updated.body).toBe("## Rewritten body");
		expect(updated.bodySource).toBe("authored");
		expect(getEntityDetails(db, issue.id).entity.body).toBe("## Rewritten body");
		expect(getEntityDetails(db, issue.id).entity.bodySource).toBe("authored");
	});

	it("clears the authored body when set to an empty string", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Clearable", body: "Original body" });

		const cleared = setEntityBody(db, { entityId: issue.id, body: "", expectedRevision: issue.revision, expectedContentHash: issue.contentHash });

		expect(cleared.body).toBe("");
		expect(cleared.bodySource).toBe("authored");
		expect(getEntityDetails(db, issue.id).entity.body).toBe("");
		expect(getEntityDetails(db, issue.id).entity.bodySource).toBe("authored");
	});
});

describe("handoff graph entities", () => {
	it("uses generic entity operations for handoff lifecycle", async () => {
		const db = await openTestDatabase();
		const focus = createEntity(db, { kind: "initiative", title: "Migrate handoffs" });

		const handoff = createEntity(db, {
			kind: "handoff",
			title: "Resume migration",
			body: "Move legacy rows into graph entities.",
			links: [{ relationType: "handsOff", targetId: focus.id }]
		});

		expect(handoff.reference).toMatch(new RegExp(`^HO${CANONICAL_ID_SUFFIX}$`));
		expect(listEntities(db, "handoff")).toEqual([expect.objectContaining({ id: handoff.id })]);
		expect(getEntityDetails(db, handoff.id).outgoing).toEqual([
			expect.objectContaining({ relationType: "handsOff", entity: expect.objectContaining({ id: focus.id }) })
		]);
		expect(materializeEntityRevision(db, { entityId: handoff.id, revision: 1 })).toMatchObject({
			title: "Resume migration",
			body: "Move legacy rows into graph entities.",
			targetRevision: 1
		});

		deleteEntity(db, { entityId: focus.id });
		expect(() => getEntityDetails(db, handoff.id)).toThrow(/not found/i);
		expect(materializeEntityRevision(db, { entityId: handoff.id, revision: 1 })).toMatchObject({
			targetRevision: 1,
			headRevision: 2,
			tombstone: false
		});
	});
});

describe("derived user story status", () => {
		function seedStoryWithIssues(db: SqliteInternalConnection, issueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });

		const issues = issueStatuses.map((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
			return issue;
		});

		return { initiative, prd, story, issues };
	}

	it("derives done when every fixing issue is done", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "done"]);

		expect(statusOf(db, story.id)).toBe("done");
	});

	it("derives in-progress when some but not all fixing issues are done", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["done", "todo"]);

		expect(statusOf(db, story.id)).toBe("in-progress");
	});

	it("derives ready when fixing issues exist but none have started", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo", "todo"]);

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("keeps the stored status when the story has no fixing issues", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Unlinked", status: "ready" });

		expect(statusOf(db, story.id)).toBe("ready");
	});

	it("surfaces the derived status in the snapshot, list, and initiative bundle", async () => {
		const db = await openTestDatabase();
		const { initiative, story } = seedStoryWithIssues(db, ["done", "done"]);

		const snapshot = getDatabaseSnapshot(db);
		expect(snapshot.entities.find((entity) => entity.id === story.id)?.status).toBe("done");

		const listed = listEntities(db, "userStory").find((entity) => entity.id === story.id);
		expect(listed?.status).toBe("done");

		const bundle = getInitiativeBundle(db, initiative.id);
		expect(bundle.userStories.find((entity) => entity.id === story.id)?.status).toBe("done");
	});

	it("rejects manually setting the status of a story that has fixing issues", async () => {
		const db = await openTestDatabase();
		const { story } = seedStoryWithIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: story.id, status: "done" })).toThrow(/derived/i);
	});
});

describe("derived initiative status", () => {
	it("derives done when every tracked issue is done and every owned PRD is approved", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		updateEntityStatus(db, { entityId: prd.id, status: "approved" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "done" });

		expect(statusOf(db, initiative.id)).toBe("done");
	});
	it("keeps the stored status while tracked issues remain open", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("promotes a draft initiative to active once a tracked issue starts", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		expect(statusOf(db, initiative.id)).toBe("draft");

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("promotes a draft initiative to active once an owned PRD starts", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("active");
	});

	it("does not promote a draft initiative while its tracked issues and owned PRDs are all still untouched", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });
		createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });

		expect(statusOf(db, initiative.id)).toBe("draft");
	});

	it("leaves a manually paused initiative paused even once a tracked issue starts (pausing stays a human decision)", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "paused" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });

		updateEntityStatus(db, { entityId: issue.id, status: "in-progress" });

		expect(statusOf(db, initiative.id)).toBe("paused");
	});

	it("rejects manually marking an initiative done while tracked issues remain open", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship it" });

		expect(() => updateEntityStatus(db, { entityId: initiative.id, status: "done" })).toThrow(/tracked issues/i);
	});
});

describe("derived PRD status cascade", () => {
		function seedPrdWithStory(db: SqliteInternalConnection, fixingIssueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "See a record" });
		fixingIssueStatuses.forEach((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
		});
		return { initiative, prd, story };
	}

	it("derives approved when every created story is done", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["done"]);

		expect(statusOf(db, prd.id)).toBe("approved");
	});

	it("derives in-progress when a created story is in progress", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["in-progress"]);

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("keeps the stored status while created stories exist but none have started", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(statusOf(db, prd.id)).toBe("draft");
	});

	it("keeps the stored status when the PRD has no created stories", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Empty", status: "in-progress" });

		expect(statusOf(db, prd.id)).toBe("in-progress");
	});

	it("rejects manually setting any status on a PRD that has created stories", async () => {
		const db = await openTestDatabase();
		const { prd } = seedPrdWithStory(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "approved" })).toThrow(/derived/i);
		expect(() => updateEntityStatus(db, { entityId: prd.id, status: "in-progress" })).toThrow(/derived/i);
	});

	it("cascades issue completion up to the initiative through stories and PRDs", async () => {
		const db = await openTestDatabase();
		const { initiative, prd, story } = seedPrdWithStory(db, ["done", "done"]);

		expect(statusOf(db, story.id)).toBe("done");
		expect(statusOf(db, prd.id)).toBe("approved");
		expect(statusOf(db, initiative.id)).toBe("done");
	});
});

describe("ADR status", () => {
		function seedAdrConstrainingIssues(db: SqliteInternalConnection, issueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use SQLite" });
		const issues = issueStatuses.map((status, index) => {
			const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: `Slice ${index + 1}` });
			linkEntities(db, { fromId: adr.id, toId: issue.id, relationType: "constrains" });
			if (status !== "todo") {
				updateEntityStatus(db, { entityId: issue.id, status });
			}
			return issue;
		});
		return { initiative, adr, issues };
	}

	it("creates an ADR with current status", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const adr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Use SQLite" });

		expect(statusOf(db, adr.id)).toBe("current");
	});

	it("keeps current when a constrained issue is in progress", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["in-progress"]);

		expect(statusOf(db, adr.id)).toBe("current");
	});

	it("keeps current when a constrained issue is done", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["done"]);

		expect(statusOf(db, adr.id)).toBe("current");
	});

	it("accepts setting current on an ADR that constrains issues", async () => {
		const db = await openTestDatabase();
		const { adr } = seedAdrConstrainingIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: adr.id, status: "current" })).not.toThrow();
	});

	it("derives superseded when another ADR supersedes it", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(statusOf(db, oldAdr.id)).toBe("superseded");
	});

	it("rejects manually setting the status of an ADR that has been superseded", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const oldAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "Old decision" });
		const newAdr = createEntity(db, { kind: "adr", parentId: initiative.id, title: "New decision" });
		linkEntities(db, { fromId: newAdr.id, toId: oldAdr.id, relationType: "supersedes" });

		expect(() => updateEntityStatus(db, { entityId: oldAdr.id, status: "current" })).toThrow(/superseded/i);
	});

	it("derives PRD and user-story supersession from replacement relations", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "History" });
		const oldPrd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Snapshot history" });
		const newPrd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Reverse-delta history" });
		const oldStory = createEntity(db, { kind: "userStory", parentId: oldPrd.id, title: "Store snapshots" });
		const newStory = createEntity(db, { kind: "userStory", parentId: newPrd.id, title: "Store reverse deltas" });

		linkEntities(db, { fromId: newPrd.id, toId: oldPrd.id, relationType: "supersedes" });
		linkEntities(db, { fromId: newStory.id, toId: oldStory.id, relationType: "supersedes" });

		expect(statusOf(db, oldPrd.id)).toBe("superseded");
		expect(statusOf(db, oldStory.id)).toBe("superseded");
		expect(() => updateEntityStatus(db, { entityId: newPrd.id, status: "superseded" })).toThrow(/link a replacement/i);
		expect(() => updateEntityStatus(db, { entityId: oldPrd.id, status: "draft" })).toThrow(/superseded/i);
		expect(() => updateEntityStatus(db, { entityId: oldStory.id, status: "draft" })).toThrow(/superseded/i);
	});
});

describe("derived issue status from sub-issues", () => {
		function seedIssueWithSubIssues(db: SqliteInternalConnection, subIssueStatuses: string[]) {
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const parentIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship the parent workflow" });
		const subIssues = subIssueStatuses.map((status, index) => {
			const subIssue = createEntity(db, {
				kind: "issue",
				parentId: parentIssue.id,
				title: `Sub-issue ${index + 1}`
			});

			if (status !== "todo") {
				updateEntityStatus(db, { entityId: subIssue.id, status });
			}

			return subIssue;
		});

		return { initiative, parentIssue, subIssues };
	}

	it("derives blocked while any sub-issue remains open", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["done", "todo"]);

		expect(statusOf(db, parentIssue.id)).toBe("blocked");
	});

	it("returns to todo once every sub-issue is done", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["done", "done"]);

		expect(statusOf(db, parentIssue.id)).toBe("todo");
	});

	it("counts nested issues when deriving initiative completion", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", status: "active" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse records" });
		const parentIssue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Ship parent issue" });
		const subIssue = createEntity(db, { kind: "issue", parentId: parentIssue.id, title: "Ship sub-issue" });

		updateEntityStatus(db, { entityId: prd.id, status: "approved" });
		updateEntityStatus(db, { entityId: subIssue.id, status: "done" });

		expect(statusOf(db, parentIssue.id)).toBe("todo");
		expect(statusOf(db, initiative.id)).toBe("active");

		updateEntityStatus(db, { entityId: parentIssue.id, status: "done" });

		expect(statusOf(db, initiative.id)).toBe("done");
	});

	it("rejects moving a parent issue forward while sub-issues remain open", async () => {
		const db = await openTestDatabase();
		const { parentIssue } = seedIssueWithSubIssues(db, ["todo"]);

		expect(() => updateEntityStatus(db, { entityId: parentIssue.id, status: "in-progress" })).toThrow(/sub-issues remain open/i);
		expect(() => updateEntityStatus(db, { entityId: parentIssue.id, status: "done" })).toThrow(/sub-issues remain open/i);
	});

	it("does not treat a tombstoned sub-issue as open", async () => {
		const db = await openTestDatabase();
		const { parentIssue, subIssues } = seedIssueWithSubIssues(db, ["todo"]);

		db.drizzle.run(sql`UPDATE entities SET tombstone = TRUE WHERE tenant_id = ${db.tenantId} AND id = ${subIssues[0]!.id}`);

		expect(updateEntityStatus(db, { entityId: parentIssue.id, status: "in-progress" }).entity.status).toBe("in-progress");
	});

	it("includes nested sub-issues in the initiative bundle", async () => {
		const db = await openTestDatabase();
		const { initiative, parentIssue, subIssues } = seedIssueWithSubIssues(db, ["todo", "todo"]);

		const bundle = getInitiativeBundle(db, initiative.id);

		expect(bundle.issues.map((issue) => issue.id)).toEqual([parentIssue.id, ...subIssues.map((issue) => issue.id)].sort());
		expect(bundle.subIssueLinks).toEqual(
			subIssues.toSorted((left, right) => left.id.localeCompare(right.id)).map((issue) => ({
				parent: expect.objectContaining({ id: parentIssue.id }),
				issue: expect.objectContaining({ id: issue.id })
			}))
		);
	});
});

describe("project and epic tiers", () => {
	it("attaches a parentless initiative to the tenant's default project and epic", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments platform" });

		const initiativeDetails = getEntityDetails(db, initiative.id);
		const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.reference).toMatch(new RegExp(`^EPIC${CANONICAL_ID_SUFFIX}$`));
		expect(epicParent?.entity.kind).toBe("epic");

		const epicDetails = getEntityDetails(db, DEFAULT_EPIC_STABLE_ID);
		expect(epicDetails.entity.id).toBe(epicParent?.entity.id);
		const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(projectParent?.entity.reference).toMatch(new RegExp(`^PROJ${CANONICAL_ID_SUFFIX}$`));
		expect(projectParent?.entity.kind).toBe("project");
		expect(getEntityDetails(db, DEFAULT_PROJECT_STABLE_ID).entity.id).toBe(projectParent?.entity.id);
	});

	it("creates an explicit project -> epic -> initiative chain through the generic create path", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Platform" });
		const epic = createEntity(db, { kind: "epic", title: "Checkout revamp", parentId: project.id });
		const initiative = createEntity(db, { kind: "initiative", title: "Checkout redesign", parentId: epic.id });

		const epicDetails = getEntityDetails(db, epic.id);
		const projectParent = epicDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(projectParent?.entity.id).toBe(project.id);
		expect(projectParent?.entity.kind).toBe("project");

		const initiativeDetails = getEntityDetails(db, initiative.id);
		const epicParent = initiativeDetails.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.id).toBe(epic.id);
		expect(epicParent?.entity.kind).toBe("epic");
	});

	it("moves an initiative from one epic to another", async () => {
		const db = await openTestDatabase();
		const sourceEpic = createEntity(db, { kind: "epic", title: "Source epic", parentId: DEFAULT_PROJECT_STABLE_ID });
		const targetEpic = createEntity(db, { kind: "epic", title: "Target epic", parentId: DEFAULT_PROJECT_STABLE_ID });
		const initiative = createEntity(db, { kind: "initiative", title: "Nomadic initiative", parentId: sourceEpic.id });

		const result = moveEntity(db, { entityId: initiative.id, newParentId: targetEpic.id });
		expect(result.previousParentId).toBe(sourceEpic.id);
		expect(result.newParentId).toBe(targetEpic.id);
		expect(result.relationType).toBe("contains");

		const details = getEntityDetails(db, initiative.id);
		const epicParent = details.incoming.find((entry) => entry.relationType === "contains");
		expect(epicParent?.entity.id).toBe(targetEpic.id);
	});

	it("blocks unlinking an initiative's sole remaining epic parent", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Anchored initiative" });
		const canonicalEpicId = getEntityDetails(db, DEFAULT_EPIC_STABLE_ID).entity.id;

		expect(() => unlinkEntities(db, { fromId: DEFAULT_EPIC_STABLE_ID, toId: initiative.id, relationType: "contains" })).toThrow(
			/only remaining structural parent/
		);

		const details = getEntityDetails(db, initiative.id);
		expect(details.incoming.some((entry) => entry.relationType === "contains" && entry.entity.id === canonicalEpicId)).toBe(true);
	});

	it("blocks unlinking an epic's sole remaining project parent", async () => {
		const db = await openTestDatabase();
		const canonicalProjectId = getEntityDetails(db, DEFAULT_PROJECT_STABLE_ID).entity.id;

		expect(() => unlinkEntities(db, { fromId: DEFAULT_PROJECT_STABLE_ID, toId: DEFAULT_EPIC_STABLE_ID, relationType: "contains" })).toThrow(
			/only remaining structural parent/
		);

		const details = getEntityDetails(db, DEFAULT_EPIC_STABLE_ID);
		expect(details.incoming.some((entry) => entry.relationType === "contains" && entry.entity.id === canonicalProjectId)).toBe(true);
	});

	it("never lists the default project or epic as orphans", async () => {
		const db = await openTestDatabase();

		const orphanIds = listOrphans(db).map((entity) => entity.id);
		expect(orphanIds).not.toContain("PROJ0");
		expect(orphanIds).not.toContain("EPIC0");
	});
});

describe("version as first-class entity", () => {
	it("creates a version entity with its own id prefix and status flow", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });

		expect(version.reference).toMatch(new RegExp(`^VER${CANONICAL_ID_SUFFIX}$`));
		expect(version.kind).toBe("version");
		expect(version.status).toBe("draft");
	});

	it("scopes a version under a project via the owns relation, and can move it to another project", async () => {
		const db = await openTestDatabase();
		const project = createEntity(db, { kind: "project", title: "Platform" });
		const otherProject = createEntity(db, { kind: "project", title: "Other platform" });
		const version = createEntity(db, { kind: "version", title: "2.0", parentId: project.id });

		const versionDetails = getEntityDetails(db, version.id);
		const projectParent = versionDetails.incoming.find((entry) => entry.relationType === "owns");
		expect(projectParent?.entity.id).toBe(project.id);

		const moveResult = moveEntity(db, { entityId: version.id, newParentId: otherProject.id });
		expect(moveResult.previousParentId).toBe(project.id);
		expect(moveResult.newParentId).toBe(otherProject.id);
		expect(moveResult.relationType).toBe("owns");
	});

	it("tags an initiative with a version, and allows multiple initiatives to tag the same version", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });
		const initiativeA = createEntity(db, { kind: "initiative", title: "Payments" });
		const initiativeB = createEntity(db, { kind: "initiative", title: "Billing" });

		linkEntities(db, { fromId: initiativeA.id, toId: version.id, relationType: "taggedWith" });
		linkEntities(db, { fromId: initiativeB.id, toId: version.id, relationType: "taggedWith" });

		const versionDetails = getEntityDetails(db, version.id);
		const taggers = versionDetails.incoming
			.filter((entry) => entry.relationType === "taggedWith")
			.map((entry) => entry.entity.id);
		expect(taggers.sort()).toEqual([initiativeA.id, initiativeB.id].sort());
	});

	it("tags an issue with a version", async () => {
		const db = await openTestDatabase();
		const version = createEntity(db, { kind: "version", title: "2.0" });
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });
		const issue = createEntity(db, { kind: "issue", title: "Fix bug", parentId: initiative.id });

		linkEntities(db, { fromId: issue.id, toId: version.id, relationType: "taggedWith" });

		const versionDetails = getEntityDetails(db, version.id);
		const tagger = versionDetails.incoming.find((entry) => entry.relationType === "taggedWith");
		expect(tagger?.entity.id).toBe(issue.id);
	});

	it("allows cross-version supersedes between initiatives, and rejects a cycle", async () => {
		const db = await openTestDatabase();
		const initiativeA = createEntity(db, { kind: "initiative", title: "Payments v1" });
		const initiativeB = createEntity(db, { kind: "initiative", title: "Payments v2" });

		linkEntities(db, { fromId: initiativeB.id, toId: initiativeA.id, relationType: "supersedes" });

		expect(() => linkEntities(db, { fromId: initiativeA.id, toId: initiativeB.id, relationType: "supersedes" })).toThrow(
			"would create a cycle"
		);
	});

	it("surfaces an untagged version as an orphan, but excludes versions reachable via tagging", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });
		const issue = createEntity(db, { kind: "issue", title: "Fix bug", parentId: initiative.id });

		const untaggedVersion = createEntity(db, { kind: "version", title: "Untagged" });
		const versionTaggedToInitiative = createEntity(db, { kind: "version", title: "Tagged to initiative" });
		const versionTaggedToIssue = createEntity(db, { kind: "version", title: "Tagged to issue" });

		linkEntities(db, { fromId: initiative.id, toId: versionTaggedToInitiative.id, relationType: "taggedWith" });
		linkEntities(db, { fromId: issue.id, toId: versionTaggedToIssue.id, relationType: "taggedWith" });

		const orphanVersionIds = listOrphans(db, "version").map((entity) => entity.id);
		expect(orphanVersionIds).toEqual([untaggedVersion.id]);
	});
});

describe("canonical revision history", () => {
	it("materializes revision 1 from a newly created canonical head", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });
		const canonicalEpicId = getEntityDetails(db, DEFAULT_EPIC_STABLE_ID).entity.id;

		expect(materializeEntityRevision(db, { entityId: initiative.id, revision: 1 })).toMatchObject({
			targetRevision: 1,
			author: "system",
			title: "Payments",
			status: "draft",
			parentId: canonicalEpicId
		});
	});

	it("uses the reserved system author for a head-only revision", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Payments" });

		expect(materializeEntityRevision(db, { entityId: initiative.id, revision: 1 }).author).toBe("system");
	});

	it("appends a status revision that materializes its predecessor", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Fix bug" });

		const updated = updateEntityStatus(db, { entityId: issue.id, status: "in-progress", author: "kris" });

		expect(updated.entity).toMatchObject({ revision: 2, status: "in-progress", title: "Fix bug" });
		expect(materializeEntityRevision(db, { entityId: issue.id, revision: 1 })).toMatchObject({
			targetRevision: 1,
			headRevision: 2,
			status: "todo",
			title: "Fix bug"
		});
	});

	it("appends a compact reverse patch when an entity's body changes", async () => {
		const db = await openTestDatabase();
		const issue = createEntity(db, { kind: "issue", title: "Fix bug" });

		setEntityBody(db, { entityId: issue.id, body: "Repro steps here.", author: "kris", expectedRevision: issue.revision, expectedContentHash: issue.contentHash });
		const delta = db.drizzle.get(sql`
			SELECT revision, author, patch_format, length(reverse_patch) AS patch_bytes, source_hash, target_hash
			FROM revision_entries
			WHERE tenant_id = ${db.tenantId} AND project_id = ${db.currentProjectId} AND record_kind = 'entity' AND record_key = ${`${Buffer.byteLength(issue.id, "utf8")}:${issue.id}`} AND revision = 2
		`) as { revision: number; author: string; patch_format: number; patch_bytes: number; source_hash: Buffer; target_hash: Buffer };
		expect(delta).toEqual(expect.objectContaining({
			revision: 2,
			author: "system",
			patch_format: 1,
			patch_bytes: expect.any(Number),
			source_hash: expect.any(Buffer),
			target_hash: expect.any(Buffer)
		}));
		expect(delta.patch_bytes).toBeGreaterThan(0);
		expect(materializeEntityRevision(db, { entityId: issue.id, revision: 1 })).toMatchObject({ title: "Fix bug", body: "", bodySource: "authored" });
	});

	it("appends a move revision that materializes its predecessor, but not on a no-op move", async () => {
		const db = await openTestDatabase();
		const projectA = createEntity(db, { kind: "project", title: "Project A" });
		const projectB = createEntity(db, { kind: "project", title: "Project B" });
		const version = createEntity(db, { kind: "version", title: "2.0", parentId: projectA.id });

		const moved = moveEntity(db, { entityId: version.id, newParentId: projectB.id, author: "kris" });

		expect(moved.entity.revision).toBe(2);
		expect(materializeEntityRevision(db, { entityId: version.id, revision: 2 })).toMatchObject({ parentId: projectB.id });
		expect(materializeEntityRevision(db, { entityId: version.id, revision: 1 })).toMatchObject({
			targetRevision: 1,
			headRevision: 2,
			parentId: projectA.id
		});

		const unchanged = moveEntity(db, { entityId: version.id, newParentId: projectB.id });
		expect(unchanged.entity.revision).toBe(2);
	});

	it("restoring a prior parent also restores the entity's project assignment", async () => {
		const db = await openTestDatabase();
		const projectA = createEntity(db, { kind: "project", title: "Project A" });
		const projectB = createEntity(db, { kind: "project", title: "Project B" });
		const version = createEntity(db, { kind: "version", title: "2.0", parentId: projectA.id });
		const moved = moveEntity(db, { entityId: version.id, newParentId: projectB.id });

		restoreEntityRevision(db, { entityId: version.id, revision: 1, expectedRevision: moved.entity.revision, expectedContentHash: moved.entity.contentHash });

		const row = db.drizzle.get<{ project_id: string }>(
			sql`SELECT project_id FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${version.id}`
		) as { project_id: string };
		expect(row.project_id).toBe(projectA.id);
	});
});
