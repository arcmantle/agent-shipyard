import {
	compareCodeCompatibility,
	DEFAULT_PROJECT_ID,
	deriveMigratedEntityIdentity,
	encodeCanonicalReference,
	getCodeCompatibility,
	parseSearchQuery,
	type CodeCompatibility,
	type SearchCapability,
	type SearchDiagnostic,
	type SearchExpression,
	type SearchRequest,
	type SearchResponse,
	type SearchResult,
	type SearchSourceType,
	type WorkspaceRetrievalContext
} from "@agent-issues/core";
import { sql } from "drizzle-orm";

import type { TenantExecutor } from "../../db/connection.js";
import { toVisibleMarkdownText } from "./visible-markdown.js";

type SearchDocumentRow = {
	source_type: SearchSourceType;
	source_id: string;
	reference: string | null;
	short_reference: string;
	title: string;
	parent_id: string | null;
	parent_label: string | null;
	project_id: string;
	project_label: string;
	status_or_role: string | null;
	updated_at: string;
	body: string;
};

type RankedSearchDocument = SearchDocumentRow & {
	matchField: SearchResult["match"]["field"];
	matchRank: number;
	codeCompatibility?: CodeCompatibility;
};

const MAXIMUM_SEARCH_CANDIDATES = 100;
const MAXIMUM_SEARCH_RESULTS = 20;
const MAXIMUM_SEARCH_DIAGNOSTICS = 100;

export class PgSearchStore {
	public constructor(executor: TenantExecutor, searchDiagnostics: SearchDiagnostic[]) {
		this.executor = executor;
		this.searchDiagnostics = searchDiagnostics;
	}

	protected readonly executor: TenantExecutor;
	protected readonly searchDiagnostics: SearchDiagnostic[];

	public getSearchCapability(): SearchCapability {
		return { state: "available" };
	}

	public getSearchDiagnostics(): SearchDiagnostic[] {
		return [...this.searchDiagnostics];
	}

	public async search(input: SearchRequest): Promise<SearchResponse> {
		const startedAt = performance.now();
		const candidateCounts = { identity: 0, fullText: 0, typo: 0 };
		try {
			if (input.filters?.sourceTypes?.length === 0 || input.query.trim().length === 0) {
				return this.recordSearchResponse({
					state: "available",
					results: [],
					...(input.retrievalContext ? { retrievalDiagnostics: input.retrievalContext.diagnostics } : {})
				}, startedAt, candidateCounts);
			}

			const parsedQuery = parseSearchQuery(input.query.trim());
			if (!parsedQuery.ok) {
				return this.recordSearchResponse({ state: "parse-error", error: parsedQuery.error }, startedAt, candidateCounts);
			}

			const sourceTypes = input.filters?.sourceTypes;
			const documents = (await this.listSearchDocuments(toIndexedTsQuery(parsedQuery.query.expression)))
				.filter((document) => sourceTypes === undefined || sourceTypes.includes(document.source_type))
				.filter((document) => input.scope.type !== "current-project" || document.project_id === input.scope.projectId);
			const rankedDocuments = documents
				.map((document) => rankSearchDocument(document, input.query.trim(), parsedQuery.query.expression))
				.filter((document): document is RankedSearchDocument => document !== undefined);
			const compatibilities = input.retrievalContext
				? await this.listCodeCompatibilities(rankedDocuments, input.retrievalContext)
				: new Map<string, CodeCompatibility>();
			const limitedDocuments = rankedDocuments
				.map((document) => ({
					...document,
					codeCompatibility: compatibilities.get(document.source_id)
						?? (input.retrievalContext && document.source_type === "entity" && document.status_or_role === "done" ? "unknown" : undefined)
				}))
				.sort((left, right) => compareSearchDocuments(left, right, input.retrievalContext))
				.slice(0, MAXIMUM_SEARCH_CANDIDATES);
			candidateCounts.identity = limitedDocuments.filter((document) => document.matchField === "identity").length;
			candidateCounts.fullText = limitedDocuments.filter((document) => document.matchField !== "identity").length;

			return this.recordSearchResponse({
				state: "available",
				results: limitedDocuments
					.slice(0, Math.min(input.limit ?? MAXIMUM_SEARCH_RESULTS, MAXIMUM_SEARCH_RESULTS))
					.map((document) => toSearchResult(document, parsedQuery.query.expression)),
				...(input.retrievalContext ? { retrievalDiagnostics: input.retrievalContext.diagnostics } : {})
			}, startedAt, candidateCounts);
		} catch (error) {
			this.recordSearchDiagnostic({
				durationMs: performance.now() - startedAt,
				candidateCounts,
				resultCount: 0,
				capability: this.getSearchCapability(),
				error: error instanceof Error ? error.name : "UnknownError"
			});
			return { state: "operational-error" };
		}
	}

