import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { and } from "drizzle-orm";
import type { Pool } from "pg";
import { decodeCanonicalReference, deriveUserIdentity, encodeEntityRecordKey, SYSTEM_AUTHENTICATION_SUBJECT } from "@agent-issues/core";

import { createPgPool, migratePgDatabase, withTenantTransaction } from "../../db/connection.js";
import { cleanupTestTenants, createTestTenantId } from "../../db/test-tenant-cleanup.js";
import { PgStore } from "../../pg-store.js";
import { entities, relations, revisionEntries } from "../../schema.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

// PgStore always runs as this non-superuser role, never the migration/admin
// role, so RLS is genuinely enforced in tests (Postgres superusers bypass
// RLS unconditionally - see docker/postgres-init/01-app-role.sql).
const APP_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";
const SYSTEM_USER_ID = deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id;

describe("PgStore entity lifecycle", () => {
	let adminPool: Pool;
	let appPool: Pool;

	beforeAll(async () => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
		await migratePgDatabase(adminPool);
		appPool = createPgPool({ connectionString: APP_CONNECTION_STRING });
	});

	it("restoring a prior parent also restores the entity's project assignment", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const projectA = await store.createEntity({ kind: "project", title: "Project A" });
		const projectB = await store.createEntity({ kind: "project", title: "Project B" });
		const version = await store.createEntity({ kind: "version", title: "2.0", parentId: projectA.id });
		const moved = await store.moveEntity({ entityId: version.id, newParentId: projectB.id });

		await store.restoreEntityRevision({ entityId: version.id, revision: 1, expectedRevision: moved.entity.revision, expectedContentHash: moved.entity.contentHash });

		const [row] = await withTenantTransaction(appPool, store.tenantId, (client) => client.select({ projectId: entities.projectId }).from(entities).where(and(eq(entities.tenantId, store.tenantId), eq(entities.id, version.id))));
		expect(row?.projectId).toBe(projectA.id);
	});

	afterAll(async () => {
		await cleanupTestTenants(adminPool);
		await adminPool.end();
		await appPool.end();
	});

	it("creates a parent-less initiative under the auto-bootstrapped EPIC0 sentinel", async () => {
		const store = new PgStore(appPool, createTestTenantId());

		const entity = await store.createEntity({ kind: "initiative", title: "Ship the Postgres gate" });

		expect(decodeCanonicalReference(entity.reference)).toEqual({ kind: "initiative", stableId: entity.id });
		expect(entity.kind).toBe("initiative");
		expect(entity.title).toBe("Ship the Postgres gate");
		expect(entity.status).toBe("draft");

		const details = await store.getEntityDetails(entity.id);
		const canonicalEpicReference = details.incoming[0]?.entity.reference;
		expect(canonicalEpicReference).toMatch(/^EPIC_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		expect(details.incoming).toEqual([{ relationType: "contains", entity: expect.objectContaining({ reference: canonicalEpicReference }) }]);

		const history = await store.listEntityHistory(entity.id);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			version: 1,
			author: SYSTEM_USER_ID,
			title: "Ship the Postgres gate",
			status: "draft",
			parentId: details.incoming[0]?.entity.id
		});
	});

	it("shows a selected project's structural parents without exposing another project's entities", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId);
		const project = await store.createEntity({ kind: "project", title: "Selected project" });
		const epic = await store.createEntity({ kind: "epic", parentId: project.id, title: "Selected epic" });
		const otherProject = await store.createEntity({ kind: "project", title: "Other project" });
		const otherEpic = await store.createEntity({ kind: "epic", parentId: otherProject.id, title: "Other epic" });
		const selectedStore = new PgStore(appPool, tenantId, project.id);

		const details = await selectedStore.getEntityDetails(epic.id);
		const relations = await selectedStore.queryEntityRelations({ entityId: epic.id, direction: "incoming" });

		expect(details.incoming).toContainEqual(expect.objectContaining({
			relationType: "contains",
			entity: expect.objectContaining({ id: project.id })
		}));
		expect(relations.incoming).toContainEqual(expect.objectContaining({
			relationType: "contains",
			entity: expect.objectContaining({ id: project.id })
		}));
		await expect(selectedStore.getEntityDetails(otherEpic.id)).rejects.toThrow(/not found/i);
	});

	it("includes an issue's newest comment page in the database snapshot", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const issue = await store.createEntity({ kind: "issue", title: "Discuss snapshot data" });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Show this comment in the site." });

		const snapshot = await store.getDatabaseSnapshot();

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

	it("creates a parent-less entity under the request's own project identity, not the sentinel", async () => {
		const tenantId = createTestTenantId();
		const store = new PgStore(appPool, tenantId, "fresh-workspace");

		const initiative = await store.createEntity({ kind: "initiative", title: "First initiative" });
		const adr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		// The sentinel PROJ0 is excluded from discovery, so an initiative that
		// wrongly landed there shows up as a project with zero initiatives -
		// which is exactly what happened before this identity was minted on
		// first write instead of silently falling back to PROJ0.
		const discovery = await store.getProjectDiscovery();
		expect(discovery).toEqual({
			kind: "available",
			projects: [
				expect.objectContaining({
					project: expect.objectContaining({ kind: "project", title: "fresh-workspace" }),
					epicCount: 1,
					initiativeCount: 1
				})
			]
		});
		const projectId = discovery.kind === "available" ? discovery.projects[0]!.project.id : "";

		const snapshot = await store.getDatabaseSnapshot({ projectId });
		expect(snapshot.kind).toBe("available");
		if (snapshot.kind === "available") {
			expect(snapshot.snapshot.projectAdrs.map((entity) => entity.id)).toContain(adr.id);
		}

		// The glossary path already minted per-identity projects; both paths
		// now resolve to the same one rather than disagreeing about which
		// project this workspace is.
		const contexts = await store.listContexts();
		expect(contexts.contexts.map((item) => item.context.key)).toContain(`default:${projectId}`);

		// A second request for the same identity joins the project rather than minting another.
		const reopened = new PgStore(appPool, tenantId, "fresh-workspace");
		await reopened.createEntity({ kind: "initiative", title: "Second initiative" });
		const secondDiscovery = await reopened.getProjectDiscovery();
		expect(secondDiscovery).toEqual({
			kind: "available",
			projects: [expect.objectContaining({ project: expect.objectContaining({ id: projectId }), initiativeCount: 2 })]
		});
		expect(await reopened.getEntityDetails(initiative.id)).toBeDefined();
	});

	it("lists entities of a kind and records the trusted system actor on the history entry", async () => {
		const store = new PgStore(appPool, createTestTenantId());

		await store.createEntity({ kind: "initiative", title: "First", author: "alice" });
		await store.createEntity({ kind: "initiative", title: "Second" });

		const initiatives = await store.listEntities("initiative");
		expect(initiatives.map((entity) => entity.title)).toEqual(expect.arrayContaining(["First", "Second"]));

		const history = await store.listEntityHistory(initiatives.find((entity) => entity.title === "First")!.id);
		expect(history[0]?.author).toBe(SYSTEM_USER_ID);
	});

	it("resolves the revision parent by source hash when relation replay changes timestamp order", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const canonicalParent = await store.createEntity({ kind: "project", title: "Canonical parent" });
		const annotationParent = await store.createEntity({ kind: "project", title: "Structural annotation" });
		const version = await store.createEntity({ kind: "version", title: "2.0", parentId: canonicalParent.id });

		await withTenantTransaction(appPool, store.tenantId, (client) =>
			client.insert(relations).values({
				tenantId: store.tenantId,
				fromId: annotationParent.id,
				toId: version.id,
				type: "contains",
				createdAt: "1900-01-01T00:00:00.000Z"
			})
		);

		await expect(store.listEntityHistory(version.id)).resolves.toEqual([
			expect.objectContaining({ version: 1, parentId: canonicalParent.id })
		]);
		await expect(store.materializeEntityRevision({ entityId: version.id, revision: 1 })).resolves.toMatchObject({
			parentId: canonicalParent.id
		});
	});

	it("keeps tenants isolated even for a query the app layer forgets to filter by tenant_id", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's secret initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's secret initiative" });

		// Deliberately a raw, tenant-unfiltered query - the same query shape an
		// app-layer bug could produce. RLS (ADR9, the 0001 migration) must be
		// the backstop that blocks cross-tenant rows even so.
		const client = await appPool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
			const result = await client.query("SELECT title FROM entities WHERE kind = 'initiative'");
			expect(result.rows.map((row: { title: string }) => row.title)).toEqual(["Tenant A's secret initiative"]);
			await client.query("COMMIT");
		} finally {
			client.release();
		}
	});

	it("runs Drizzle executor queries in the RLS-scoped tenant transaction", async () => {
		const tenantA = createTestTenantId();
		const tenantB = createTestTenantId();
		const storeA = new PgStore(appPool, tenantA);
		const storeB = new PgStore(appPool, tenantB);

		await storeA.createEntity({ kind: "initiative", title: "Tenant A's executor-visible initiative" });
		await storeB.createEntity({ kind: "initiative", title: "Tenant B's executor-hidden initiative" });

		const rows = await withTenantTransaction(appPool, tenantA, (executor) =>
			executor.select({ title: entities.title }).from(entities).where(eq(entities.kind, "initiative"))
		);

		expect(rows).toEqual([{ title: "Tenant A's executor-visible initiative" }]);
	});

	it("changes the snapshot signature when a relation is swapped without changing the count", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const issueA = await store.createEntity({ kind: "issue", title: "Issue A" });
		const issueB = await store.createEntity({ kind: "issue", title: "Issue B" });
		await store.linkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "blocks" });

		const before = await store.getSnapshotSignature();

		// Reversing the direction leaves the relation count identical, so a
		// count-only signature would report "nothing changed" and leave a
		// polling client on a stale view.
		await store.unlinkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "blocks" });
		await store.linkEntities({ fromId: issueB.id, toId: issueA.id, relationType: "blocks" });

		expect(await store.getSnapshotSignature()).not.toBe(before);
	});

	it("creates, reads, updates, and deletes an entity through the tenant executor", async () => {
		const store = new PgStore(appPool, createTestTenantId());

		const created = await store.createEntity({ kind: "initiative", title: "Executor CRUD" });
		const read = await store.getEntityDetails(created.id);
		const updated = await store.updateEntity({
			entityId: created.id,
			title: "Executor CRUD updated",
			expectedRevision: created.revision,
			expectedContentHash: created.contentHash
		});
		const deleted = await store.deleteEntity({ entityId: created.id });

		expect(read.entity).toMatchObject({ id: created.id, title: "Executor CRUD" });
		expect(updated).toMatchObject({ id: created.id, title: "Executor CRUD updated" });
		expect(deleted).toMatchObject({
			entity: { id: updated.id, title: updated.title, revision: updated.revision + 1 },
			removed: true
		});
		await expect(store.getEntityDetails(created.id)).rejects.toThrow("Entity not found");
	});

	it("links and unlinks two entities", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocking issue", parentId: initiative.id });

		const linked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(linked.created).toBe(true);
		expect(linked.relation).toMatchObject({ fromId: issue.id, toId: blocker.id, type: "blocks" });

		const relinked = await store.linkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(relinked.created).toBe(false);

		const unlinked = await store.unlinkEntities({ fromId: issue.id, toId: blocker.id, relationType: "blocks" });
		expect(unlinked.removed).toBe(true);
	});

	it("rejects a self-relation and a disallowed relation type", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		await expect(store.linkEntities({ fromId: issue.id, toId: issue.id, relationType: "blocks" })).rejects.toThrow(
			"itself"
		);
		await expect(store.linkEntities({ fromId: issue.id, toId: initiative.id, relationType: "blocks" })).rejects.toThrow(
			"not allowed"
		);
	});

	it("rejects a blocks link that would create a cycle", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issueA = await store.createEntity({ kind: "issue", title: "A", parentId: initiative.id });
		const issueB = await store.createEntity({ kind: "issue", title: "B", parentId: initiative.id });

		await store.linkEntities({ fromId: issueA.id, toId: issueB.id, relationType: "blocks" });

		await expect(store.linkEntities({ fromId: issueB.id, toId: issueA.id, relationType: "blocks" })).rejects.toThrow(
			"cycle"
		);
	});

	it("updates status, sets body, and archives an entity", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Ship the seam", parentId: initiative.id });

		const statusUpdate = await store.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
		expect(statusUpdate.previousStatus).toBe("todo");
		expect(statusUpdate.entity.status).toBe("in-progress");

		const bodyUpdated = await store.setEntityBody({
			entityId: issue.id,
			body: "Detailed plan.",
			expectedRevision: statusUpdate.entity.revision,
			expectedContentHash: statusUpdate.entity.contentHash
		});
		expect(bodyUpdated.body).toBe("Detailed plan.");
		const deltas = await withTenantTransaction(appPool, store.tenantId, (executor) =>
			executor.select().from(revisionEntries).where(and(eq(revisionEntries.tenantId, store.tenantId), eq(revisionEntries.recordKind, "entity"), eq(revisionEntries.recordKey, encodeEntityRecordKey(issue.id))))
		);
		expect(deltas).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ revision: 2, patchFormat: 1, reversePatch: expect.any(Buffer), sourceHash: expect.any(Buffer), targetHash: expect.any(Buffer) }),
				expect.objectContaining({
					revision: 3,
					patchFormat: 1,
					reversePatch: expect.any(Buffer),
					sourceHash: expect.any(Buffer),
					targetHash: expect.any(Buffer)
				})
			])
		);

		const archived = await store.archiveEntity({ entityId: issue.id });
		expect(archived.entity.status).toBe("done");

		await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 1 })).resolves.toMatchObject({ status: "todo", body: "" });
		await expect(store.materializeEntityRevision({ entityId: issue.id, revision: 3 })).resolves.toMatchObject({ status: "in-progress", body: "Detailed plan." });
	});

	it("rejects setting a userStory's status directly once it has a fixing issue", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
		const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
		const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
		await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });

		await expect(store.updateEntityStatus({ entityId: story.id, status: "done" })).rejects.toThrow("derived from its fixing issues");
	});

	it("rejects setting an issue to in-progress while an open sub-issue remains", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const parentIssue = await store.createEntity({ kind: "issue", title: "Parent", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub", parentId: initiative.id });
		await store.linkEntities({ fromId: parentIssue.id, toId: subIssue.id, relationType: "decomposes" });

		await expect(store.updateEntityStatus({ entityId: parentIssue.id, status: "in-progress" })).rejects.toThrow(
			"sub-issues remain open"
		);
	});

	it("rejects setting an issue to in-progress while an active blocker remains", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Blocked", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });

		await expect(store.updateEntityStatus({ entityId: issue.id, status: "in-progress" })).rejects.toThrow("blocked by");
	});

	it("does not treat a tombstoned blocker as active", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Blocked", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Deleted blocker", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });

		await withTenantTransaction(appPool, store.tenantId, (client) =>
			client
				.update(entities)
				.set({ tombstone: true })
				.where(and(eq(entities.tenantId, store.tenantId), eq(entities.id, blocker.id)))
		);

		await expect(store.updateEntityStatus({ entityId: issue.id, status: "in-progress" })).resolves.toMatchObject({
			entity: { status: "in-progress" }
		});
	});

	it("moves an entity to a new structural parent and rejects a cycle", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiativeA = await store.createEntity({ kind: "initiative", title: "A" });
		const initiativeB = await store.createEntity({ kind: "initiative", title: "B" });
		const issue = await store.createEntity({ kind: "issue", title: "Movable", parentId: initiativeA.id });

		const moved = await store.moveEntity({ entityId: issue.id, newParentId: initiativeB.id });
		expect(moved.previousParentId).toBe(initiativeA.id);
		expect(moved.newParentId).toBe(initiativeB.id);
		expect(moved.relationType).toBe("tracks");

		await expect(store.moveEntity({ entityId: issue.id, newParentId: issue.id })).rejects.toThrow("under itself");
	});

	it("refreshes project ownership when moving an ADR between projects", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const firstProject = await store.createEntity({ kind: "project", title: "First project" });
		const firstEpic = await store.createEntity({ kind: "epic", title: "First epic", parentId: firstProject.id });
		const firstInitiative = await store.createEntity({ kind: "initiative", title: "First initiative", parentId: firstEpic.id });
		const secondProject = await store.createEntity({ kind: "project", title: "Second project" });
		const secondEpic = await store.createEntity({ kind: "epic", title: "Second epic", parentId: secondProject.id });
		const secondInitiative = await store.createEntity({ kind: "initiative", title: "Second initiative", parentId: secondEpic.id });
		const adr = await store.createEntity({ kind: "adr", title: "Movable ADR", parentId: firstInitiative.id });

		await store.moveEntity({ entityId: adr.id, newParentId: secondInitiative.id });

		const firstSnapshot = await store.getDatabaseSnapshot({ projectId: firstProject.id });
		const secondSnapshot = await store.getDatabaseSnapshot({ projectId: secondProject.id });
		expect(firstSnapshot).toEqual(expect.objectContaining({ kind: "available" }));
		expect(secondSnapshot).toEqual(expect.objectContaining({ kind: "available" }));
		if (firstSnapshot.kind !== "available" || secondSnapshot.kind !== "available") {
			return;
		}

		expect(firstSnapshot.snapshot.entities.map((entity) => entity.id)).not.toContain(adr.id);
		expect(secondSnapshot.snapshot.entities.map((entity) => entity.id)).toContain(adr.id);
	});

	it("rejects deleting an entity that still has outgoing relations", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await store.createEntity({ kind: "issue", title: "Has children", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub", parentId: initiative.id });
		await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });

		await expect(store.deleteEntity({ entityId: issue.id })).rejects.toThrow("outgoing relations");

		const deleted = await store.deleteEntity({ entityId: subIssue.id });
		expect(deleted.removed).toBe(true);
	});

	it("lists orphans, excluding initiatives/ADRs/project/epic and anything reachable from an initiative", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await store.createEntity({ kind: "issue", title: "Tracked issue", parentId: initiative.id });
		const orphanIssue = await store.createEntity({ kind: "issue", title: "Orphan issue" });
		const orphanAdr = await store.createEntity({ kind: "adr", title: "Project-scoped ADR" });

		const orphans = await store.listOrphans();
		expect(orphans.map((entity) => entity.id)).toContain(orphanIssue.id);
		expect(orphans.map((entity) => entity.id)).not.toContain(orphanAdr.id);
		expect(orphans.map((entity) => entity.id)).not.toContain(initiative.id);

		const orphanIssuesOnly = await store.listOrphans("issue");
		expect(orphanIssuesOnly.map((entity) => entity.id)).toEqual([orphanIssue.id]);
	});

	it("lists project-scoped ADRs (not linked from any initiative)", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const initiativeAdr = await store.createEntity({ kind: "adr", title: "Initiative ADR", parentId: initiative.id });
		const projectAdr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		const projectAdrs = await store.listProjectAdrs();
		expect(projectAdrs.map((entity) => entity.id)).toContain(projectAdr.id);
		expect(projectAdrs.map((entity) => entity.id)).not.toContain(initiativeAdr.id);
	});

	it("lists ADRs recorded by a project or epic as project-scoped", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const project = await store.createEntity({ kind: "project", title: "Console" });
		const epic = await store.createEntity({ kind: "epic", parentId: project.id, title: "Viewer" });
		const projectAdr = await store.createEntity({ kind: "adr", parentId: project.id, title: "Use signals" });
		const epicAdr = await store.createEntity({ kind: "adr", parentId: epic.id, title: "Use Lit" });

		const result = await store.getDatabaseSnapshot({ projectId: project.id });
		expect(result).toEqual(expect.objectContaining({ kind: "available" }));
		if (result.kind === "available") {
			expect(result.snapshot.projectAdrs.map((entity) => entity.id)).toEqual(expect.arrayContaining([projectAdr.id, epicAdr.id]));
		}
	});

	it("excludes deleted ADRs from project reads", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const project = await store.createEntity({ kind: "project", title: "Project with deleted ADR" });
		const adr = await store.createEntity({ kind: "adr", title: "Deleted ADR" });
		await withTenantTransaction(appPool, store.tenantId, (client) =>
			client
				.update(entities)
				.set({ projectId: project.id })
				.where(and(eq(entities.tenantId, store.tenantId), eq(entities.id, adr.id)))
		);

		await store.deleteEntity({ entityId: adr.id });

		const snapshot = await store.getDatabaseSnapshot({ projectId: project.id });
		expect(snapshot).toEqual(expect.objectContaining({ kind: "available" }));
		if (snapshot.kind === "available") {
			expect(snapshot.snapshot.projectAdrs.map((entity) => entity.id)).not.toContain(adr.id);
		}
	});

	it("excludes tombstoned related entities from details and initiative bundles", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Live initiative" });
		const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Deleted issue" });
		const subIssue = await store.createEntity({ kind: "issue", parentId: issue.id, title: "Hidden descendant" });

		await withTenantTransaction(appPool, store.tenantId, (client) =>
			client
				.update(entities)
				.set({ tombstone: true })
				.where(and(eq(entities.tenantId, store.tenantId), eq(entities.id, issue.id)))
		);

		expect((await store.getEntityDetails(initiative.id)).outgoing).toEqual([]);
		expect((await store.getInitiativeBundle(initiative.id)).entities.map((entity) => entity.id)).not.toContain(issue.id);
		expect((await store.getInitiativeBundle(initiative.id)).entities.map((entity) => entity.id)).not.toContain(subIssue.id);
		expect(await store.listAllRelations()).not.toContainEqual(expect.objectContaining({ fromId: initiative.id, toId: issue.id }));
	});

	it("keeps project-level ADRs within the explicitly selected project snapshot", async () => {
		const tenantId = createTestTenantId();
		// Each identity registers its own project on first use, so seeding one
		// explicitly here would make the identity resolve to two projects.
		const selectedStore = new PgStore(appPool, tenantId, "Selected project");
		const selectedAdr = await selectedStore.createEntity({ kind: "adr", title: "Selected project ADR" });

		const otherStore = new PgStore(appPool, tenantId, "Other project");
		const otherAdr = await otherStore.createEntity({ kind: "adr", title: "Other project ADR" });

		const discovery = await selectedStore.getProjectDiscovery();
		expect(discovery.kind).toBe("available");
		if (discovery.kind !== "available") {
			return;
		}

		const selectedProject = discovery.projects.find((entry) => entry.project.title === "Selected project")!.project;
		const result = await selectedStore.getDatabaseSnapshot({ projectId: selectedProject.id });
		expect(result).toEqual(expect.objectContaining({ kind: "available" }));
		if (result.kind !== "available") {
			return;
		}

		expect(result.snapshot.projectAdrs.map((entity) => entity.id)).toContain(selectedAdr.id);
		expect(result.snapshot.projectAdrs.map((entity) => entity.id)).not.toContain(otherAdr.id);
	});

	it("builds an initiative bundle with prds, stories, issues, adrs, and link groups", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const prd = await store.createEntity({ kind: "prd", title: "PRD", parentId: initiative.id });
		const story = await store.createEntity({ kind: "userStory", title: "Story", parentId: prd.id });
		const issue = await store.createEntity({ kind: "issue", title: "Fixing issue", parentId: initiative.id });
		const subIssue = await store.createEntity({ kind: "issue", title: "Sub issue", parentId: initiative.id });
		const blocker = await store.createEntity({ kind: "issue", title: "Blocker", parentId: initiative.id });
		const adr = await store.createEntity({ kind: "adr", title: "ADR", parentId: initiative.id });

		await store.linkEntities({ fromId: issue.id, toId: story.id, relationType: "fixes" });
		await store.linkEntities({ fromId: issue.id, toId: subIssue.id, relationType: "decomposes" });
		await store.linkEntities({ fromId: blocker.id, toId: issue.id, relationType: "blocks" });
		await store.linkEntities({ fromId: adr.id, toId: issue.id, relationType: "constrains" });

		const bundle = await store.getInitiativeBundle(initiative.id);
		expect(bundle.initiative.id).toBe(initiative.id);
		expect(bundle.prds.map((entity) => entity.id)).toEqual([prd.id]);
		expect(bundle.userStories.map((entity) => entity.id)).toEqual([story.id]);
		expect(bundle.issues.map((entity) => entity.id).sort()).toEqual([blocker.id, issue.id, subIssue.id].sort());
		expect(bundle.adrs.map((entity) => entity.id)).toEqual([adr.id]);
		expect(bundle.fixLinks).toEqual([{ issue: expect.objectContaining({ id: issue.id }), userStory: expect.objectContaining({ id: story.id }) }]);
		expect(bundle.subIssueLinks).toEqual([{ parent: expect.objectContaining({ id: issue.id }), issue: expect.objectContaining({ id: subIssue.id }) }]);
		expect(bundle.blockerLinks).toEqual([{ source: expect.objectContaining({ id: blocker.id }), target: expect.objectContaining({ id: issue.id }) }]);
		expect(bundle.constrainsLinks).toEqual([{ adr: expect.objectContaining({ id: adr.id }), issue: expect.objectContaining({ id: issue.id }) }]);

		await expect(store.getInitiativeBundle(issue.id)).rejects.toThrow("not an initiative");
	});

	it("reads a full tenant snapshot with entities, relations, orphans, project adrs, and initiative bundles", async () => {
		const store = new PgStore(appPool, createTestTenantId());
		const initiative = await store.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await store.createEntity({ kind: "issue", title: "Tracked issue", parentId: initiative.id });
		const orphanAdr = await store.createEntity({ kind: "adr", title: "Project ADR" });

		const snapshot = await store.getDatabaseSnapshot();
		expect(snapshot.entities.map((entity) => entity.id)).toContain(initiative.id);
		expect(snapshot.relations.length).toBeGreaterThan(0);
		expect(snapshot.projectAdrs.map((entity) => entity.id)).toContain(orphanAdr.id);
		expect(snapshot.initiatives.map((bundle) => bundle.initiative.id)).toContain(initiative.id);
		expect(snapshot.contexts.shared.context.exists).toBe(false);
	});

});
