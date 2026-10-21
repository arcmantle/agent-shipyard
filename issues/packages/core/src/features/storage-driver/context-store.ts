import type {
	ContextDetails,
	ContextWriteResult,
	ContextDirectory,
	ContextListResult,
	DefineContextTermResult,
	DefineContextTermAcknowledgement,
	ForgetContextTermResult,
	MaterializedContextRevision,
	MaterializedContextTermRevision,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "../context/context-types.js";

/**
 * The context/glossary half of the storage-driver seam (ADR "Backends mirror
 * one another per feature, behind all-async feature interfaces"), split out
 * of `StorageDriver` so a reader who knows one backend's `LocalContextStore`/
 * `PgContextStore` can read the other.
 */
export interface ContextStore {
	listContexts(): Promise<ContextListResult>;
	getContextDetails(input?: { scopeRef?: string }): Promise<ContextDetails>;
	getContextDirectory(): Promise<ContextDirectory>;
	queryContextDirectory(input?: QueryContextDirectoryInput): Promise<QueryContextDirectoryResult>;
	upsertContext(input: { scopeRef?: string; title: string; summary: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ContextWriteResult>;
	defineContextTerm(input: { scopeRef?: string; term: string; definition: string; avoid?: string[]; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<DefineContextTermAcknowledgement>;
	forgetContextTerm(input: { scopeRef?: string; term: string; author?: string; expectedRevision?: number; expectedContentHash?: string }): Promise<ForgetContextTermResult>;
	materializeContextRevision(input: { scopeRef?: string; revision: number }): Promise<MaterializedContextRevision>;
	materializeContextTermRevision(input: { scopeRef?: string; term: string; revision: number }): Promise<MaterializedContextTermRevision>;
	restoreContextRevision(input: { scopeRef?: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextRevision>;
	restoreContextTermRevision(input: { scopeRef?: string; term: string; revision: number; author?: string; expectedRevision: number; expectedContentHash: string }): Promise<MaterializedContextTermRevision>;
}
