import { describe, expect, it } from "vitest";
import {
	applyReverseTextPatch,
	applyReverseFieldPatch,
	computeCanonicalStateHash,
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	createReverseFieldPatch,
	createReverseTextPatch,
	ENTITY_REVERSE_PATCH_REGISTRY
} from "../../index.js";

describe("reverse field patch codec", () => {
	it("reconstructs a large UTF-8 predecessor with bytes proportional to a tiny edit", () => {
		const repeatedText = "Revision history keeps context precise. café 🚀\n".repeat(1_200);
		const predecessor = `${repeatedText}The original decision.${repeatedText}`;
		const successor = `${repeatedText}The revised decision.${repeatedText}`;

		const patch = createReverseTextPatch(successor, predecessor);

		expect(new TextEncoder().encode(predecessor).byteLength).toBeGreaterThanOrEqual(50_000);
		expect(applyReverseTextPatch(successor, patch)).toBe(predecessor);
		expect(patch.byteLength).toBeLessThan(128);
	});

	it("selects REPLACE when its exact encoding is smaller than a reverse diff", () => {
		const predecessor = "Completely different predecessor text.";
		const successor = "An unrelated successor value with no shared edges.";

		const patch = createReverseTextPatch(successor, predecessor);

		expect(patch[1]).toBe(4);
		expect(applyReverseTextPatch(successor, patch)).toBe(predecessor);
	});

	it("rejects operations that split a UTF-8 code point", () => {
		const patch = Uint8Array.from([1, 1, 1, 2, 3]);

		expect(() => applyReverseTextPatch("🚀", patch)).toThrow("UTF-8 boundary");
	});

	it("hashes the complete canonical entity state", () => {
		const base = { title: "Title", body: "Body", bodySource: "authored", status: "todo", parentId: null, tombstone: false };
		const baseHash = computeCanonicalStateHash(base, ENTITY_REVERSE_PATCH_REGISTRY);

		for (const changed of [
			{ ...base, bodySource: "generated" },
			{ ...base, status: "done" },
			{ ...base, parentId: "INIT1" },
			{ ...base, tombstone: true }
		]) {
			expect(computeCanonicalStateHash(changed, ENTITY_REVERSE_PATCH_REGISTRY)).not.toBe(baseHash);
		}
	});

	it("applies entity text, scalar, nullable, and tombstone field patches", () => {
		const predecessor = { title: "Original", body: "Large body", bodySource: "authored", status: "todo", parentId: null as string | null, tombstone: false };
		const successor = { title: "Revised", body: "Large body!", bodySource: "generated", status: "done", parentId: "INIT2" as string | null, tombstone: true };

		const transition = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);

		expect(transition.patchFormat).toBe(1);
		expect(transition.sourceHash).toBe(computeCanonicalStateHash(successor, ENTITY_REVERSE_PATCH_REGISTRY));
		expect(transition.targetHash).toBe(computeCanonicalStateHash(predecessor, ENTITY_REVERSE_PATCH_REGISTRY));
		expect(applyReverseFieldPatch(successor, transition, ENTITY_REVERSE_PATCH_REGISTRY)).toEqual(predecessor);
	});

	it("rejects duplicate field ids", () => {
		const predecessor = { title: "Title", body: "Body", bodySource: "authored", status: "todo", parentId: null as string | null, tombstone: false };
		const successor = { ...predecessor, parentId: "INIT2" };
		const transition = createReverseFieldPatch(successor, predecessor, ENTITY_REVERSE_PATCH_REGISTRY);
		transition.reversePatch = Uint8Array.from([...transition.reversePatch, ...transition.reversePatch]);

		expect(() => applyReverseFieldPatch(successor, transition, ENTITY_REVERSE_PATCH_REGISTRY)).toThrow("duplicate field 5");
	});

	it("applies context and context-term registries through the shared envelope", () => {
		const contextPredecessor = { title: "Original", summary: "Earlier summary" };
		const contextSuccessor = { title: "Revised", summary: "Current summary" };
		const termPredecessor = { definition: "Earlier definition", avoid: ["old term"], tombstone: false };
		const termSuccessor = { definition: "Current definition", avoid: ["new term"], tombstone: true };

		expect(applyReverseFieldPatch(
			contextSuccessor,
			createReverseFieldPatch(contextSuccessor, contextPredecessor, CONTEXT_REVERSE_PATCH_REGISTRY),
			CONTEXT_REVERSE_PATCH_REGISTRY
		)).toEqual(contextPredecessor);
		expect(applyReverseFieldPatch(
			termSuccessor,
			createReverseFieldPatch(termSuccessor, termPredecessor, CONTEXT_TERM_REVERSE_PATCH_REGISTRY),
			CONTEXT_TERM_REVERSE_PATCH_REGISTRY
		)).toEqual(termPredecessor);
	});

	it("fails closed for malformed streams and transition integrity mismatches", () => {
		expect(() => applyReverseTextPatch("a", Uint8Array.from([1, 99, 0]))).toThrow("unknown opcode");
		expect(() => applyReverseTextPatch("a", Uint8Array.from([1, 1, 0]))).toThrow("not fully consumed");
		expect(() => applyReverseTextPatch("a", Uint8Array.from([1, 3, 2, 97]))).toThrow("out of range");

		const state = { title: "Title", body: "Body", bodySource: "authored", status: "todo", parentId: null, tombstone: false };
		const hash = computeCanonicalStateHash(state, ENTITY_REVERSE_PATCH_REGISTRY);
		const transition = { patchFormat: 1, reversePatch: Uint8Array.from([99, 2, 4, 110, 117, 108, 108]), sourceHash: hash, targetHash: hash };
		expect(() => applyReverseFieldPatch(state, transition, ENTITY_REVERSE_PATCH_REGISTRY)).toThrow("unknown field 99");
		expect(() => applyReverseFieldPatch(state, { ...transition, patchFormat: 2 }, ENTITY_REVERSE_PATCH_REGISTRY)).toThrow("Unsupported");
		expect(() => applyReverseFieldPatch(state, { ...transition, sourceHash: "wrong" }, ENTITY_REVERSE_PATCH_REGISTRY)).toThrow("source hash mismatch");

		const valid = createReverseFieldPatch({ ...state, title: "New" }, state, ENTITY_REVERSE_PATCH_REGISTRY);
		expect(() => applyReverseFieldPatch({ ...state, title: "New" }, { ...valid, targetHash: "wrong" }, ENTITY_REVERSE_PATCH_REGISTRY)).toThrow("target hash mismatch");
	});
});