	protected async listSearchDocuments(indexedTsQuery?: string): Promise<SearchDocumentRow[]> {
		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		const entitySearchFilter = indexedTsQuery === undefined ? sql`` : sql` AND to_tsvector('simple', entity.title || ' ' || entity.body) @@ to_tsquery('simple', ${indexedTsQuery})`;
		const planSearchFilter = indexedTsQuery === undefined ? sql`` : sql` AND (to_tsvector('simple', entry.body) @@ to_tsquery('simple', ${indexedTsQuery}) OR to_tsvector('simple', plan.title) @@ to_tsquery('simple', ${indexedTsQuery}))`;
		const commentSearchFilter = indexedTsQuery === undefined ? sql`` : sql` AND (to_tsvector('simple', comment.body) @@ to_tsquery('simple', ${indexedTsQuery}) OR to_tsvector('simple', issue.title) @@ to_tsquery('simple', ${indexedTsQuery}))`;
		const contextSearchFilter = indexedTsQuery === undefined ? sql`` : sql` AND to_tsvector('simple', context.title || ' ' || context.summary) @@ to_tsquery('simple', ${indexedTsQuery})`;
		const termSearchFilter = indexedTsQuery === undefined ? sql`` : sql` AND to_tsvector('simple', term.term || ' ' || term.definition) @@ to_tsquery('simple', ${indexedTsQuery})`;
		const { rows } = await this.executor.execute(sql`
			WITH structural_parents AS (
				SELECT DISTINCT ON (tenant_id, to_id) tenant_id, to_id, from_id
				FROM relations
				WHERE type IN ('owns', 'tracks', 'decomposes', 'creates', 'records')
				ORDER BY tenant_id, to_id, from_id
			)
			SELECT 'entity' AS source_type, entity.id::text AS source_id, entity.reference, entity.short_reference,
				entity.title, parent.id::text AS parent_id, parent.title AS parent_label, entity.project_id::text AS project_id,
				project.title AS project_label, entity.status AS status_or_role, entity.updated_at, entity.body
			FROM entities AS entity
			JOIN entities AS project ON project.tenant_id = entity.tenant_id AND project.id = entity.project_id AND project.kind = 'project'
			LEFT JOIN structural_parents AS structural_parent ON structural_parent.tenant_id = entity.tenant_id AND structural_parent.to_id = entity.id
			LEFT JOIN entities AS parent ON parent.tenant_id = entity.tenant_id AND parent.id = structural_parent.from_id
			WHERE entity.tombstone = FALSE${entitySearchFilter}
			UNION ALL
			SELECT 'plan-entry' AS source_type, entry.id::text AS source_id, entry.reference, entry.short_reference,
				plan.title, plan.id::text AS parent_id, plan.title AS parent_label, plan.project_id::text AS project_id,
				project.title AS project_label, entry.role AS status_or_role, entry.updated_at, entry.body
			FROM plan_entries AS entry
			JOIN entities AS plan ON plan.tenant_id = entry.tenant_id AND plan.id = entry.plan_id
			JOIN entities AS project ON project.tenant_id = entry.tenant_id AND project.id = plan.project_id AND project.kind = 'project'
			WHERE entry.tombstone = FALSE${planSearchFilter}
			UNION ALL
			SELECT 'issue-comment' AS source_type, comment.id::text AS source_id, comment.reference, comment.short_reference,
				issue.title, issue.id::text AS parent_id, issue.title AS parent_label, issue.project_id::text AS project_id,
				project.title AS project_label, NULL AS status_or_role, comment.updated_at, comment.body
			FROM issue_comments AS comment
			JOIN entities AS issue ON issue.tenant_id = comment.tenant_id AND issue.id = comment.issue_id
			JOIN entities AS project ON project.tenant_id = comment.tenant_id AND project.id = issue.project_id AND project.kind = 'project'
			WHERE comment.tombstone = FALSE${commentSearchFilter}
			UNION ALL
			SELECT 'context' AS source_type, context.id::text AS source_id, context.reference, context.short_reference,
				context.title, scope.id::text AS parent_id, scope.title AS parent_label, project.id::text AS project_id,
				project.title AS project_label, NULL AS status_or_role, context.updated_at, context.summary AS body
			FROM contexts AS context
			LEFT JOIN entities AS scope ON scope.tenant_id = context.tenant_id AND scope.id = context.scope_entity_id
			JOIN entities AS project ON project.tenant_id = context.tenant_id AND project.id = COALESCE(scope.project_id, ${defaultProjectId}::uuid) AND project.kind = 'project'
			WHERE TRUE${contextSearchFilter}
			UNION ALL
			SELECT 'context-term' AS source_type, term.id::text AS source_id, NULL AS reference, term.short_reference,
				term.term AS title, scope.id::text AS parent_id, scope.title AS parent_label, project.id::text AS project_id,
				project.title AS project_label, NULL AS status_or_role, term.updated_at, term.definition AS body
			FROM context_terms AS term
			JOIN contexts AS context ON context.tenant_id = term.tenant_id AND context.key = term.context_key
			LEFT JOIN entities AS scope ON scope.tenant_id = context.tenant_id AND scope.id = context.scope_entity_id
			JOIN entities AS project ON project.tenant_id = context.tenant_id AND project.id = COALESCE(scope.project_id, ${defaultProjectId}::uuid) AND project.kind = 'project'
			WHERE term.tombstone = FALSE${termSearchFilter}
		`);
		return (rows as SearchDocumentRow[]).map((row) => ({
			...row,
			reference: row.reference ?? encodeCanonicalReference("contextTerm", row.source_id),
			body: toVisibleMarkdownText(row.body)
		}));
	}

