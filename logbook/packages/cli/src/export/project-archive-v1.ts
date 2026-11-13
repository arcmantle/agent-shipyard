import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	CONTEXT_REVERSE_PATCH_REGISTRY, CONTEXT_TERM_REVERSE_PATCH_REGISTRY, ENTITY_REVERSE_PATCH_REGISTRY,
	ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, PLAN_ENTRY_REVERSE_PATCH_REGISTRY,
	archiveHeadContentHash, validateProjectBundle, createReverseFieldPatch, deriveUserIdentity, decodeMigrationBundle, encodeMigrationBundle, type MigrationBundle
} from "@agent-issues/core";
import { archiveManifestV1Schema, migrationWireV1Schema, type ArchiveManifestV1 } from "./archive-v1-schema.js";
import type { DirectoryExportResult } from "./export-files.js";
import type { ArchiveReader } from "./project-archive-reader.js";

const sections = ["entities", "contexts", "contextTerms", "issueComments", "planEntries"] as const;
type Head = MigrationBundle["chains"][typeof sections[number]][number]["head"];

export function writeProjectArchiveV1(input: { bundle: MigrationBundle; projectId: string; outputPath: string; includeInstructions?: boolean; force?: boolean }): DirectoryExportResult {
	validateProjectBundle(input.bundle, input.projectId);
	if (!input.includeInstructions && Object.values(input.bundle.instructions).some((records) => records.length > 0)) throw new Error("Personal instructions require --include-instructions.");
	const outputPath = path.resolve(input.outputPath);
	const physicalOutput = existsSync(outputPath) ? realpathSync(outputPath) : outputPath;
	if (path.relative(physicalOutput, realpathSync(process.cwd())).split(path.sep)[0] !== "..") throw new Error("An export cannot replace the current directory or its parent.");
	if (existsSync(outputPath) && (!input.force || lstatSync(outputPath).isSymbolicLink() || !existsSync(path.join(outputPath, "manifest.json")))) {
		throw new Error(`Export output already exists: ${outputPath}. Use --force only to replace a project archive.`);
	}
	if (existsSync(outputPath)) archiveManifestV1Schema.parse(JSON.parse(readFileSync(path.join(outputPath, "manifest.json"), "utf8")));
	mkdirSync(path.dirname(outputPath), { recursive: true });
	const staging = mkdtempSync(path.join(path.dirname(outputPath), ".logbook-export-"));
	const files: string[] = [];
	const write = (file: string, content: string) => {
		mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
		writeFileSync(path.join(staging, file), content, "utf8");
		files.push(path.join(outputPath, file));
	};
	try {
		const wire = migrationWireV1Schema.parse(encodeMigrationBundle(input.bundle));
		const manifest: ArchiveManifestV1 = { format: "agent-logbook-project", version: 1, projectId: input.projectId, generatedAt: new Date().toISOString(), instructionsIncluded: input.includeInstructions ?? false, documents: [] };
		for (const section of sections) {
			for (const chain of wire.chains[section]) {
				const head = chain.head;
				const title = "title" in head ? head.title : "term" in head ? head.term : "role" in head ? head.role : "comment";
				const group = "kind" in head ? `entities/${head.kind}` : section;
				const file = `${group}/${head.reference}--${slug(title)}.md`;
				const originalFile = `history/${head.reference}/r${head.revision}.md`;
				write(file, headText(head));
				write(originalFile, headText(head));
				setHeadText(head, "");
				manifest.documents.push({ section, id: head.id, file, originalFile });
			}
		}
		for (const [group, records] of Object.entries(wire.instructions)) {
			for (const record of records) {
				const keyHash = createHash("sha256").update(record.itemKey).digest("hex").slice(0, 16);
				const file = `instructions/${group}/${slug(record.itemKey)}--${keyHash}--r${record.revision}.md`;
				write(file, record.body);
				record.body = file;
			}
		}
		write("structure.json", `${JSON.stringify(wire, null, 2)}\n`);
		write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
		const previous = existsSync(outputPath) ? mkdtempSync(path.join(path.dirname(outputPath), ".logbook-previous-")) : undefined;
		if (previous) renameSync(outputPath, previous);
		try {
			renameSync(staging, outputPath);
		} catch (error) {
			if (previous) renameSync(previous, outputPath);
			throw error;
		}
		if (previous) rmSync(previous, { recursive: true, force: true });
	} finally {
		if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
	}
	return { mode: "directory", scope: "project", outputPath, files: files.sort() };
}

