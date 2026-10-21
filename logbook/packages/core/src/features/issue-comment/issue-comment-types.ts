import { createHash } from "node:crypto";

import { materializeRevisionChain } from "../entity-store/materialize-revision-chain.js";
import { applyReverseFieldPatch, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, type ReverseFieldPatchTransition } from "../reverse-field-patch/reverse-field-patch.js";

export type IssueCommentState = {
	body: string;
	referencedIssueIds: string[];
	tombstone: boolean;
};

export type IssueCommentRevisionPatch = ReverseFieldPatchTransition & {
	revision: number;
	author: string;
	createdAt: string;
	restoredFromRevision?: number;
};

export function computeIssueCommentContentHash(body: string, referencedIssueIds: string[], tombstone: boolean): string {
	return createHash("sha256").update(JSON.stringify({ body, referencedIssueIds, tombstone })).digest("hex");
}

export function materializeIssueCommentFromPatches(
	head: IssueCommentState & { revision: number; createdAt: string },
	patches: IssueCommentRevisionPatch[],
	targetRevision: number
): IssueCommentState {
	return materializeRevisionChain({
		recordLabel: "issue comment",
		headState: { body: head.body, referencedIssueIds: head.referencedIssueIds, tombstone: head.tombstone },
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (state, patch) => applyReverseFieldPatch(state, patch, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY),
		createError: (message) => new Error(message)
	}).state;
}