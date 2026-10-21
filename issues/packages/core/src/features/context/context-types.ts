import { createHash } from "node:crypto";
import type { ReverseFieldPatchTransition } from "../reverse-field-patch/reverse-field-patch.js";

/**
 * The context-store result/record contract (ADR13's dialect-agnostic
 * boundary): every `StorageDriver` implementation - SQLite
 * (`@agent-issues/api-local`) and Postgres (`@agent-issues/api-pg`) alike -
 * returns these same shapes, so they live in core rather than either
 * concrete store.
 */

export const DEFAULT_CONTEXT_KEY = "default";
export const DEFAULT_CONTEXT_TITLE = "Shared Context";
export const DEFAULT_CONTEXT_SUMMARY = "Shared glossary of project-specific domain terms and preferred language.";

export type ContextRecord = {
	id: string | null;
	reference: string | null;
	shortReference: string | null;
	createdBy: string | null;
	updatedBy: string | null;
	key: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	title: string;
	summary: string;
	revision: number;
	contentHash: string;
	createdAt: string | null;
	updatedAt: string | null;
	exists: boolean;
};

export type ContextSummary = Omit<ContextRecord, "summary">;

export function toContextSummary(context: ContextRecord): ContextSummary {
	const { summary: _summary, ...result } = context;
	return result;
}

/**
 * Computes the canonical content hash for a context's mutable title and
 * summary (ADR55/ISS259). Used to populate `ContextRecord.contentHash` on
 * creation and to validate `expectedContentHash` on upsert edits.
 */
export function computeContextContentHash(title: string, summary: string): string {
	return createHash("sha256").update(`${title}\n\n${summary}`).digest("hex");
}

/**
 * Thrown when a title/summary edit presents a stale `expectedRevision` or
 * `expectedContentHash` that does not match the context's current head
 * (ADR55/ISS259). Carries the current head's revision and hash so the caller
 * can surface them in a "refresh and retry" error message.
 */
export class ContextConflictError extends Error {
	public readonly contextKey: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;

	public constructor(contextKey: string, currentRevision: number, currentContentHash: string) {
		super(
			`Stale edit for context ${contextKey}: expected a matching revision/hash but current revision is ${currentRevision}.`
		);
		this.name = "ContextConflictError";
		this.contextKey = contextKey;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}
}

export function computeContextTermContentHash(term: string, definition: string, avoid: string[], tombstone: boolean): string {
	return createHash("sha256").update(JSON.stringify({ term, definition, avoid, tombstone })).digest("hex");
}

export class ContextTermConflictError extends Error {
	public readonly contextKey: string;
	public readonly term: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;

	public constructor(contextKey: string, term: string, currentRevision: number, currentContentHash: string) {
		super(`Stale edit for context term ${term} in ${contextKey}: current revision is ${currentRevision}.`);
		this.name = "ContextTermConflictError";
		this.contextKey = contextKey;
		this.term = term;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}
}

export type ContextRevisionPatch = ReverseFieldPatchTransition & {
	revision: number;
	author: string;
	createdAt: string;
	restoredFromRevision?: number;
};

export type ContextTermRevisionPatch = ReverseFieldPatchTransition & {
	revision: number;
	author: string;
	createdAt: string;
	restoredFromRevision?: number;
};

export type MaterializedContextRevision = {
	contextKey: string;
	targetRevision: number;
	headRevision: number;
	title: string;
	summary: string;
	author: string;
	createdAt: string;
	restoredFromRevision: number | null;
};

export type MaterializedContextTermRevision = {
	id: string;
	contextKey: string;
	term: string;
	targetRevision: number;
	headRevision: number;
	definition: string;
	avoid: string[];
	tombstone: boolean;
	author: string;
	createdAt: string;
	restoredFromRevision: number | null;
};

export type ContextRevisionErrorReason = "context-not-found" | "term-not-found" | "revision-out-of-range" | "broken-chain";

export class ContextRevisionError extends Error {
	public readonly contextKey: string;
	public readonly term: string | undefined;
	public readonly reason: ContextRevisionErrorReason;
	public readonly headRevision: number | undefined;

	public constructor(contextKey: string, reason: ContextRevisionErrorReason, message: string, headRevision?: number, term?: string) {
		super(message);
		this.name = "ContextRevisionError";
		this.contextKey = contextKey;
		this.term = term;
		this.reason = reason;
		this.headRevision = headRevision;
	}
}

export type ContextTermRecord = {
	id: string;
	reference: string;
	shortReference: string;
	createdBy: string;
	updatedBy: string;
	term: string;
	definition: string;
	avoid: string[];
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
};

export type ContextTermSummary = Omit<ContextTermRecord, "definition">;

export function toContextTermSummary(term: ContextTermRecord): ContextTermSummary {
	const { definition: _definition, ...result } = term;
	return result;
}

export type ContextDetails = {
	context: ContextRecord;
	terms: ContextTermRecord[];
};

export type ContextDirectoryTermSource = {
	contextKey: string;
	contextTitle: string;
	scopeKind: "default" | "project" | "initiative";
	scopeEntityId: string | null;
	scopeLabel: string;
	definition: string;
	avoid: string[];
	updatedAt: string;
};

export type ContextDirectoryTerm = {
	term: string;
	sources: ContextDirectoryTermSource[];
	hasSharedSource: boolean;
	hasDuplicates: boolean;
	hasConflictingDefinitions: boolean;
};

export type ContextDirectory = {
	shared: ContextDetails;
	initiatives: ContextDetails[];
	terms: ContextDirectoryTerm[];
	duplicateTerms: string[];
};

export type ContextDirectoryView = "all" | "global" | "initiatives";

export type QueryContextDirectoryInput = {
	conflictsOnly?: boolean;
	query?: string;
	view?: ContextDirectoryView;
};

export type QueryContextDirectoryResult = {
	shared: ContextDetails | null;
	initiatives: ContextDetails[];
	terms: ContextDirectoryTerm[];
	duplicateTerms: string[];
	query: string;
	view: ContextDirectoryView;
	conflictsOnly: boolean;
};

export type ContextListItem = {
	context: ContextRecord;
	termCount: number;
};

export type ContextListResult = {
	contexts: ContextListItem[];
};

export type DefineContextTermResult = {
	context: ContextRecord;
	term: ContextTermRecord;
	created: boolean;
};

export type ContextWriteResult = {
	context: ContextSummary;
};

export type DefineContextTermAcknowledgement = {
	context: ContextSummary;
	term: ContextTermSummary;
	created: boolean;
};

export function toContextWriteResult(result: ContextDetails): ContextWriteResult {
	return { context: toContextSummary(result.context) };
}

export function toDefineContextTermAcknowledgement(result: DefineContextTermResult): DefineContextTermAcknowledgement {
	return {
		context: toContextSummary(result.context),
		term: toContextTermSummary(result.term),
		created: result.created
	};
}

export type ForgetContextTermResult = {
	context: ContextRecord;
	term: string;
	removed: boolean;
	currentRevision?: number;
	currentContentHash?: string;
};