export const readProjectArchiveV1: ArchiveReader = ({ manifest: rawManifest, readFile: read }) => {
	const manifest = archiveManifestV1Schema.parse(rawManifest);
	const wire = migrationWireV1Schema.parse(JSON.parse(read("structure.json")));
	const expected = sections.flatMap((section) => wire.chains[section].map((chain) => `${section}:${chain.head.id}`));
	const actual = manifest.documents.map((document) => `${document.section}:${document.id}`);
	if (new Set(actual).size !== actual.length || expected.length !== actual.length || expected.some((key) => !actual.includes(key))) throw new Error("Archive document index does not match its records.");
	const paths = manifest.documents.flatMap((document) => [document.file, document.originalFile]);
	if (new Set(paths).size !== paths.length) throw new Error("Duplicate archive document path.");
	const edits: Array<{ section: typeof sections[number]; id: string; body: string }> = [];
	for (const document of manifest.documents) {
		const chain = wire.chains[document.section].find((item) => item.head.id === document.id)!;
		setHeadText(chain.head, read(document.originalFile));
		const body = read(document.file);
		if (body !== headText(chain.head)) edits.push({ section: document.section, id: document.id, body });
	};
	for (const records of Object.values(wire.instructions)) for (const record of records) record.body = read(record.body);
	if (!manifest.instructionsIncluded && Object.values(wire.instructions).some((records) => records.length > 0)) throw new Error("Archive contains unselected personal instructions.");
	const bundle = decodeMigrationBundle(wire);
	validateProjectBundle(bundle, manifest.projectId);
	const registries = { entities: ENTITY_REVERSE_PATCH_REGISTRY, contexts: CONTEXT_REVERSE_PATCH_REGISTRY, contextTerms: CONTEXT_TERM_REVERSE_PATCH_REGISTRY, issueComments: ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, planEntries: PLAN_ENTRY_REVERSE_PATCH_REGISTRY };
	const editor = deriveUserIdentity("archive:markdown-edit");
	const editedReferences: string[] = [];
	const now = new Date().toISOString();
	for (const edit of edits) {
		const chain = bundle.chains[edit.section].find((item) => item.head.id === edit.id)!;
		const previous = { ...chain.head };
		setHeadText(chain.head, edit.body);
		if ("bodySource" in chain.head) chain.head.bodySource = "authored";
		chain.head.revision++;
		chain.head.updatedAt = now;
		chain.head.updatedBy = editor.id;
		chain.head.contentHash = archiveHeadContentHash(chain.head);
		chain.deltas.push({ id: randomUUID(), revision: chain.head.revision, author: editor.id, createdAt: now, ...createReverseFieldPatch(chain.head, previous, registries[edit.section]) });
		editedReferences.push(chain.head.reference);
	}
	if (edits.length > 0 && !bundle.chains.users.some((user) => user.id === editor.id)) bundle.chains.users.push({ ...editor, displayName: "Archive Markdown edit", updatedAt: now });
	validateProjectBundle(bundle, manifest.projectId);
	return { bundle, manifest, editedReferences };
}

function headText(head: Head): string {
	if ("summary" in head) return head.summary;
	if ("definition" in head) return head.definition;
	return head.body;
}

function setHeadText(head: Head, text: string): void {
	if ("summary" in head) head.summary = text;
	else if ("definition" in head) head.definition = text;
	else head.body = text;
}

function slug(title: string): string {
	return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/g, "") || "record";
}
