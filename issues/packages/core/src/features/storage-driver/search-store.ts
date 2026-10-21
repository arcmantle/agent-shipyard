import type { SearchQueryParseError } from "./search-query.js";
import type { CodeCompatibility, WorkspaceObservationDiagnostic, WorkspaceRetrievalContext } from "../workspace-observation/workspace-observation.js";

export type SearchSourceType = "entity" | "context" | "context-term" | "issue-comment" | "plan-entry";

export type SearchScope =
	| { type: "current-project"; projectId: string }
	| { type: "all-projects" };

export type SearchFilters = {
	sourceTypes?: SearchSourceType[];
};

export type SearchRequest = {
	query: string;
	scope: SearchScope;
	filters?: SearchFilters;
	limit?: number;
	retrievalContext?: WorkspaceRetrievalContext;
};

export type SearchResultIdentity = {
	sourceType: SearchSourceType;
	sourceId: string;
	reference: string;
	shortReference: string;
};

export type SearchNavigationTarget =
	| { type: "entity"; entityId: string }
	| { type: "context"; scopeRef?: string }
	| { type: "context-term"; scopeRef?: string; term: string }
	| { type: "issue-comment"; issueId: string; commentId: string }
	| { type: "plan-entry"; planId: string; entryId: string };

export type SearchMatch = {
	field: "identity" | "title" | "term" | "body" | "definition";
};

export type SearchSnippet = {
	text: string;
	highlights: Array<{ start: number; end: number }>;
};

export type SearchResult = {
	id: string;
	identity: SearchResultIdentity;
	title: string;
	parentLabel?: string;
	projectId: string;
	projectLabel: string;
	statusOrRole?: string;
	updatedAt: string;
	navigationTarget: SearchNavigationTarget;
	match: SearchMatch;
	codeCompatibility?: CodeCompatibility;
	snippet?: SearchSnippet;
};

export type SearchCapability =
	| { state: "available" }
	| { state: "rebuilding" }
	| { state: "unsupported" };

export type SearchCandidateCounts = {
	identity: number;
	fullText: number;
	typo: number;
};

export type SearchDiagnostic = {
	durationMs: number;
	candidateCounts: SearchCandidateCounts;
	resultCount: number;
	capability: SearchCapability;
	error?: string;
};

export type SearchResponse =
	| { state: "available"; results: SearchResult[]; retrievalDiagnostics?: WorkspaceObservationDiagnostic[] }
	| { state: "rebuilding" }
	| { state: "unsupported" }
	| { state: "parse-error"; error: SearchQueryParseError }
	| { state: "operational-error" };

export interface SearchStore {
	getSearchCapability(): Promise<SearchCapability>;
	getSearchDiagnostics(): Promise<SearchDiagnostic[]>;
	search(input: SearchRequest): Promise<SearchResponse>;
}