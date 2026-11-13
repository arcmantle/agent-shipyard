import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { deleteEntity, ensureDatabase, SqliteStore, updateEntityStatus } from "@agent-issues/api-local";
import { encodeMigrationBundle, materializeFromPatches, selectProjectBundle } from "@agent-issues/core";
import { readProjectArchive, writeProjectArchive } from "./project-archive.js";
import { migrationWireV1Schema } from "./archive-v1-schema.js";

const directories: string[] = [];
const stores: SqliteStore[] = [];

async function openStore(projectIdentity = "archive") {
	const directory = mkdtempSync(path.join(tmpdir(), "logbook-archive-"));
	directories.push(directory);
	const { executor } = await ensureDatabase(path.join(directory, "data.db"), { tenant: "test", projectIdentity });
	const store = new SqliteStore(executor);
	stores.push(store);
	return { store, directory, executor };
}

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("rejects unsupported versions before reading version-specific archive files", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "logbook-archive-version-"));
	directories.push(directory);
	writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ format: "agent-logbook-project", version: 2, futureMetadata: { layout: "another-format" } }));
	expect(() => readProjectArchive(directory)).toThrow("Unsupported project archive version: 2. Supported versions: 1.");
});

it("exports personal instructions only with explicit selection and preserves their history", async () => {
	const { store, directory } = await openStore();
	await store.importInstructionBundle({ version: "archive-test", items: [{ key: "fragment/archive-default", kind: "fragment", body: "Default text." }] });
	await store.createInstructionFragment({ key: "fragment/archive-example", version: "archive-test", body: "Use readable project files.\n" });
	const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project")!;
	const source = await store.exportMigrationBundle();
	const excluded = selectProjectBundle(source, project.id);
	expect(excluded.instructions).toEqual({ overrides: [], personalFragments: [], history: [] });
	const selected = selectProjectBundle(source, project.id, true);
	const outputPath = path.join(directory, "export");
	expect(() => writeProjectArchive({ bundle: selected, projectId: project.id, outputPath })).toThrow(/include-instructions/);
	writeProjectArchive({ bundle: selected, projectId: project.id, outputPath, includeInstructions: true });
	const archive = readProjectArchive(outputPath);
	expect(archive.manifest.instructionsIncluded).toBe(true);
	expect(archive.bundle.instructions).toEqual(source.instructions);
});

it.each(["missing body", "duplicate document", "path traversal", "symlink escape", "damaged history", "invalid relation"] as const)("rejects an archive with %s", async (damage) => {
	const { store, directory } = await openStore();
	await store.createEntity({ kind: "initiative", title: "Archive", body: "Original." });
	const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project")!;
	const outputPath = path.join(directory, "export");
	writeProjectArchive({ bundle: selectProjectBundle(await store.exportMigrationBundle(), project.id), projectId: project.id, outputPath });
	const { manifest } = readProjectArchive(outputPath);
	const document = manifest.documents[0]!;
	if (damage === "missing body") rmSync(path.join(outputPath, document.file));
	if (damage === "duplicate document") manifest.documents.push(document);
	if (damage === "path traversal") document.file = "../data.db";
	if (damage === "symlink escape") {
		rmSync(path.join(outputPath, document.file));
		symlinkSync(path.join(directory, "data.db"), path.join(outputPath, document.file));
	}
	if (damage === "damaged history") writeFileSync(path.join(outputPath, document.originalFile), "Changed original.");
	if (damage === "invalid relation") {
		const wire = migrationWireV1Schema.parse(JSON.parse(readFileSync(path.join(outputPath, "structure.json"), "utf8")));
		wire.relations[0]!.toId = project.id;
		writeFileSync(path.join(outputPath, "structure.json"), JSON.stringify(wire));
	}
	writeFileSync(path.join(outputPath, "manifest.json"), JSON.stringify(manifest));
	expect(() => readProjectArchive(outputPath)).toThrow();
});

it("replaces only recognized archives with force and keeps unrelated files intact", async () => {
	const { store, directory } = await openStore();
	const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project")!;
	const bundle = selectProjectBundle(await store.exportMigrationBundle(), project.id);
	const outputPath = path.join(directory, "export");
	mkdirSync(outputPath);
	writeFileSync(path.join(outputPath, "keep.txt"), "Keep this file.");
	expect(() => writeProjectArchive({ bundle, projectId: project.id, outputPath, force: true })).toThrow(/already exists/);
	expect(readFileSync(path.join(outputPath, "keep.txt"), "utf8")).toBe("Keep this file.");
	const archivePath = path.join(directory, "archive");
	writeProjectArchive({ bundle, projectId: project.id, outputPath: archivePath });
	expect(() => writeProjectArchive({ bundle, projectId: project.id, outputPath: archivePath })).toThrow(/already exists/);
	writeProjectArchive({ bundle, projectId: project.id, outputPath: archivePath, force: true });
	expect(encodeMigrationBundle(readProjectArchive(archivePath).bundle)).toEqual(encodeMigrationBundle(bundle));
});