	protected async listCodeCompatibilities(documents: RankedSearchDocument[], context: WorkspaceRetrievalContext): Promise<Map<string, CodeCompatibility>> {
		const issueIds = documents
			.filter((document) => document.source_type === "entity" && document.status_or_role === "done")
			.map((document) => document.source_id);
		if (issueIds.length === 0) return new Map();
		const { rows } = await this.executor.execute(sql`SELECT DISTINCT ON (issue_id) issue_id::text, repository_identity, commit_sha, calculated_version_state, calculated_version
			FROM completion_observations
			WHERE tenant_id = ${this.executor.tenantId} AND issue_id IN (${sql.join(issueIds.map((issueId) => sql`${issueId}::uuid`), sql`, `)})
			ORDER BY issue_id, completion_ordinal DESC`);
		return new Map((rows as Array<{
			issue_id: string;
			repository_identity: string | null;
			commit_sha: string | null;
			calculated_version_state: "available" | "unknown";
			calculated_version: string | null;
		}>).map((observation) => [observation.issue_id, getCodeCompatibility({
			repositoryIdentity: observation.repository_identity,
			commitSha: observation.commit_sha,
			calculatedVersionState: observation.calculated_version_state,
			calculatedVersion: observation.calculated_version
		}, context)]));
	}

	protected recordSearchResponse(response: SearchResponse, startedAt: number, candidateCounts: SearchDiagnostic["candidateCounts"]): SearchResponse {
		this.recordSearchDiagnostic({
			durationMs: performance.now() - startedAt,
			candidateCounts,
			resultCount: response.state === "available" ? response.results.length : 0,
			capability: this.getSearchCapability()
		});
		return response;
	}

	protected recordSearchDiagnostic(diagnostic: SearchDiagnostic): void {
		this.searchDiagnostics.push(diagnostic);
		if (this.searchDiagnostics.length > MAXIMUM_SEARCH_DIAGNOSTICS) {
			this.searchDiagnostics.splice(0, this.searchDiagnostics.length - MAXIMUM_SEARCH_DIAGNOSTICS);
		}
	}
}

function rankSearchDocument(document: SearchDocumentRow, query: string, expression: SearchExpression): RankedSearchDocument | undefined {
	if (isIdentityMatch(document, query)) {
		return { ...document, matchField: "identity", matchRank: 0 };
	}
	if (!matchesSearchExpression(document, expression)) {
		return undefined;
	}
	const normalizedQuery = normalizeSearchTerms(query).join(" ");
	if (normalizeSearchTerms(document.title).join(" ") === normalizedQuery) {
		return { ...document, matchField: "title", matchRank: 2 };
	}
	if (matchesSearchExpression({ ...document, body: "" }, expression)) {
		return { ...document, matchField: "title", matchRank: 3 };
	}
	return { ...document, matchField: "body", matchRank: 4 };
}

