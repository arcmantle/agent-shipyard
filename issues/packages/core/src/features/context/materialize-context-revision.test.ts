import { describe, expect, it } from "vitest";

import {
	materializeContextFromPatches,
	materializeContextTermFromPatches
} from "./materialize-context-revision.js";
import type { ContextRevisionPatch, ContextTermRevisionPatch } from "./context-types.js";
import { CONTEXT_REVERSE_PATCH_REGISTRY, CONTEXT_TERM_REVERSE_PATCH_REGISTRY, createReverseFieldPatch } from "../reverse-field-patch/reverse-field-patch.js";

describe("context revision materialization", () => {
	it("materializes context revisions newest-first", () => {
		const first = { title: "First", summary: "First summary." };
		const second = { title: "Second", summary: "Second summary." };
		const third = { title: "Third", summary: "Third summary." };
		const patches: ContextRevisionPatch[] = [
			{
				revision: 3,
				author: "carol",
				createdAt: "2026-01-03T00:00:00.000Z",
				...createReverseFieldPatch(third, second, CONTEXT_REVERSE_PATCH_REGISTRY)
			},
			{
				revision: 2,
				author: "bob",
				createdAt: "2026-01-02T00:00:00.000Z",
				...createReverseFieldPatch(second, first, CONTEXT_REVERSE_PATCH_REGISTRY)
			}
		];

		expect(materializeContextFromPatches(
			{
				key: "default",
				title: "Third",
				summary: "Third summary.",
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			1
		)).toEqual({
			contextKey: "default",
			targetRevision: 1,
			headRevision: 3,
			title: "First",
			summary: "First summary.",
			author: "system",
			createdAt: "2026-01-01T00:00:00.000Z",
			restoredFromRevision: null
		});
	});

	it("materializes a term before its tombstone", () => {
		const first = { term: "Order", definition: "First definition.", avoid: [], tombstone: false };
		const second = { term: "Purchase", definition: "Second definition.", avoid: ["second"], tombstone: false };
		const third = { term: "Purchase", definition: "Second definition.", avoid: ["second"], tombstone: true };
		const patches: ContextTermRevisionPatch[] = [
			{
				revision: 3,
				author: "carol",
				createdAt: "2026-01-03T00:00:00.000Z",
				...createReverseFieldPatch(third, second, CONTEXT_TERM_REVERSE_PATCH_REGISTRY)
			},
			{
				revision: 2,
				author: "bob",
				createdAt: "2026-01-02T00:00:00.000Z",
				...createReverseFieldPatch(second, first, CONTEXT_TERM_REVERSE_PATCH_REGISTRY)
			}
		];

		expect(materializeContextTermFromPatches(
			{
				id: "018f0000-0000-4000-8000-000000000001",
				contextKey: "default",
				term: "Purchase",
				definition: "Second definition.",
				avoid: ["second"],
				tombstone: true,
				revision: 3,
				createdAt: "2026-01-01T00:00:00.000Z"
			},
			patches,
			1
		)).toEqual({
			id: "018f0000-0000-4000-8000-000000000001",
			contextKey: "default",
			term: "Order",
			targetRevision: 1,
			headRevision: 3,
			definition: "First definition.",
			avoid: [],
			tombstone: false,
			author: "system",
			createdAt: "2026-01-01T00:00:00.000Z",
			restoredFromRevision: null
		});
	});
});