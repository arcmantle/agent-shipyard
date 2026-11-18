import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAllVectors, checkVectors, exportVectors, recompute, serialize, vectorDirectory, verifyVectors, type VectorFile } from "./test-vectors.ts";

const files = buildAllVectors();
const find = (group: string, behavior: string, name: string): VectorFile => {
	const file = files.find((candidate) => candidate.group === group);
	if (!file) throw new Error(`No group ${group}`);
	expect(file.vectors.some((vector) => vector.behavior === behavior && vector.name === name)).toBe(true);
	return structuredClone(file);
};
const pick = (file: VectorFile, behavior: string, name: string) => file.vectors.find((vector) => vector.behavior === behavior && vector.name === name)!;

test("repeated exports from unchanged source are equal", () => {
	expect(buildAllVectors().map(serialize)).toEqual(files.map(serialize));
});

test("the committed vector files are current", () => {
	expect(checkVectors()).toEqual([]);
	expect(readdirSync(vectorDirectory).sort()).toEqual(files.map((file) => `${file.group}.json`).sort());
});

test("exporting into a clean folder writes the same bytes as the committed files", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "vectors-export-"));
	try {
		exportVectors(directory);
		for (const file of files) {
			expect(readFileSync(path.join(directory, `${file.group}.json`), "utf8")).toBe(readFileSync(path.join(vectorDirectory, `${file.group}.json`), "utf8"));
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every vector names its behavior and inputs, and names are unique within a behavior", () => {
	for (const file of files) {
		const names = file.vectors.map((vector) => `${vector.behavior}/${vector.name}`);
		expect(new Set(names).size).toBe(names.length);
		for (const vector of file.vectors) {
			expect(vector.name.length).toBeGreaterThan(0);
			expect(vector.behavior.length).toBeGreaterThan(0);
			expect(vector.input).not.toBeUndefined();
		}
	}
});

test("every stored vector matches the TypeScript source", () => {
	for (const file of files) expect(verifyVectors(file)).toEqual([]);
});

test("vectors cover the required behaviors and edge cases", () => {
	const behaviors = new Set(files.flatMap((file) => file.vectors.map((vector) => vector.behavior)));
	for (const behavior of [
		"entity-identity", "context-identity", "context-term-id", "user-identity", "encode-reference", "decode-reference", "short-reference",
		"entity-content-hash", "context-content-hash", "context-term-content-hash", "issue-comment-content-hash", "plan-entry-content-hash",
		"canonical-state-hash", "reverse-text-patch", "reverse-field-patch", "encode-record-key", "decode-record-key", "resolve-project-identity"
	]) expect(behaviors.has(behavior)).toBe(true);
	const text = files.map(serialize).join("\n");
	expect(text).toContain("日本語");
	expect(text).toContain("😀");
	expect(files.find((file) => file.group === "content-hashes")!.vectors.some((vector) => vector.name === "empty")).toBe(true);
});

test("literal tracker data matches the public helpers", () => {
	// This issue's reference, stable ID, and short reference come from the live tracker, not from this tool.
	const references = files.find((file) => file.group === "references")!;
	const id = "issue / 549c4b57-de4a-4399-b099-816aa14a58d1";
	expect(pick(references, "encode-reference", id).expected).toEqual({ value: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6H" });
	expect(pick(references, "short-reference", id).expected).toEqual({ value: "ISS_5R4V3C" });
	const namespaces = files.find((file) => file.group === "namespaces")!.vectors.map((vector) => vector.expected);
	expect(namespaces).toEqual([
		{ value: "agent-issues/entity-stable-id/v1" },
		{ value: "agent-issues/context-stable-id/v1" },
		{ value: "agent-issues/context-term-id/v1" },
		{ value: "agent-issues/user-stable-id/v1" }
	]);
});

const mutations: [group: string, behavior: string, name: string, change: (vector: VectorFile["vectors"][number]) => void][] = [
	["namespaces", "literal", "entity namespace", (vector) => { vector.expected = { value: "agent-issues/entity-stable-id/v2" }; }],
	["stable-ids", "entity-identity", "issue / default alias", (vector) => { vector.expected = { value: { stableId: "00000000-0000-8000-8000-000000000000", reference: "ISS_00000000000000000000000000" } }; }],
	["references", "encode-reference", "issue / 549c4b57-de4a-4399-b099-816aa14a58d1", (vector) => { vector.expected = { value: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6J" }; }],
	["content-hashes", "entity-content-hash", "empty", (vector) => { vector.expected = { value: "0".repeat(64) }; }],
	["reverse-patches", "reverse-field-patch", "entity: title edit", (vector) => { (vector.expected as { value: { reversePatch: string } }).value.reversePatch = "00"; }],
	["record-keys", "encode-record-key", "entity / empty", (vector) => { vector.expected = { value: "1:" }; }],
	["project-identity", "resolve-project-identity", "package name", (vector) => { vector.expected = { value: { identity: "other", source: "package-json" } }; }]
];
for (const [group, behavior, name, change] of mutations) {
	test(`changing the expected result of "${name}" in ${group} fails the comparison`, () => {
		const file = find(group, behavior, name);
		change(pick(file, behavior, name));
		expect(verifyVectors(file)).toContain(name);
	});
}

test("changing a vector input fails the comparison", () => {
	const file = find("record-keys", "encode-record-key", "entity / ascii");
	const vector = pick(file, "encode-record-key", "entity / ascii");
	(vector.input as { value: string }).value = "beta";
	expect(verifyVectors(file)).toContain("entity / ascii");
});

test("an unknown behavior is reported, not ignored", () => {
	expect(recompute({ name: "x", behavior: "nope", input: {}, expected: { value: null } })).toEqual({ error: "Unknown behavior nope" });
});