function toIndexedTsQuery(expression: SearchExpression): string | undefined {
	if (expression.type === "term") {
		return expression.expansion === "strict" ? expression.value : undefined;
	}
	if (expression.type === "phrase") {
		return expression.value.split(" ").join(" <-> ");
	}
	if (expression.type === "prefix") {
		return `${expression.value}:*`;
	}
	if (expression.type === "and" || expression.type === "or") {
		const operandQueries = expression.operands.map(toIndexedTsQuery);
		return operandQueries.every((query): query is string => query !== undefined)
			? operandQueries.map((query) => `(${query})`).join(expression.type === "and" ? " & " : " | ")
			: undefined;
	}
	return undefined;
}

function isIdentityMatch(document: SearchDocumentRow, query: string): boolean {
	const normalizedQuery = query.toLocaleLowerCase();
	return [document.source_id, document.reference!, document.short_reference]
		.some((value) => value.toLocaleLowerCase() === normalizedQuery || value.toLocaleLowerCase().startsWith(normalizedQuery));
}

function matchesSearchExpression(document: Pick<SearchDocumentRow, "title" | "body">, expression: SearchExpression): boolean {
	const titleTerms = normalizeSearchTerms(document.title);
	const bodyTerms = normalizeSearchTerms(document.body);
	const documentTerms = new Set([...titleTerms, ...bodyTerms]);
	if (expression.type === "term") {
		return documentTerms.has(expression.value) || (expression.expansion === "fuzzy" && [...documentTerms].some((term) => isPermittedTypo(expression.value, term)));
	}
	if (expression.type === "phrase") {
		return matchesPhrase(titleTerms, expression.value) || matchesPhrase(bodyTerms, expression.value);
	}
	if (expression.type === "prefix") {
		return [...documentTerms].some((term) => term.startsWith(expression.value));
	}
	if (expression.type === "and") {
		return expression.operands.every((operand) => matchesSearchExpression(document, operand));
	}
	if (expression.type === "or") {
		return expression.operands.some((operand) => matchesSearchExpression(document, operand));
	}
	if (expression.type === "not") {
		return !matchesSearchExpression(document, expression.operand);
	}
	return matchesNearExpression(titleTerms, expression) || matchesNearExpression(bodyTerms, expression);
}

function normalizeSearchTerms(value: string): string[] {
	return [...new Set((value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))];
}

function matchesPhrase(documentTerms: string[], phrase: string): boolean {
	const phraseTerms = normalizeSearchTerms(phrase);
	return phraseTerms.length > 0 && documentTerms.some((_, index) => phraseTerms.every((term, phraseIndex) => documentTerms[index + phraseIndex] === term));
}

function matchesNearExpression(documentTerms: string[], expression: Extract<SearchExpression, { type: "near" }>): boolean {
	const leftTerms = normalizeSearchTerms(expression.left.value);
	const rightTerms = normalizeSearchTerms(expression.right.value);
	return documentTerms.some((_, leftIndex) => leftTerms.every((term, index) => documentTerms[leftIndex + index] === term)
		&& documentTerms.some((__, rightIndex) => rightTerms.every((term, index) => documentTerms[rightIndex + index] === term)
			&& Math.abs(rightIndex - leftIndex) <= expression.distance + Math.max(leftTerms.length, rightTerms.length)));
}

function isPermittedTypo(queryTerm: string, documentTerm: string): boolean {
	const maximumDistance = queryTerm.length >= 8 ? 2 : queryTerm.length >= 4 ? 1 : 0;
	const distance = damerauLevenshteinDistance(queryTerm, documentTerm);
	return maximumDistance > 0 && distance > 0 && distance <= maximumDistance;
}

