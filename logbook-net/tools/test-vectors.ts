// Exports deterministic test vectors from the real TypeScript pure functions.
// Run with Bun:
//   bun logbook-net/tools/test-vectors.ts          write logbook-net/contract/test-vectors/*.json
//   bun logbook-net/tools/test-vectors.ts --check  fail when the files differ from a fresh export
//
// Vectors keep literal expected values. Derivation outputs (IDs, references,
// hashes, patches, keys) are never normalized.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const coreSrc = path.join(repoRoot, "logbook/packages/core/src");
const apiLocalSrc = path.join(repoRoot, "logbook/packages/api-local/src");
export const vectorDirectory = path.join(repoRoot, "logbook-net/contract/test-vectors");

const core = {
	reference: await import(path.join(coreSrc, "features/entity-store/canonical-reference.ts")),
	termId: await import(path.join(coreSrc, "features/context/context-term-id.ts")),
	user: await import(path.join(coreSrc, "features/user-directory/user-directory.ts")),
	entityHash: await import(path.join(coreSrc, "features/entity-store/domain.ts")),
	contextHash: await import(path.join(coreSrc, "features/context/context-types.ts")),
	commentHash: await import(path.join(coreSrc, "features/issue-comment/issue-comment-types.ts")),
	planEntryHash: await import(path.join(coreSrc, "features/plan-entry/plan-entry-types.ts")),
	patch: await import(path.join(coreSrc, "features/reverse-field-patch/reverse-field-patch.ts")),
	recordKey: await import(path.join(coreSrc, "features/revision-patch-ledger/record-key.ts")),
	sanitize: await import(path.join(coreSrc, "utilities/tenant-identity.ts"))
};
const projectIdentity = await loadProjectIdentity();

// ---------------------------------------------------------------- vector model

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Outcome = { value: Json } | { error: string };
export type Vector = { name: string; behavior: string; input: Json; expected: Outcome };
export type VectorFile = { format: 1; group: string; vectors: Vector[] };

