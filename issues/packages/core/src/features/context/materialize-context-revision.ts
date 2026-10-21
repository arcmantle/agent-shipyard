import { materializeRevisionChain } from "../entity-store/materialize-revision-chain.js";
import { applyReverseFieldPatch, CONTEXT_REVERSE_PATCH_REGISTRY, CONTEXT_TERM_REVERSE_PATCH_REGISTRY } from "../reverse-field-patch/reverse-field-patch.js";
import {
	ContextRevisionError,
	type ContextRevisionPatch,
	type ContextTermRevisionPatch,
	type MaterializedContextRevision,
	type MaterializedContextTermRevision
} from "./context-types.js";

export function materializeContextFromPatches(
	head: { key: string; title: string; summary: string; revision: number; createdAt: string },
	patches: ContextRevisionPatch[],
	targetRevision: number
): MaterializedContextRevision {
	const materialized = materializeRevisionChain({
		recordLabel: `context ${head.key}`,
		headState: { title: head.title, summary: head.summary },
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (state, patch) => applyReverseFieldPatch(state, patch, CONTEXT_REVERSE_PATCH_REGISTRY),
		createError: (message, headRevision) => new ContextRevisionError(
			head.key,
			message.startsWith("Broken") ? "broken-chain" : "revision-out-of-range",
			message,
			headRevision
		)
	});

	return {
		contextKey: head.key,
		targetRevision,
		headRevision: head.revision,
		...materialized.state,
		author: materialized.author,
		createdAt: materialized.createdAt,
		restoredFromRevision: patches.find((patch) => patch.revision === targetRevision)?.restoredFromRevision ?? null
	};
}

export function materializeContextTermFromPatches(
	head: { id: string; contextKey: string; term: string; definition: string; avoid: string[]; tombstone: boolean; revision: number; createdAt: string },
	patches: ContextTermRevisionPatch[],
	targetRevision: number
): MaterializedContextTermRevision {
	const materialized = materializeRevisionChain({
		recordLabel: `context term ${head.term} in ${head.contextKey}`,
		headState: { term: head.term, definition: head.definition, avoid: head.avoid, tombstone: head.tombstone },
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (state, patch) => applyReverseFieldPatch(state, patch, CONTEXT_TERM_REVERSE_PATCH_REGISTRY),
		createError: (message, headRevision) => new ContextRevisionError(
			head.contextKey,
			message.startsWith("Broken") ? "broken-chain" : "revision-out-of-range",
			message,
			headRevision,
			head.term
		)
	});

	return {
		id: head.id,
		contextKey: head.contextKey,
		targetRevision,
		headRevision: head.revision,
		...materialized.state,
		author: materialized.author,
		createdAt: materialized.createdAt,
		restoredFromRevision: patches.find((patch) => patch.revision === targetRevision)?.restoredFromRevision ?? null
	};
}