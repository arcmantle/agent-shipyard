import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeInitiativeDirectoryExport } from "./export-files.js";
import {
	createEntity,
	defineContextTerm,
	ensureDatabase,
	getDatabaseSnapshot,
	getInitiativeBundle,
	linkEntities,
	SqliteStore,
	upsertContext
} from "@agent-issues/api-local";

let tempDir: string | null = null;
let database: { close(): void } | null = null;

async function openTestDatabase() {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-export-files-"));
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

describe("directory export", () => {
	it("writes a Plan entity with generated current state and entry history", async () => {
		const db = await openTestDatabase();
		const store = new SqliteStore(db);
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan export" });
		const plan = await store.createEntity({ kind: "plan", parentId: initiative.id, title: "Plan record", body: "## Goal\n\nExport it." });
		const question = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Which data is current?" });
		const decision = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use active entries.", supersededEntryIds: [question.id] });
		const snapshot = await store.getDatabaseSnapshot();
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");

		writeInitiativeDirectoryExport({
			bundle: await store.getInitiativeBundle(initiative.id),
			context,
			outputPath,
			planEntries: snapshot.planEntries,
			relations: snapshot.relations
		});

		const planExport = readFileSync(path.join(outputPath, "entities", `${plan.id}.md`), "utf8");
		expect(planExport).toContain("## Current Plan");
		expect(planExport).toContain(decision.reference);
		expect(planExport).toContain("## Plan Entry History");
		expect(planExport).toContain(question.reference);
	});

	it("writes debt metadata to an initiative entity export", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const debt = createEntity(db, {
			kind: "debt",
			parentId: initiative.id,
			title: "Replace legacy storage",
			category: "technical",
			priority: "high"
		});
		linkEntities(db, { fromId: initiative.id, toId: debt.id, relationType: "records" });

		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");
		writeInitiativeDirectoryExport({
			bundle: getInitiativeBundle(db, initiative.id),
			context,
			outputPath,
			relations: snapshot.relations
		});

		const debtExport = readFileSync(path.join(outputPath, "entities", `${debt.id}.md`), "utf8");
		expect(debtExport).toContain('category: "technical"');
		expect(debtExport).toContain('priority: "high"');
		expect(debtExport).toContain(`from: "${initiative.id}"`);
		expect(debtExport).toContain(`to: "${debt.id}"`);
	});

	it("writes an initiative folder grouped by entity kinds and relation types", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer", body: "Initiative body" });
		const prd = createEntity(db, { kind: "prd", parentId: initiative.id, title: "Browse Records" });
		const story = createEntity(db, { kind: "userStory", parentId: prd.id, title: "Inspect Record" });
		const issue = createEntity(db, { kind: "issue", parentId: initiative.id, title: "Render detail view" });
		linkEntities(db, { fromId: issue.id, toId: story.id, relationType: "fixes" });
		const handoff = createEntity(db, { kind: "handoff", title: "Resume here", body: "Continue from the failing test." });
		linkEntities(db, { fromId: handoff.id, toId: issue.id, relationType: "handsOff" });
		upsertContext(db, { scopeRef: initiative.id, title: "Viewer Context", summary: "Shared language for the viewer." });
		defineContextTerm(db, { scopeRef: initiative.id, term: "Record Rail", definition: "The fixed navigation lane." });

		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");
		const result = writeInitiativeDirectoryExport({
			bundle: getInitiativeBundle(db, initiative.id),
			context,
			outputPath,
			relations: snapshot.relations
		});

		expect(result.mode).toBe("directory");
		expect(existsSync(path.join(outputPath, "initiative.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "context.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "prds", `${prd.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "user-stories", `${story.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "issues", `${issue.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "entities", `${handoff.id}.md`))).toBe(true);
		expect(existsSync(path.join(outputPath, "relations", "handsOff.md"))).toBe(true);
		expect(existsSync(path.join(outputPath, "relations", "fixes.md"))).toBe(true);
		expect(readFileSync(path.join(outputPath, "relations", "fixes.md"), "utf8")).toContain(issue.id);
		expect(readFileSync(path.join(outputPath, "issues", `${issue.id}.md`), "utf8")).toContain("outgoingConnections:");
	});

	it("rejects overwriting an existing export directory without force", async () => {
		const db = await openTestDatabase();
		const initiative = createEntity(db, { kind: "initiative", title: "Console Viewer" });
		const snapshot = getDatabaseSnapshot(db);
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === initiative.id)!;
		const outputPath = path.join(tempDir!, "initiative-export");

		writeInitiativeDirectoryExport({
			bundle: getInitiativeBundle(db, initiative.id),
			context,
			outputPath,
			relations: snapshot.relations
		});

		expect(() =>
			writeInitiativeDirectoryExport({
				bundle: getInitiativeBundle(db, initiative.id),
				context,
				outputPath,
				relations: snapshot.relations
			})
		).toThrow(/--force/);
	});
});