function damerauLevenshteinDistance(source: string, target: string): number {
	const sourceCharacters = Array.from(source);
	const targetCharacters = Array.from(target);
	const maximumDistance = sourceCharacters.length + targetCharacters.length;
	const matrix = Array.from({ length: sourceCharacters.length + 2 }, () => Array<number>(targetCharacters.length + 2).fill(0));
	matrix[0]![0] = maximumDistance;
	for (let sourceIndex = 0; sourceIndex <= sourceCharacters.length; sourceIndex += 1) {
		matrix[sourceIndex + 1]![0] = maximumDistance;
		matrix[sourceIndex + 1]![1] = sourceIndex;
	}
	const lastSeen = new Map<string, number>();
	for (let sourceIndex = 1; sourceIndex <= sourceCharacters.length; sourceIndex += 1) {
		let lastMatchIndex = 0;
		for (let targetIndex = 1; targetIndex <= targetCharacters.length; targetIndex += 1) {
			const matchingSourceIndex = lastSeen.get(targetCharacters[targetIndex - 1]!) ?? 0;
			const matchingTargetIndex = lastMatchIndex;
			const substitutionCost = sourceCharacters[sourceIndex - 1] === targetCharacters[targetIndex - 1] ? 0 : 1;
			if (substitutionCost === 0) lastMatchIndex = targetIndex;
			matrix[sourceIndex + 1]![targetIndex + 1] = Math.min(
				matrix[sourceIndex]![targetIndex] + substitutionCost,
				matrix[sourceIndex + 1]![targetIndex] + 1,
				matrix[sourceIndex]![targetIndex + 1] + 1,
				matrix[matchingSourceIndex]![matchingTargetIndex] + (sourceIndex - matchingSourceIndex - 1) + 1 + (targetIndex - matchingTargetIndex - 1)
			);
		}
		lastSeen.set(sourceCharacters[sourceIndex - 1]!, sourceIndex);
	}
	return matrix[sourceCharacters.length + 1]![targetCharacters.length + 1]!;
}

function compareSearchDocuments(left: RankedSearchDocument, right: RankedSearchDocument, context?: WorkspaceRetrievalContext): number {
	const rankDifference = left.matchRank - right.matchRank;
	if (rankDifference !== 0) return rankDifference;
	if (!context?.diagnostics.length) {
		const compatibilityDifference = compareCodeCompatibility(left.codeCompatibility ?? "unknown", right.codeCompatibility ?? "unknown");
		if (compatibilityDifference !== 0) return compatibilityDifference;
	}
	const updateDifference = right.updated_at.localeCompare(left.updated_at);
	return updateDifference !== 0 ? updateDifference : left.reference!.localeCompare(right.reference!);
}

function toSearchResult(document: RankedSearchDocument, expression: SearchExpression): SearchResult {
	return {
		id: `${document.source_type}:${document.source_id}`,
		identity: { sourceType: document.source_type, sourceId: document.source_id, reference: document.reference!, shortReference: document.short_reference },
		title: document.title,
		...(document.parent_label ? { parentLabel: document.parent_label } : {}),
		projectId: document.project_id,
		projectLabel: document.project_label,
		...(document.status_or_role ? { statusOrRole: document.status_or_role } : {}),
		updatedAt: document.updated_at,
		navigationTarget: toSearchNavigationTarget(document),
		match: { field: document.matchField },
			...(document.codeCompatibility ? { codeCompatibility: document.codeCompatibility } : {}),
		...(document.matchField === "body" ? { snippet: createSearchSnippet(document.body, expression) } : {})
	};
}

function createSearchSnippet(body: string, expression: SearchExpression): SearchResult["snippet"] {
	const matchText = findSnippetMatchText(expression);
	const matchStart = body.toLocaleLowerCase().indexOf(matchText.toLocaleLowerCase());
	const text = body.slice(0, 160);
	return { text, highlights: matchStart === -1 || matchStart >= text.length ? [] : [{ start: matchStart, end: Math.min(matchStart + matchText.length, text.length) }] };
}

function findSnippetMatchText(expression: SearchExpression): string {
	if (expression.type === "term" || expression.type === "phrase" || expression.type === "prefix") return expression.value;
	if (expression.type === "and" || expression.type === "or") return findSnippetMatchText(expression.operands[0]!);
	if (expression.type === "not") return findSnippetMatchText(expression.operand);
	return expression.left.value;
}

function toSearchNavigationTarget(document: SearchDocumentRow): SearchResult["navigationTarget"] {
	if (document.source_type === "entity") return { type: "entity", entityId: document.source_id };
	if (document.source_type === "plan-entry" && document.parent_id) return { type: "plan-entry", planId: document.parent_id, entryId: document.source_id };
	if (document.source_type === "issue-comment" && document.parent_id) return { type: "issue-comment", issueId: document.parent_id, commentId: document.source_id };
	if (document.source_type === "context") return document.parent_id ? { type: "context", scopeRef: document.parent_id } : { type: "context" };
	if (document.source_type === "context-term") return document.parent_id ? { type: "context-term", scopeRef: document.parent_id, term: document.title } : { type: "context-term", term: document.title };
	throw new Error(`Search document has an unsupported navigation target: ${document.source_type}:${document.source_id}`);
}