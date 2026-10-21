import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSqliteStore } from "./sqlite-store.js";
import type { SqliteStore } from "./sqlite-store.js";
import { createReverseFieldPatch, encodeCanonicalReference, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, synchronizeStores, SynchronizeConflictError } from "@agent-issues/core";

// Two independent SQLite stores exercise the same StorageDriver orchestration
// used for local/cloud synchronization without requiring an HTTP round trip.
describe("synchronizeStores (ISS267/ADR55)", () => {
	let localDirectory: string;
	let cloudDirectory: string;
	let local: SqliteStore;
	let cloud: SqliteStore;

	beforeEach(async () => {
		localDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-local-"));
		cloudDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-cloud-"));
		// Explicit, distinct `dbPath`s: `openSqliteStore(undefined, ...)` always
		// resolves to the one shared per-user db file (only the tenant slug
		// varies by cwd) - two real backends never share physical storage like
		// that, so the test doubles must not either.
		local = (await openSqliteStore(path.join(localDirectory, "local.db"), { currentWorkingDirectory: localDirectory })).store;
		cloud = (await openSqliteStore(path.join(cloudDirectory, "cloud.db"), { currentWorkingDirectory: cloudDirectory })).store;
	});

	afterEach(async () => {
		await local.close();
		await cloud.close();
		rmSync(localDirectory, { recursive: true, force: true });
		rmSync(cloudDirectory, { recursive: true, force: true });
	});

	it("is a true no-op when both sides are already converged", async () => {
		await synchronizeStores(local, cloud);

		const summary = await synchronizeStores(local, cloud);

		expect(summary).toEqual({
			entriesAppliedToLocal: 0,
			entriesAppliedToCloud: 0,
			entitiesCreatedLocal: [],
			entitiesUpdatedLocal: [],
			entitiesCreatedCloud: [],
			entitiesUpdatedCloud: [],
			concurrentEditConflicts: 0,
			relationsAppliedToLocal: 0,
			relationsAppliedToCloud: 0,
			contextsAppliedToLocal: 0,
			contextsAppliedToCloud: 0,
			contextTermsAppliedToLocal: 0,
			contextTermsAppliedToCloud: 0,
			issueCommentsCreatedLocal: [],
			issueCommentsUpdatedLocal: [],
			issueCommentsCreatedCloud: [],
			issueCommentsUpdatedCloud: [],
			planEntriesCreatedLocal: [],
			planEntriesUpdatedLocal: [],
			planEntriesCreatedCloud: [],
			planEntriesUpdatedCloud: [],
			completionObservationsCreatedLocal: [],
			completionObservationsCreatedCloud: [],
			usersAppliedToLocal: 0,
			usersAppliedToCloud: 0
		});
	});

	it("synchronizes tenant user records", async () => {
		const user = await local.upsertUser({ authenticationSubject: "entra:alice", displayName: "Alice" });

		const summary = await synchronizeStores(local, cloud);

		expect(await cloud.listUsers()).toEqual([user]);
		expect(summary.usersAppliedToCloud).toBe(1);
	});

	it("synchronizes repeated completion observations and reports their stable IDs", async () => {
		const issue = await local.createEntity({ kind: "issue", title: "Observed issue" });
		const workspaceObservation = (version: string, commitSha: string) => ({
			state: "available" as const,
			repositoryIdentity: "a".repeat(64),
			commitSha,
			branch: "main",
			dirty: false,
			capturedAt: "2026-09-23T13:00:00.000Z",
			calculatedVersion: {
				state: "available" as const,
				version,
				branch: "main",
				currentCommit: commitSha,
				isTrunkBranch: true,
				commitsSinceTag: 0,
				commitBumps: { major: 0, minor: 0, patch: 0 }
			},
			fingerprint: { repositoryIdentity: "a".repeat(64), commitSha, branch: "main", refsHash: "c".repeat(64) }
		});
		await local.updateEntityStatus({ entityId: issue.id, status: "done", workspaceObservation: workspaceObservation("1.2.3", "b".repeat(40)) });
		await local.updateEntityStatus({ entityId: issue.id, status: "in-progress" });
		await local.updateEntityStatus({ entityId: issue.id, status: "done", workspaceObservation: workspaceObservation("1.2.4", "d".repeat(40)) });

		const summary = await synchronizeStores(local, cloud);
		const observations = (await local.getEntityDetails(issue.id)).completionObservations;

		expect((await cloud.getEntityDetails(issue.id)).completionObservations).toEqual(observations);
		expect((await cloud.getEntityDetails(issue.id)).currentCompletionObservation).toMatchObject({ completionOrdinal: 2, calculatedVersion: "1.2.4" });
		expect(summary.completionObservationsCreatedCloud).toEqual(observations.map((observation) => observation.id));

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.completionObservationsCreatedCloud).toEqual([]);
	});

	it("preserves authenticated entity provenance and revision actors", async () => {
		const actor = { userId: "entra:alice", tenantId: local.tenantId, displayName: "Alice" };
		const created = await local.withAuthenticatedIdentity(actor).createEntity({ kind: "issue", title: "Attributed issue" });

		await synchronizeStores(local, cloud);

		const user = (await cloud.listUsers()).find((candidate) => candidate.authenticationSubject === actor.userId);
		expect(await cloud.getEntityDetails(created.id)).toMatchObject({ entity: { createdBy: user?.id, updatedBy: user?.id } });
		expect((await cloud.listEntityHistory(created.id))[0]).toMatchObject({ author: user?.id });
	});

	it("synchronizes a comment and rebuilds its indexed issue references", async () => {
		const issue = await local.createEntity({ kind: "issue", title: "Commented issue" });
		const referencedIssue = await local.createEntity({ kind: "issue", title: "Referenced issue" });
		const id = randomUUID();
		const reference = encodeCanonicalReference("issueComment", id);
		const now = "2026-08-08T00:00:00.000Z";
		const body = "Needs a follow-up.";
		const referencedIssueIds = [referencedIssue.id];
		const comment = {
			head: {
				id,
				reference,
				issueId: issue.id,
				createdBy: issue.createdBy,
				updatedBy: issue.updatedBy,
				body,
				referencedIssueIds,
				tombstone: false,
				revision: 1,
				contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds, tombstone: false })).digest("hex"),
				createdAt: now,
				updatedAt: now
			},
			deltas: []
		};
		const localBundle = await local.exportCanonicalChains();
		await local.importCanonicalChains({ ...localBundle, issueComments: [comment] });

		const summary = await synchronizeStores(local, cloud);

		const cloudComment = (await cloud.exportCanonicalChains()).issueComments.find((chain) => chain.head.id === id);
		expect(cloudComment?.head).toMatchObject({ reference, issueId: issue.id, referencedIssueIds: [referencedIssue.id] });
		expect(summary).toMatchObject({ issueCommentsCreatedCloud: [id] });

		const updatedReferencedIssueIds: string[] = [];
		const updatedAt = "2026-08-08T01:00:00.000Z";
		const updatedComment = {
			head: {
				...comment.head,
				referencedIssueIds: updatedReferencedIssueIds,
				revision: 2,
				contentHash: createHash("sha256").update(JSON.stringify({ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false })).digest("hex"),
				updatedAt
			},
			deltas: [{
				id: randomUUID(),
				revision: 2,
				author: comment.head.updatedBy,
				createdAt: updatedAt,
				...createReverseFieldPatch(
					{ body, referencedIssueIds: updatedReferencedIssueIds, tombstone: false },
					{ body, referencedIssueIds, tombstone: false },
					ISSUE_COMMENT_REVERSE_PATCH_REGISTRY
				)
			}]
		};
		const updatedBundle = await local.exportCanonicalChains();
		await local.importCanonicalChains({ ...updatedBundle, issueComments: [updatedComment] });
		expect((await local.exportCanonicalChains()).issueComments.find((chain) => chain.head.id === id)?.deltas).toHaveLength(1);

		const updateSummary = await synchronizeStores(local, cloud);

		expect((await cloud.exportCanonicalChains()).issueComments.find((chain) => chain.head.id === id)?.head.referencedIssueIds).toEqual([]);
		expect(updateSummary).toMatchObject({ issueCommentsUpdatedCloud: [id] });
	});

	it("synchronizes Plan entries and rebuilds entity references and supersessions", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await local.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
		const referencedEntity = await local.createEntity({ kind: "issue", title: "Referenced issue", parentId: initiative.id });
		const question = await local.createPlanEntry({ planId: plan.id, role: "question", body: "Which backend owns synchronization?" });
		const decision = await local.createPlanEntry({
			planId: plan.id,
			role: "decision",
			body: "Both backends use canonical chains.",
			referencedEntityIds: [referencedEntity.id],
			supersededEntryIds: [question.id]
		});

		const summary = await synchronizeStores(local, cloud);

		expect(await cloud.listPlanEntries({ planId: plan.id })).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: question.id, role: "question", supersededEntryIds: [] }),
			expect.objectContaining({ id: decision.id, role: "decision", referencedEntityIds: [referencedEntity.id], supersededEntryIds: [question.id] })
		]));
		expect((await cloud.exportCanonicalChains()).planEntries).toEqual(expect.arrayContaining([
			expect.objectContaining({ head: expect.objectContaining({ id: decision.id, referencedEntityIds: [referencedEntity.id], supersededEntryIds: [question.id] }) })
		]));
		expect(summary.planEntriesCreatedCloud).toEqual(expect.arrayContaining([question.id, decision.id]));
	});

	it("synchronizes an updated Plan entry with supersessions in creation order", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await local.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
		const firstQuestion = await local.createPlanEntry({ planId: plan.id, role: "question", body: "First question" });
		const secondQuestion = await local.createPlanEntry({ planId: plan.id, role: "question", body: "Second question" });
		const supersededEntryIds = [firstQuestion.id, secondQuestion.id].sort().reverse();
		const decision = await local.createPlanEntry({
			planId: plan.id,
			role: "decision",
			body: "Initial decision",
			supersededEntryIds
		});

		await synchronizeStores(local, cloud);
		const updated = await local.updatePlanEntry({
			entryId: decision.id,
			body: "Updated decision",
			expectedRevision: decision.revision,
			expectedContentHash: decision.contentHash
		});

		await expect(synchronizeStores(local, cloud)).resolves.toMatchObject({ planEntriesUpdatedCloud: [decision.id] });
		expect((await cloud.listPlanEntries({ planId: plan.id })).find((entry) => entry.id === decision.id)).toMatchObject({
			body: "Updated decision",
			supersededEntryIds: updated.supersededEntryIds
		});
	});

	it("imports a strict canonical extension with every reverse delta intact", async () => {
		const created = await local.createEntity({ kind: "issue", title: "First", body: "First body" });
		const revision2 = await local.updateEntity({ entityId: created.id, title: "Second", body: "Second body", expectedRevision: created.revision, expectedContentHash: created.contentHash });
		await local.updateEntity({ entityId: created.id, title: "Third", body: "Third body", expectedRevision: revision2.revision, expectedContentHash: revision2.contentHash });
		const localChain = (await local.exportCanonicalChains()).entities.find((chain) => chain.head.id === created.id);
		expect(localChain?.deltas.every((delta) => /^[0-9a-f]{64}$/.test(delta.sourceHash) && /^[0-9a-f]{64}$/.test(delta.targetHash))).toBe(true);

		const result = await cloud.importCanonicalChains(await local.exportCanonicalChains());

		expect(result.entitiesCreated).toContain(created.id);
		expect((await cloud.exportCanonicalChains()).entities.find((chain) => chain.head.id === created.id)?.deltas).toEqual(localChain?.deltas);
		await expect(cloud.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toMatchObject({ title: "First", body: "First body", headRevision: 3 });
		await expect(cloud.materializeEntityRevision({ entityId: created.id, revision: 2 })).resolves.toMatchObject({ title: "Second", body: "Second body", headRevision: 3 });
		expect(await cloud.importCanonicalChains(await local.exportCanonicalChains())).toEqual({ entitiesCreated: [], entitiesAdvanced: [], contextsCreated: [], contextsAdvanced: [], contextTermsCreated: [], contextTermsAdvanced: [], issueCommentsCreated: [], issueCommentsAdvanced: [], planEntriesCreated: [], planEntriesAdvanced: [], completionObservationsCreated: [], usersCreated: [], usersUpdated: [] });
	});

	it("rejects a divergent batch before mutating an earlier compatible record", async () => {
		const shared = await local.createEntity({ kind: "issue", title: "Shared" });
		await cloud.importCanonicalChains(await local.exportCanonicalChains());
		const localShared = await local.updateEntity({ entityId: shared.id, title: "Local", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
		await cloud.updateEntity({ entityId: shared.id, title: "Cloud", expectedRevision: shared.revision, expectedContentHash: shared.contentHash });
		const newRecord = await local.createEntity({ kind: "issue", title: "Must roll back" });
		const signatureBefore = await cloud.getSnapshotSignature();

		await expect(cloud.importCanonicalChains(await local.exportCanonicalChains())).rejects.toMatchObject({
			name: "SynchronizeConflictError",
			recordKind: "entity",
			recordId: shared.id,
			currentRevision: 2
		});
		expect(localShared.revision).toBe(2);
		await expect(cloud.getEntityDetails(newRecord.id)).rejects.toThrow(/not found/i);
		expect(await cloud.getSnapshotSignature()).toBe(signatureBefore);
	});

	it("propagates a brand-new entity created on one side to the other", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const issue = await local.createEntity({ kind: "issue", title: "Local-only issue", parentId: initiative.id });

		const summary = await synchronizeStores(local, cloud);

		expect(summary.entitiesCreatedCloud).toContain(issue.id);
		expect(summary.entitiesCreatedCloud).toContain(initiative.id);

		const cloudDetails = await cloud.getEntityDetails(issue.id);
		expect(cloudDetails.entity.title).toBe("Local-only issue");

		const localSnapshot = await local.getDatabaseSnapshot();
		const cloudSnapshot = await cloud.getDatabaseSnapshot();
		const factsOf = (entities: typeof localSnapshot.entities, id: string) => {
			const entity = entities.find((candidate) => candidate.id === id);
			return entity && { title: entity.title, body: entity.body, status: entity.status };
		};
		expect(factsOf(cloudSnapshot.entities, issue.id)).toEqual(factsOf(localSnapshot.entities, issue.id));
	});

	it("preserves different same-kind entities created independently after convergence", async () => {
		await synchronizeStores(local, cloud);

		const localIssue = await local.createEntity({ kind: "issue", title: "Created locally" });
		const cloudIssue = await cloud.createEntity({ kind: "issue", title: "Created in cloud" });

		expect(localIssue.id).not.toBe(cloudIssue.id);
		await synchronizeStores(local, cloud);

		expect((await local.listEntities("issue")).map((entity) => entity.title)).toEqual(
			expect.arrayContaining(["Created locally", "Created in cloud"])
		);
		expect((await cloud.listEntities("issue")).map((entity) => entity.title)).toEqual(
			expect.arrayContaining(["Created locally", "Created in cloud"])
		);
	});

	it("rejects a previous sequential identifier", async () => {
		await local.createEntity({ kind: "issue", title: "Canonical issue" });

		await expect(local.getEntityDetails("ISS312")).rejects.toThrow("Entity not found: ISS312");
		await expect(local.updateEntityStatus({ entityId: "ISS312", status: "in-progress" })).rejects.toThrow("Entity not found: ISS312");
	});

	it("propagates a non-structural relation (e.g. 'blocks') created on one side to the other, without duplicating it on repeated runs", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		const blocker = await local.createEntity({ kind: "issue", title: "Blocker issue", parentId: initiative.id });
		const blocked = await local.createEntity({ kind: "issue", title: "Blocked issue", parentId: initiative.id });
		await synchronizeStores(local, cloud);

		await local.linkEntities({ fromId: blocker.id, toId: blocked.id, relationType: "blocks" });

		const summary = await synchronizeStores(local, cloud);
		expect(summary.relationsAppliedToCloud).toBe(1);
		expect(summary.relationsAppliedToLocal).toBe(0);

		const cloudRelations = await cloud.listAllRelations();
		expect(cloudRelations).toContainEqual(expect.objectContaining({ fromId: blocker.id, toId: blocked.id, type: "blocks" }));

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.relationsAppliedToLocal).toBe(0);
		expect(repeatSummary.relationsAppliedToCloud).toBe(0);
	});

	it("preserves structural-type annotations alongside the canonical parent", async () => {
		const canonicalParent = await local.createEntity({ kind: "initiative", title: "Canonical parent" });
		const annotationSource = await local.createEntity({ kind: "initiative", title: "Annotation source" });
		const issue = await local.createEntity({ kind: "issue", title: "Tracked issue", parentId: canonicalParent.id });
		await synchronizeStores(local, cloud);

		await local.linkEntities({ fromId: annotationSource.id, toId: issue.id, relationType: "tracks" });
		const summary = await synchronizeStores(local, cloud);

		expect(summary.relationsAppliedToCloud).toBe(1);
		expect(await cloud.listAllRelations()).toEqual(expect.arrayContaining([
			expect.objectContaining({ fromId: canonicalParent.id, toId: issue.id, type: "tracks" }),
			expect.objectContaining({ fromId: annotationSource.id, toId: issue.id, type: "tracks" })
		]));
		expect((await cloud.exportCanonicalChains()).entities.find((chain) => chain.head.id === issue.id)?.head.parentId).toBe(canonicalParent.id);
	});

	it("does not merge or overwrite divergent revisioned heads", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);

		await local.setEntityBody({ entityId: initiative.id, body: "Edited locally, first", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });
		await cloud.setEntityBody({ entityId: initiative.id, body: "Edited in the cloud, second", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });
		const localBefore = await local.getEntityDetails(initiative.id);
		const cloudBefore = await cloud.getEntityDetails(initiative.id);

		await expect(synchronizeStores(local, cloud)).rejects.toMatchObject({
			name: "SynchronizeConflictError",
			recordKind: "entity",
			recordId: initiative.id,
			currentRevision: 2,
			currentContentHash: localBefore.entity.contentHash
		});

		const localDetails = await local.getEntityDetails(initiative.id);
		const cloudDetails = await cloud.getEntityDetails(initiative.id);
		expect(localDetails.entity).toEqual(localBefore.entity);
		expect(cloudDetails.entity).toEqual(cloudBefore.entity);
	});

	it("repeated synchronize keeps rejecting unresolved divergent heads", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);
		await local.setEntityBody({ entityId: initiative.id, body: "Edited locally, first", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });
		await cloud.setEntityBody({ entityId: initiative.id, body: "Edited in the cloud, second", expectedRevision: initiative.revision, expectedContentHash: initiative.contentHash });

		await expect(synchronizeStores(local, cloud)).rejects.toBeInstanceOf(SynchronizeConflictError);
		await expect(synchronizeStores(local, cloud)).rejects.toMatchObject({ recordId: initiative.id, currentRevision: 2 });
	});

	it("propagates a handoff entity and handsOff relation without duplication on repeated runs", async () => {
		const initiative = await local.createEntity({ kind: "initiative", title: "Dual-mode platform" });
		await synchronizeStores(local, cloud);

		const handoff = await local.createEntity({
			kind: "handoff",
			title: "Resume platform work",
			body: "Picking up from here.",
			links: [{ relationType: "handsOff", targetId: initiative.id }]
		});

		const summary = await synchronizeStores(local, cloud);
		expect(summary.entitiesCreatedCloud).toContain(handoff.id);
		expect(summary.relationsAppliedToCloud).toBe(1);
		expect(await cloud.listEntities("handoff")).toContainEqual(expect.objectContaining({ id: handoff.id }));
		expect((await cloud.getEntityDetails(handoff.reference)).outgoing).toContainEqual(
			expect.objectContaining({ relationType: "handsOff", entity: expect.objectContaining({ id: initiative.id }) })
		);

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.entriesAppliedToLocal).toBe(0);
		expect(repeatSummary.entriesAppliedToCloud).toBe(0);
		expect(repeatSummary.relationsAppliedToLocal).toBe(0);
		expect(repeatSummary.relationsAppliedToCloud).toBe(0);
	});

	it("imports compatible context and tombstoned-term extensions in either direction", async () => {
		const localContext = await local.upsertContext({ title: "Language", summary: "Initial summary." });
		const localTerm = await local.defineContextTerm({ term: "tenant", definition: "A workspace's isolated slice of data." });
		await synchronizeStores(local, cloud);

		const cloudContext = (await cloud.getContextDetails()).context;
		await cloud.upsertContext({ title: "Language", summary: "Cloud extension.", expectedRevision: cloudContext.revision, expectedContentHash: cloudContext.contentHash });
		await local.forgetContextTerm({ term: "tenant", expectedRevision: localTerm.term.revision, expectedContentHash: localTerm.term.contentHash });

		const summary = await synchronizeStores(local, cloud);
		expect(summary.contextsAppliedToLocal).toBe(1);
		expect(summary.contextTermsAppliedToCloud).toBe(1);

		const localDetails = await local.getContextDetails();
		const cloudDetails = await cloud.getContextDetails();
		expect(localDetails.context).toEqual(expect.objectContaining({ summary: "Cloud extension.", revision: localContext.context.revision + 1 }));
		expect(cloudDetails.context).toEqual(expect.objectContaining({ summary: "Cloud extension." }));
		expect(localDetails.terms).toEqual([]);
		expect(cloudDetails.terms).toEqual([]);
		await expect(cloud.materializeContextTermRevision({ term: "tenant", revision: 1 })).resolves.toMatchObject({ definition: "A workspace's isolated slice of data.", headRevision: 2, tombstone: false });
		await expect(cloud.materializeContextTermRevision({ term: "tenant", revision: 2 })).resolves.toMatchObject({ headRevision: 2, tombstone: true });

		const repeatSummary = await synchronizeStores(local, cloud);
		expect(repeatSummary.contextsAppliedToLocal).toBe(0);
		expect(repeatSummary.contextsAppliedToCloud).toBe(0);
		expect(repeatSummary.contextTermsAppliedToLocal).toBe(0);
		expect(repeatSummary.contextTermsAppliedToCloud).toBe(0);
	});

	it("rejects divergent context heads without changing either side", async () => {
		const initial = await local.upsertContext({ title: "Shared", summary: "Initial." });
		await synchronizeStores(local, cloud);
		const cloudInitial = (await cloud.getContextDetails()).context;
		await local.upsertContext({ title: "Local", summary: "Local edit.", expectedRevision: initial.context.revision, expectedContentHash: initial.context.contentHash });
		await cloud.upsertContext({ title: "Cloud", summary: "Cloud edit.", expectedRevision: cloudInitial.revision, expectedContentHash: cloudInitial.contentHash });

		await expect(synchronizeStores(local, cloud)).rejects.toMatchObject({ name: "SynchronizeConflictError", recordKind: "context", recordId: "default", currentRevision: 2 });
		expect((await local.getContextDetails()).context.title).toBe("Local");
		expect((await cloud.getContextDetails()).context.title).toBe("Cloud");
	});

	it("rejects divergent context-term heads without changing either side", async () => {
		const initial = await local.defineContextTerm({ term: "tenant", definition: "Initial." });
		await synchronizeStores(local, cloud);
		const cloudInitial = (await cloud.getContextDetails()).terms.find((term) => term.term === "tenant")!;
		await local.defineContextTerm({ term: "tenant", definition: "Local edit.", expectedRevision: initial.term.revision, expectedContentHash: initial.term.contentHash });
		await cloud.defineContextTerm({ term: "tenant", definition: "Cloud edit.", expectedRevision: cloudInitial.revision, expectedContentHash: cloudInitial.contentHash });

		await expect(synchronizeStores(local, cloud)).rejects.toMatchObject({ name: "SynchronizeConflictError", recordKind: "context-term", recordId: initial.term.id, currentRevision: 2 });
		expect((await local.getContextDetails()).terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "Local edit." }));
		expect((await cloud.getContextDetails()).terms).toContainEqual(expect.objectContaining({ term: "tenant", definition: "Cloud edit." }));
	});
});