it("imports edited Markdown as a new revision without changing the original history", async () => {
	const { store, directory } = await openStore();
	const initiative = await store.createEntity({ kind: "initiative", title: "../../ A : readable title", body: "Original.\n\n" });
	const issue = await store.createEntity({ kind: "issue", title: "Comment owner", parentId: initiative.id });
	await store.createIssueComment({ issueId: issue.id, body: "Original comment." });
	const plan = await store.createEntity({ kind: "plan", title: "Plan", parentId: initiative.id });
	await store.createPlanEntry({ planId: plan.id, role: "question", body: "Original question." });
	await store.upsertContext({ scopeRef: initiative.id, title: "Terms", summary: "Original context." });
	await store.defineContextTerm({ scopeRef: initiative.id, term: "Archive", definition: "Original definition." });
	const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project")!;
	const bundle = selectProjectBundle(await store.exportMigrationBundle(), project.id);
	const outputPath = path.join(directory, "export");
	writeProjectArchive({ bundle, projectId: project.id, outputPath });
	const manifest = readProjectArchive(outputPath).manifest;
	const editedDocuments = manifest.documents.filter((item) => item.id === initiative.id || item.section !== "entities");
	for (const item of editedDocuments) writeFileSync(path.join(outputPath, item.file), "# Edited\n\n---\n\nExact body.\n\n");
	const restored = readProjectArchive(outputPath);
	const chain = restored.bundle.chains.entities.find((item) => item.head.id === initiative.id)!;
	expect(restored.editedReferences).toHaveLength(editedDocuments.length);
	expect(restored.editedReferences).toContain(initiative.reference);
	expect(chain.head).toMatchObject({ id: initiative.id, body: "# Edited\n\n---\n\nExact body.\n\n", revision: 2 });
	expect(materializeFromPatches(chain.head.id, chain.head, chain.deltas, 1).body).toBe("Original.\n\n");
	for (const document of editedDocuments) {
		const current = restored.bundle.chains[document.section].find((item) => item.head.id === document.id)!;
		const original = bundle.chains[document.section].find((item) => item.head.id === document.id)!;
		const text = "summary" in current.head ? current.head.summary : "definition" in current.head ? current.head.definition : current.head.body;
		expect(text).toBe("# Edited\n\n---\n\nExact body.\n\n");
		expect(current.head.revision).toBe(original.head.revision + 1);
	}
});

it("selects the whole project, including deleted records and historical authors", async () => {
	const { store, executor, directory } = await openStore("");
	const initiative = await store.createEntity({ kind: "initiative", title: "Archive" });
	const issue = await store.createEntity({ kind: "issue", parentId: initiative.id, title: "Deleted issue", body: "Original.\n" });
	updateEntityStatus(executor, { entityId: issue.id, status: "done", workspaceObservation: { state: "unknown", capturedAt: new Date().toISOString(), diagnostics: [{ code: "workspace-observation-failed", message: "No repository is available." }] } });
	deleteEntity(executor, { entityId: issue.id });
	await store.upsertContext({ title: "Shared terms", summary: "Original shared language." });
	const context = (await store.getContextDetails({})).context;
	await store.upsertContext({ title: "Shared terms", summary: "Current shared language.", expectedRevision: context.revision, expectedContentHash: context.contentHash });
	await store.defineContextTerm({ term: "Archive", definition: "Portable project files." });
	const bundle = await store.exportMigrationBundle();
	const project = (await store.getDatabaseSnapshot()).entities.find((entity) => entity.kind === "project")!;
	const selected = selectProjectBundle(bundle, project.id);
	expect(selected.chains.entities.find((chain) => chain.head.id === issue.id)?.head.tombstone).toBe(true);
	expect(selected.chains.contexts.map((chain) => chain.head.summary)).toEqual(["Current shared language."]);
	expect(selected.chains.contextTerms.map((chain) => chain.head.definition)).toEqual(["Portable project files."]);
	const outputPath = path.join(directory, "export");
	const result = writeProjectArchive({ bundle: selected, projectId: project.id, outputPath });
	expect(encodeMigrationBundle(readProjectArchive(outputPath).bundle)).toEqual(encodeMigrationBundle(selected));
	expect(result.files.some((file) => file.endsWith(`${issue.reference}--deleted-issue.md`))).toBe(true);
	const entityFile = result.files.find((file) => file.endsWith(`${issue.reference}--deleted-issue.md`))!;
	expect(readFileSync(entityFile, "utf8")).toBe("Original.\n");
	const destination = await openStore("");
	await destination.store.restoreProjectBundle(readProjectArchive(outputPath).bundle);
	expect(encodeMigrationBundle(selectProjectBundle(await destination.store.exportMigrationBundle(), project.id))).toEqual(encodeMigrationBundle(selected));
});