function attempt(operation: () => Json): Outcome {
	try {
		return { value: operation() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => {
	if (!/^([0-9a-f]{2})*$/.test(text)) throw new Error(`Vector input is not valid hex: ${text}`);
	return Uint8Array.from(Buffer.from(text, "hex"));
};

// Each behavior recomputes its output from the vector input with the real source.
type Input = Record<string, any>;
export const behaviors: Record<string, (input: Input) => Json> = {
	"entity-identity": (i) => ({ ...core.reference.deriveMigratedEntityIdentity(i.kind, i.legacyAlias) }),
	"context-identity": (i) => ({ ...core.reference.deriveMigratedContextIdentity(i.contextKey) }),
	"context-term-id": (i) => core.termId.deriveMigratedContextTermId(i.contextKey, i.term),
	"user-identity": (i) => ({ ...core.user.deriveUserIdentity(i.authenticationSubject) }),
	"encode-reference": (i) => core.reference.encodeCanonicalReference(i.kind, i.stableId),
	"decode-reference": (i) => ({ ...core.reference.decodeCanonicalReference(i.reference) }),
	"short-reference": (i) => core.reference.shortEntityReference(i.entity),
	"direct-selector": (i) => core.reference.isDirectEntitySelector(i.selector),
	"entity-content-hash": (i) => core.entityHash.computeEntityContentHash(i.title, i.body),
	"context-content-hash": (i) => core.contextHash.computeContextContentHash(i.title, i.summary),
	"context-term-content-hash": (i) => core.contextHash.computeContextTermContentHash(i.term, i.definition, i.avoid, i.tombstone),
	"issue-comment-content-hash": (i) => core.commentHash.computeIssueCommentContentHash(i.body, i.referencedIssueIds, i.tombstone),
	"plan-entry-content-hash": (i) => core.planEntryHash.computePlanEntryContentHash(i),
	"canonical-state-hash": (i) => core.patch.computeCanonicalStateHash(i.state, registryFor(i.registry)),
	"reverse-text-patch": (i) => {
		const patch = core.patch.createReverseTextPatch(i.successor, i.predecessor);
		return { patch: hex(patch), applied: core.patch.applyReverseTextPatch(i.successor, patch) };
	},
	"apply-reverse-text-patch": (i) => core.patch.applyReverseTextPatch(i.successor, unhex(i.patch)),
	"reverse-field-patch": (i) => {
		const registry = registryFor(i.registry);
		const transition = core.patch.createReverseFieldPatch(i.successor, i.predecessor, registry);
		const applied = core.patch.applyReverseFieldPatch(i.successor, transition, registry);
		return {
			patchFormat: transition.patchFormat,
			reversePatch: hex(transition.reversePatch),
			sourceHash: transition.sourceHash,
			targetHash: transition.targetHash,
			applied
		};
	},
	"apply-reverse-field-patch": (i) =>
		core.patch.applyReverseFieldPatch(i.successor, {
			patchFormat: i.patchFormat,
			reversePatch: unhex(i.reversePatch),
			sourceHash: i.sourceHash,
			targetHash: i.targetHash
		}, registryFor(i.registry)),
	"encode-record-key": (i) => encodeKey(i.recordKind, i.value),
	"decode-record-key": (i) => ({ ...core.recordKey.decodeRevisionPatchRecordKey(i.recordKind, i.recordKey) }),
	"sanitize-path-segment": (i) => core.sanitize.sanitizePathSegment(i.value),
	"resolve-project-identity": (i) => withFixture(i.fixture, i.environment ?? {}, (directory, environment) =>
		({ ...projectIdentity.resolveProjectIdentity(directory, environment) }))
};

const registries: Record<string, readonly unknown[]> = {
	entity: core.patch.ENTITY_REVERSE_PATCH_REGISTRY,
	context: core.patch.CONTEXT_REVERSE_PATCH_REGISTRY,
	"context-term": core.patch.CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	"issue-comment": core.patch.ISSUE_COMMENT_REVERSE_PATCH_REGISTRY,
	"plan-entry": core.patch.PLAN_ENTRY_REVERSE_PATCH_REGISTRY
};
function registryFor(name: string): any {
	const registry = registries[name];
	if (!registry) throw new Error(`Unknown registry ${name}`);
	return registry;
}
const keyEncoders: Record<string, (value: string) => string> = {
	entity: core.recordKey.encodeEntityRecordKey,
	context: core.recordKey.encodeContextRecordKey,
	"context-term": core.recordKey.encodeContextTermRecordKey,
	"issue-comment": core.recordKey.encodeIssueCommentRecordKey,
	"plan-entry": core.recordKey.encodePlanEntryRecordKey
};
function encodeKey(recordKind: string, value: string): string {
	return keyEncoders[recordKind]!(value);
}

export function recompute(vector: Vector): Outcome {
	const behavior = behaviors[vector.behavior];
	if (!behavior) return { error: `Unknown behavior ${vector.behavior}` };
	return attempt(() => behavior(vector.input as Input));
}

function make(behavior: string, cases: [name: string, input: Json][]): Vector[] {
	return cases.map(([name, input]) => {
		const vector: Vector = { name, behavior, input, expected: { value: null } };
		vector.expected = recompute(vector);
		return vector;
	});
}

/** Returns the names of vectors whose recomputed result differs from the stored expected result. */
export function verifyVectors(file: VectorFile): string[] {
	return file.vectors
		.filter((vector) => JSON.stringify(recompute(vector)) !== JSON.stringify(vector.expected))
		.map((vector) => vector.name);
}

// ---------------------------------------------------------------- inputs

const STRINGS: [string, string][] = [
	["empty", ""],
	["ascii", "alpha"],
	["colon", "a:b:c"],
	["space and punctuation", " spaced out; ok. "],
	["multi-byte letters", "éèü"],
	["cjk", "日本語"],
	["emoji surrogate pair", "😀x"],
	["combining mark", "é"],
	["newlines", "line1\nline2\r\nline3"],
	["nul character", "a\u0000b"]
];

const ENTITY_KINDS = ["project", "epic", "version", "initiative", "prd", "userStory", "adr", "issue", "debt", "handoff", "plan"];
const REFERENCE_KINDS = ["planEntry", ...ENTITY_KINDS, "context", "contextTerm", "issueComment"];

function stableIdVectors(): VectorFile {
	const entity: [string, Json][] = [];
	for (const kind of ENTITY_KINDS) entity.push([`${kind} / default alias`, { kind, legacyAlias: "default" }]);
	for (const [label, alias] of STRINGS) entity.push([`issue / ${label}`, { kind: "issue", legacyAlias: alias }]);
	const context: [string, Json][] = STRINGS.map(([label, contextKey]) => [label, { contextKey }]);
	const term: [string, Json][] = [
		["empty key and term", { contextKey: "", term: "" }],
		["ascii", { contextKey: "initiative:INIT1", term: "Port slice" }],
		["boundary: key and term shift", { contextKey: "ab", term: "c" }],
		["boundary: key and term shift (swapped)", { contextKey: "a", term: "bc" }],
		["unicode", { contextKey: "日本", term: "😀" }],
		["colon in term", { contextKey: "k", term: "a:b" }]
	];
	const user: [string, Json][] = [
		["system subject", { authenticationSubject: "agent-issues:system" }],
		...STRINGS.map(([label, authenticationSubject]): [string, Json] => [label, { authenticationSubject }])
	];
	return {
		format: 1,
		group: "stable-ids",
		vectors: [
			...make("entity-identity", entity),
			...make("context-identity", context),
			...make("context-term-id", term),
			...make("user-identity", user)
		]
	};
}

const SAMPLE_UUIDS = [
	"00000000-0000-0000-0000-000000000000",
	"ffffffff-ffff-ffff-ffff-ffffffffffff",
	"01234567-0123-0123-0123-0123456789ab",
	"549c4b57-de4a-4399-b099-816aa14a58d1",
	"7C9E6679-7425-40DE-944B-E07FC1F90AE7"
];

function referenceVectors(): VectorFile {
	const encode: [string, Json][] = [];
	for (const kind of REFERENCE_KINDS) encode.push([`${kind} / sample`, { kind, stableId: "549c4b57-de4a-4399-b099-816aa14a58d1" }]);
	for (const stableId of SAMPLE_UUIDS) encode.push([`issue / ${stableId}`, { kind: "issue", stableId }]);
	encode.push(["invalid uuid", { kind: "issue", stableId: "not-a-uuid" }]);
	encode.push(["uuid without dashes", { kind: "issue", stableId: "549c4b57de4a4399b099816aa14a58d1" }]);

	const decode: [string, Json][] = [
		...REFERENCE_KINDS.map((kind): [string, Json] => [`round trip ${kind}`, { reference: core.reference.encodeCanonicalReference(kind, "549c4b57-de4a-4399-b099-816aa14a58d1") }]),
		["issue", { reference: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6H" }],
		["initiative", { reference: "INIT_3HE813DWZ69ZBTMCHMJ2PGJZV3" }],
		["plan entry", { reference: "PLAN_ENTRY_5EY3H1CM5893E8R84JAZ8EV1KC" }],
		["lowercase", { reference: "iss_2mkh5nfqja8ecv16c1daggmmp6h" }],
		["unknown prefix", { reference: "ZZZ_2MKH5NFQJA8ECV16C1DAGMMP6H" }],
		["missing separator", { reference: "ISS2MKH5NFQJA8ECV16C1DAGMMP6H" }],
		["short payload", { reference: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6" }],
		["long payload", { reference: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6HH" }],
		["invalid character U", { reference: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6U" }],
		["exceeds uuid entropy", { reference: "ISS_ZZZZZZZZZZZZZZZZZZZZZZZZZZ" }],
		["all zero", { reference: "ISS_00000000000000000000000000" }],
		["max uuid", { reference: "ISS_7ZZZZZZZZZZZZZZZZZZZZZZZZZ" }]
	];

	const shortOf = (id: string, kind: string): [string, Json] => [`${kind} / ${id || "empty id"}`, { entity: { id, kind } }];
	const short: [string, Json][] = [
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "issue"),
		shortOf("12da5d89-df65-40f0-9a6e-514316a9b784", "issue"),
		shortOf("71720236-f3e6-4fd7-aa32-3490ad097f63", "initiative"),
		shortOf("", "issue"),
		shortOf("日本語", "adr"),
		shortOf("a", "plan"),
		shortOf("a-much-longer-id-that-is-not-a-uuid-at-all", "prd"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "context"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "contextTerm"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "issueComment"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "planEntry"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "userStory"),
		shortOf("549c4b57-de4a-4399-b099-816aa14a58d1", "unknownkind"),
		["stored short reference wins", { entity: { id: "x", kind: "issue", shortReference: "ISS_R4JQE0" } }],
		["empty stored short reference falls back", { entity: { id: "x", kind: "issue", shortReference: "" } }]
	];

	const selector: [string, Json][] = [
		["stable id", { selector: "549c4b57-de4a-4399-b099-816aa14a58d1" }],
		["uppercase stable id", { selector: "549C4B57-DE4A-4399-B099-816AA14A58D1" }],
		["canonical reference", { selector: "ISS_2MKH5NFQJA8ECV16C1DAGMMP6H" }],
		["repository name", { selector: "agent-issues" }],
		["empty", { selector: "" }],
		["malformed reference", { selector: "ISS_nope" }]
	];

	return {
		format: 1,
		group: "references",
		vectors: [
			...make("encode-reference", encode),
			...make("decode-reference", decode),
			...make("short-reference", short),
			...make("direct-selector", selector)
		]
	};
}

function hashVectors(): VectorFile {
	const textPairs: [string, string, string][] = [
		["empty", "", ""],
		["title only", "Title", ""],
		["body only", "", "Body"],
		["separator ambiguity A", "a\n", "b"],
		["separator ambiguity B", "a", "\nb"],
		["unicode", "Ünïcödé 日本語", "😀 body\nwith lines"],
		["combining mark", "é", "é"],
		["crlf", "t", "l1\r\nl2"]
	];
	const entity = textPairs.map(([name, title, body]): [string, Json] => [name, { title, body }]);
	const context = textPairs.map(([name, title, summary]): [string, Json] => [name, { title, summary }]);
	const term: [string, Json][] = [
		["empty live", { term: "", definition: "", avoid: [], tombstone: false }],
		["live with avoid", { term: "Port slice", definition: "One feature group", avoid: ["port unit", "feature port"], tombstone: false }],
		["tombstone", { term: "Port slice", definition: "One feature group", avoid: [], tombstone: true }],
		["avoid order matters", { term: "t", definition: "d", avoid: ["b", "a"], tombstone: false }],
		["unicode", { term: "日本語", definition: "😀\n\"quoted\" \\ back", avoid: ["é"], tombstone: false }],
		["control characters", { term: "a\u0000b\u001f", definition: "  ", avoid: [], tombstone: false }]
	];
	const comment: [string, Json][] = [
		["empty", { body: "", referencedIssueIds: [], tombstone: false }],
		["references", { body: "See", referencedIssueIds: ["549c4b57-de4a-4399-b099-816aa14a58d1", "12da5d89-df65-40f0-9a6e-514316a9b784"], tombstone: false }],
		["tombstone", { body: "gone", referencedIssueIds: [], tombstone: true }],
		["unicode", { body: "日本語 😀", referencedIssueIds: [], tombstone: false }]
	];
	const planEntry: [string, Json][] = [
		["scope entry", { role: "scope", body: "Make it work", scopeDirection: "in", referencedEntityIds: [], supersededEntryIds: [], tombstone: false }],
		["null direction", { role: "decision", body: "", scopeDirection: null, referencedEntityIds: [], supersededEntryIds: [], tombstone: false }],
		["references and superseded", { role: "decision", body: "d", scopeDirection: null, referencedEntityIds: ["a", "b"], supersededEntryIds: ["c"], tombstone: false }],
		["tombstone", { role: "scope", body: "x", scopeDirection: "out", referencedEntityIds: [], supersededEntryIds: [], tombstone: true }],
		["unicode", { role: "scope", body: "日本語 😀", scopeDirection: "in", referencedEntityIds: [], supersededEntryIds: [], tombstone: false }],
		["key order of input does not matter", { tombstone: false, supersededEntryIds: [], referencedEntityIds: [], scopeDirection: null, body: "o", role: "decision" }]
	];
	const state: [string, Json][] = [
		["entity initial", { registry: "entity", state: { title: "T", body: "B", bodySource: "authored", status: "todo", parentId: null, tombstone: false, category: null, priority: null, type: null } }],
		["entity missing fields serialize as null", { registry: "entity", state: { title: "T", body: "B" } }],
		["entity extra fields ignored", { registry: "entity", state: { title: "T", body: "B", status: "done", revision: 9, extra: "ignored" } }],
		["context", { registry: "context", state: { title: "T", summary: "S" } }],
		["context-term", { registry: "context-term", state: { term: "t", definition: "d", avoid: ["x"], tombstone: false } }],
		["issue-comment", { registry: "issue-comment", state: { body: "b", referencedIssueIds: ["i"], tombstone: false } }],
		["plan-entry", { registry: "plan-entry", state: { role: "scope", body: "b", scopeDirection: "in", referencedEntityIds: [], supersededEntryIds: [], tombstone: false } }]
	];
	return {
		format: 1,
		group: "content-hashes",
		vectors: [
			...make("entity-content-hash", entity),
			...make("context-content-hash", context),
			...make("context-term-content-hash", term),
			...make("issue-comment-content-hash", comment),
			...make("plan-entry-content-hash", planEntry),
			...make("canonical-state-hash", state)
		]
	};
}

function longText(length: number, seed: string): string {
	let text = "";
	while (text.length < length) text += seed;
	return text.slice(0, length);
}

function patchVectors(): VectorFile {
	const textCases: [string, string, string][] = [
		["identical", "same", "same"],
		["both empty", "", ""],
		["predecessor empty", "now", ""],
		["successor empty", "", "was"],
		["append in successor", "abcdef", "abc"],
		["append in predecessor", "abc", "abcdef"],
		["prefix change", "Xbcdef", "Abcdef"],
		["suffix change", "abcdeX", "abcdeA"],
		["middle replace", "abcXYZdef", "abcdef"],
		["middle insert in predecessor", "abcdef", "abcXYZdef"],
		["completely different", "aaaa", "bbbb"],
		["multi-byte middle", "aéb", "aüb"],
		["emoji replace", "a😀b", "a😁b"],
		["emoji only", "😀", "😁"],
		["cjk edit", "日本語のテキスト", "日本語のテスト"],
		["combining mark", "éx", "ex"],
		["shared leading byte of different emoji", "a😀", "a😃"],
		["crlf versus lf", "a\r\nb", "a\nb"],
		["long text edit (varint length over 127 bytes)", longText(300, "abc ") + "X", longText(300, "abc ")],
		["long unicode text (varint length over 127 bytes)", longText(200, "日本") + "!", longText(200, "日本") + "?"],
		["very long insert (varint length over 16383 bytes)", longText(20000, "z") + "mid" + "end", longText(20000, "z") + "end"]
	];
	const text = textCases.map(([name, successor, predecessor]): [string, Json] => [name, { successor, predecessor }]);

	const textApplyErrors: [string, Json][] = [
		["unsupported format byte", { successor: "abc", patch: "0201" }],
		["empty patch", { successor: "abc", patch: "" }],
		["unterminated length", { successor: "abc", patch: "0101" + "80" }],
		["copy beyond successor", { successor: "abc", patch: "01" + "01" + "09" }],
		["copy splits a UTF-8 boundary", { successor: "é", patch: "01" + "01" + "01" }],
		["skip splits a UTF-8 boundary", { successor: "😀", patch: "01" + "02" + "02" + "01" + "02" }],
		["insert beyond patch", { successor: "", patch: "01" + "03" + "05" + "6162" }],
		["replace length mismatch", { successor: "", patch: "01" + "04" + "01" + "6162" }],
		["unknown opcode", { successor: "abc", patch: "01" + "09" + "00" }],
		["source not fully consumed", { successor: "abc", patch: "01" + "01" + "01" }],
		["valid hand-written patch", { successor: "abc", patch: "01" + "01" + "03" }],
		["valid insert", { successor: "ac", patch: "01" + "0101" + "030162" + "0101" }]
	];

	const base = { title: "Title", body: "Body", bodySource: "authored", status: "todo", parentId: null, tombstone: false, category: null, priority: null, type: null };
	const fieldCases: [string, string, Json, Json][] = [
		["entity: no change", "entity", base, { ...base }],
		["entity: title edit", "entity", { ...base, title: "New title" }, base],
		["entity: body edit", "entity", { ...base, body: "Body\n\nMore" }, base],
		["entity: status change", "entity", { ...base, status: "done" }, base],
		["entity: parent set then cleared", "entity", { ...base, parentId: "549c4b57-de4a-4399-b099-816aa14a58d1" }, base],
		["entity: tombstone", "entity", { ...base, tombstone: true }, base],
		["entity: category priority type", "entity", { ...base, category: "technical", priority: "high", type: "pioneer-ticket" }, base],
		["entity: every field changes", "entity", { title: "A", body: "B", bodySource: "generated", status: "done", parentId: "p", tombstone: true, category: "other", priority: "low", type: "pioneer-map" }, base],
		["entity: unicode title and body", "entity", { ...base, title: "日本語 😀", body: "é́" }, { ...base, title: "日本語", body: "é" }],
		["entity: empty text fields", "entity", { ...base, title: "", body: "" }, base],
		["entity: long body", "entity", { ...base, body: longText(5000, "line of text\n") + "!" }, { ...base, body: longText(5000, "line of text\n") }],
		["context: summary edit", "context", { title: "T", summary: "Summary two" }, { title: "T", summary: "Summary one" }],
		["context: title and summary", "context", { title: "T2", summary: "" }, { title: "T1", summary: "S" }],
		["context-term: definition edit", "context-term", { term: "t", definition: "new", avoid: [], tombstone: false }, { term: "t", definition: "old", avoid: [], tombstone: false }],
		["context-term: avoid list change", "context-term", { term: "t", definition: "d", avoid: ["a", "b"], tombstone: false }, { term: "t", definition: "d", avoid: ["a"], tombstone: false }],
		["context-term: rename and tombstone", "context-term", { term: "new", definition: "d", avoid: [], tombstone: true }, { term: "old", definition: "d", avoid: [], tombstone: false }],
		["issue-comment: body and references", "issue-comment", { body: "b2", referencedIssueIds: ["x"], tombstone: false }, { body: "b1", referencedIssueIds: [], tombstone: false }],
		["issue-comment: tombstone", "issue-comment", { body: "b", referencedIssueIds: [], tombstone: true }, { body: "b", referencedIssueIds: [], tombstone: false }],
		["plan-entry: body and direction", "plan-entry", { role: "scope", body: "new", scopeDirection: "out", referencedEntityIds: [], supersededEntryIds: [], tombstone: false }, { role: "scope", body: "old", scopeDirection: "in", referencedEntityIds: [], supersededEntryIds: [], tombstone: false }],
		["plan-entry: references superseded tombstone", "plan-entry", { role: "decision", body: "b", scopeDirection: null, referencedEntityIds: ["a", "b"], supersededEntryIds: ["c"], tombstone: true }, { role: "scope", body: "b", scopeDirection: "in", referencedEntityIds: [], supersededEntryIds: [], tombstone: false }]
	];
	const field = fieldCases.map(([name, registry, successor, predecessor]): [string, Json] => [name, { registry, successor, predecessor }]);

	// Tampered transitions use a real transition as their base so the failure is one specific step.
	const real = createTransition("entity", { ...base, title: "New" }, base);
	const tampered: [string, Json][] = [
		["source hash mismatch", { registry: "entity", successor: { ...base, title: "New" }, ...real, sourceHash: "0".repeat(64) }],
		["target hash mismatch", { registry: "entity", successor: { ...base, title: "New" }, ...real, targetHash: "0".repeat(64) }],
		["unsupported patch format", { registry: "entity", successor: { ...base, title: "New" }, ...real, patchFormat: 2 }],
		["successor does not match source hash", { registry: "entity", successor: { ...base, title: "Other" }, ...real }],
		["unknown field id", { registry: "entity", successor: { ...base, title: "New" }, ...real, reversePatch: "630100" }],
		["duplicate field id", { registry: "entity", successor: { ...base, title: "New" }, ...real, reversePatch: real.reversePatch + real.reversePatch }],
		["payload out of range", { registry: "entity", successor: { ...base, title: "New" }, ...real, reversePatch: "040209" }],
		["unknown encoding", { registry: "entity", successor: { ...base, title: "New" }, ...real, reversePatch: "010900" }]
	];

	return {
		format: 1,
		group: "reverse-patches",
		vectors: [
			...make("reverse-text-patch", text),
			...make("apply-reverse-text-patch", textApplyErrors),
			...make("reverse-field-patch", field),
			...make("apply-reverse-field-patch", tampered)
		]
	};
}

function createTransition(registry: string, successor: object, predecessor: object) {
	const transition = core.patch.createReverseFieldPatch(successor, predecessor, registryFor(registry));
	return {
		patchFormat: transition.patchFormat as number,
		reversePatch: hex(transition.reversePatch),
		sourceHash: transition.sourceHash as string,
		targetHash: transition.targetHash as string
	};
}

function recordKeyVectors(): VectorFile {
	const kinds = ["entity", "context", "context-term", "issue-comment", "plan-entry"];
	const encode: [string, Json][] = [];
	for (const kind of kinds) {
		encode.push([`${kind} / uuid`, { recordKind: kind, value: "549c4b57-de4a-4399-b099-816aa14a58d1" }]);
	}
	for (const [label, value] of STRINGS) encode.push([`entity / ${label}`, { recordKind: "entity", value }]);
	encode.push(["context / initiative key", { recordKind: "context", value: "initiative:71720236-f3e6-4fd7-aa32-3490ad097f63" }]);
	encode.push(["entity / length crosses 9 to 10 bytes", { recordKind: "entity", value: "123456789" }]);
	encode.push(["entity / ten bytes", { recordKind: "entity", value: "1234567890" }]);
	encode.push(["entity / ten bytes from five two-byte characters", { recordKind: "entity", value: "ééééé" }]);
	encode.push(["entity / hundred bytes", { recordKind: "entity", value: longText(100, "k") }]);

	const decode: [string, Json][] = [];
	for (const kind of kinds) decode.push([`${kind} / uuid`, { recordKind: kind, recordKey: encodeKey(kind, "549c4b57-de4a-4399-b099-816aa14a58d1") }]);
	for (const [label, value] of STRINGS) decode.push([`entity / round trip ${label}`, { recordKind: "entity", recordKey: encodeKey("entity", value) }]);
	const malformed: [string, string][] = [
		["empty key", ""],
		["no separator", "5"],
		["no length", ":abc"],
		["leading zero length", "03:abc"],
		["negative length", "-1:a"],
		["non-numeric length", "x:abc"],
		["length longer than value", "5:abc"],
		["length shorter than value (trailing bytes)", "2:abc"],
		["trailing part", "1:a1:b"],
		["length cuts a two-byte character", "1:é"],
		["length cuts an emoji", "2:😀"],
		["zero length with trailing data", "0:a"],
		["length with space", " 1:a"],
		["huge length", "99999999999999999999:a"]
	];
	for (const [name, recordKey] of malformed) decode.push([`malformed: ${name}`, { recordKind: "entity", recordKey }]);
	decode.push(["valid empty value", { recordKind: "context", recordKey: "0:" }]);

	return {
		format: 1,
		group: "record-keys",
		vectors: [
			...make("encode-record-key", encode),
			...make("decode-record-key", decode)
		]
	};
}

// ---------------------------------------------------------------- project identity

type Fixture = { files?: Record<string, string>; directories?: string[]; workingDirectory?: string };

function projectIdentityVectors(): VectorFile {
	const sanitize: [string, Json][] = [
		["plain", { value: "agent-issues" }],
		["mixed case and spaces", { value: "  My Project  " }],
		["underscores and dots", { value: "my_project.v2" }],
		["scoped package name", { value: "@scope/package-name" }],
		["repeated separators", { value: "a---b___c" }],
		["only separators", { value: "---" }],
		["empty", { value: "" }],
		["unicode letters are removed", { value: "Projekt Übung" }],
		["cjk only", { value: "日本語" }],
		["digits", { value: "2026 Q4" }]
	];
	const gitConfig = (url: string) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
	const fixtures: [string, Fixture, Record<string, string>?][] = [
		["folder name only", { directories: ["My Folder"], workingDirectory: "My Folder", files: { "My Folder/package.json": "{}" } }],
		["package name", { files: { "package.json": JSON.stringify({ name: "@acme/Widget" }) } }],
		["package without name uses folder", { files: { "package.json": "{}" } }],
		["invalid package json uses folder", { files: { "package.json": "{not json" } }],
		["git origin https", { files: { ".git/config": gitConfig("https://example.com/org/Repo-Name.git"), "package.json": JSON.stringify({ name: "pkg" }) } }],
		["git origin scp style", { files: { ".git/config": gitConfig("git@example.com:org/Other_Repo.git") } }],
		["git origin without suffix", { files: { ".git/config": gitConfig("https://example.com/org/plain") } }],
		["git config without origin", { files: { ".git/config": "[core]\n\tbare = false\n", "package.json": JSON.stringify({ name: "from-package" }) } }],
		["git origin with trailing slash falls through", { files: { ".git/config": gitConfig("https://example.com/org/repo/"), "package.json": JSON.stringify({ name: "after-slash" }) } }],
		["git origin followed by another section with CRLF", { files: { ".git/config": "[remote \"origin\"]\r\n\turl = https://example.com/org/Crlf.git\r\n[branch \"main\"]\r\n\tremote = origin\r\n" } }],
		["git directory without config", { directories: [".git"], files: { "package.json": JSON.stringify({ name: "no-config" }) } }],
		["git file with gitdir and local config", { files: { ".git": "gitdir: ../gitdir-a\n", "../gitdir-a/config": gitConfig("https://example.com/org/Worktree-A.git") } }],
		["git file with gitdir and commondir", { files: { ".git": "gitdir: ../gitdir-b\n", "../gitdir-b/commondir": "../common\n", "../common/config": gitConfig("https://example.com/org/Common-Repo.git") } }],
		["package json array is ignored", { files: { "package.json": "[1]" } }],
		["package name that is not a string is ignored", { files: { "package.json": JSON.stringify({ name: 7 }) } }],
		["project file beats git", { files: { ".agent-issues.json": JSON.stringify({ projectIdentity: "From File" }), ".git/config": gitConfig("https://x/y/repo.git") } }],
		["extensionless project file", { files: { ".agent-issues": JSON.stringify({ projectIdentity: "Extensionless One" }) } }],
		["json project file beats extensionless", { files: { ".agent-issues.json": JSON.stringify({ projectIdentity: "json-wins" }), ".agent-issues": JSON.stringify({ projectIdentity: "plain-loses" }) } }],
		["json file without identity falls to extensionless", { files: { ".agent-issues.json": "{}", ".agent-issues": JSON.stringify({ projectIdentity: "plain-used" }) } }],
		["project file with unsanitizable identity is skipped", { files: { ".agent-issues.json": JSON.stringify({ projectIdentity: "---" }), "package.json": JSON.stringify({ name: "pkg-used" }) } }],
		["extensionless folder is ignored", { directories: [".agent-issues"], files: { "package.json": JSON.stringify({ name: "pkg-after-folder" }) } }],
		["nested working directory resolves root", { files: { "package.json": JSON.stringify({ name: "root-package" }), "sub/deep/file.txt": "" }, workingDirectory: "sub/deep" }],
		["pnpm workspace root wins over nested package", { files: { "pnpm-workspace.yaml": "", "package.json": JSON.stringify({ name: "workspace-root" }), "packages/app/package.json": JSON.stringify({ name: "app" }) }, workingDirectory: "packages/app" }]
	];
	const environmentCases: [string, Fixture, Record<string, string>][] = [
		["environment beats project file", { files: { ".agent-issues.json": JSON.stringify({ projectIdentity: "file" }) } }, { AGENT_ISSUES_PROJECT_IDENTITY: "Env Project" }],
		["empty environment is ignored", { files: { "package.json": JSON.stringify({ name: "pkg" }) } }, { AGENT_ISSUES_PROJECT_IDENTITY: "" }],
		["unsanitizable environment is ignored", { files: { "package.json": JSON.stringify({ name: "pkg" }) } }, { AGENT_ISSUES_PROJECT_IDENTITY: "***" }]
	];
	const resolve: [string, Json][] = [...fixtures.map(([name, fixture]): [string, Fixture, Record<string, string>] => [name, fixture, {}]), ...environmentCases]
		.map(([name, fixture, environment]) => [name, { fixture: fixture as Json, environment }]);
	return {
		format: 1,
		group: "project-identity",
		vectors: [
			...make("sanitize-path-segment", sanitize),
			...make("resolve-project-identity", resolve)
		]
	};
}

/** Materializes the fixture in a fresh temp folder named by the fixture, runs the callback, and removes it. */
function withFixture(fixture: Fixture, environment: Record<string, string>, run: (directory: string, environment: Record<string, string>) => Json): Json {
	const parent = mkdtempSync(path.join(tmpdir(), "logbook-vectors-"));
	try {
		// The folder-name vectors depend on the folder name, so it is fixed and not random.
		const root = path.join(parent, "fixture-root");
		mkdirSync(root, { recursive: true });
		// Root discovery walks up to the first marker. This empty marker keeps the fixture root its own
		// root wherever the temp folder lives.
		writeFileSync(path.join(root, "pnpm-workspace.yaml"), "");
		for (const directory of fixture.directories ?? []) mkdirSync(path.join(root, directory), { recursive: true });
		for (const [file, contents] of Object.entries(fixture.files ?? {})) {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), contents);
		}
		const workingDirectory = path.join(root, fixture.workingDirectory ?? "");
		mkdirSync(workingDirectory, { recursive: true });
		const result = run(workingDirectory, environment) as Record<string, Json>;
		return result;
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

async function loadProjectIdentity(): Promise<{ resolveProjectIdentity: (cwd: string, environment: Record<string, string>) => unknown }> {
	// api-local pulls in the database layer, which this tool must not install. The real
	// resolver source runs unchanged; only its two imports are supplied here.
	const databaseSource = readFileSync(path.join(apiLocalSrc, "db/database.ts"), "utf8");
	const start = databaseSource.indexOf("export function resolveTenantRootPath");
	if (start === -1) throw new Error("resolveTenantRootPath moved; update the project-identity loader.");
	const end = databaseSource.indexOf("\n}", start);
	if (end === -1) throw new Error("resolveTenantRootPath end not found; update the project-identity loader.");
	const functionSource = databaseSource.slice(start, end + 2);
	const shimDirectory = mkdtempSync(path.join(tmpdir(), "logbook-vector-shim-"));
	const tenantRootShim = path.join(shimDirectory, "tenant-root.ts");
	writeFileSync(tenantRootShim, `import { existsSync } from "node:fs";\nimport path from "node:path";\n${functionSource}`);
	const sanitizeSource = path.join(coreSrc, "utilities/tenant-identity.ts");
	const original = readFileSync(path.join(apiLocalSrc, "project-identity.ts"), "utf8");
	const source = original
		.replace('"@agent-issues/core"', JSON.stringify(sanitizeSource))
		.replace('"./db/database.js"', JSON.stringify(tenantRootShim));
	if (source.includes('"@agent-issues/core"') || source.includes('"./db/database.js"') || source === original) {
		throw new Error("project-identity.ts imports changed; update the project-identity loader.");
	}
	const loaded = path.join(shimDirectory, "project-identity.ts");
	writeFileSync(loaded, source);
	const module = await import(loaded);
	process.on("exit", () => rmSync(shimDirectory, { recursive: true, force: true }));
	return module;
}

// ---------------------------------------------------------------- namespace cross-check

const NAMESPACES = {
	entity: "agent-issues/entity-stable-id/v1",
	context: "agent-issues/context-stable-id/v1",
	contextTerm: "agent-issues/context-term-id/v1",
	user: "agent-issues/user-stable-id/v1"
} as const;

function independentId(namespace: string, parts: string[]): string {
	const hash = createHash("sha256").update(namespace).update("\0");
	for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:${part}`);
	const bytes = hash.digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const h = Buffer.from(bytes).toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The namespaces live inside the TypeScript source. This proves the source still derives from the literal values. */
export function crossCheckNamespaces(): void {
	const checks: [string, string, string][] = [
		["entity", core.reference.deriveMigratedEntityIdentity("issue", "alias").stableId, independentId(NAMESPACES.entity, ["issue", "alias"])],
		["context", core.reference.deriveMigratedContextIdentity("key").stableId, independentId(NAMESPACES.context, ["key"])],
		["context term", core.termId.deriveMigratedContextTermId("key", "term"), independentId(NAMESPACES.contextTerm, ["key", "term"])],
		["user", core.user.deriveUserIdentity("subject").id, independentId(NAMESPACES.user, ["subject"])]
	];
	for (const [name, actual, expected] of checks) {
		if (actual !== expected) throw new Error(`The ${name} stable-ID namespace in the TypeScript source no longer matches the fixed value.`);
	}
}

function namespaceVectors(): VectorFile {
	return {
		format: 1,
		group: "namespaces",
		vectors: Object.entries(NAMESPACES).map(([name, namespace]) => ({
			name: `${name} namespace`,
			behavior: "literal",
			input: { namespace: name },
			expected: { value: namespace }
		}))
	};
}
behaviors["literal"] = (input) => NAMESPACES[input.namespace as keyof typeof NAMESPACES];

// ---------------------------------------------------------------- export

export function buildAllVectors(): VectorFile[] {
	crossCheckNamespaces();
	return [namespaceVectors(), stableIdVectors(), referenceVectors(), hashVectors(), patchVectors(), recordKeyVectors(), projectIdentityVectors()];
}

export function serialize(file: VectorFile): string {
	return `${JSON.stringify(file, null, "\t")}\n`;
}

export function exportVectors(directory: string = vectorDirectory): void {
	mkdirSync(directory, { recursive: true });
	for (const file of buildAllVectors()) writeFileSync(path.join(directory, `${file.group}.json`), serialize(file));
}

export function checkVectors(directory: string = vectorDirectory): string[] {
	const problems: string[] = [];
	for (const file of buildAllVectors()) {
		const target = path.join(directory, `${file.group}.json`);
		if (!existsSync(target)) problems.push(`${file.group}.json is missing`);
		else if (readFileSync(target, "utf8") !== serialize(file)) problems.push(`${file.group}.json differs from a fresh export`);
	}
	return problems;
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		const problems = checkVectors();
		if (problems.length > 0) {
			console.error(problems.join("\n"));
			process.exit(1);
		}
		console.log("Test vectors are current.");
	} else {
		exportVectors();
		console.log(`Wrote test vectors to ${path.relative(process.cwd(), vectorDirectory)}`);
	}
}
