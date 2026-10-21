import { compareCodeCompatibility, DEFAULT_PROJECT_ID, deriveMigratedEntityIdentity, encodeCanonicalReference, getCodeCompatibility, parseSearchQuery, type CodeCompatibility, type SearchCapability, type SearchDiagnostic, type SearchExpression, type SearchRequest, type SearchResponse, type SearchResult, type SearchSourceType, type WorkspaceRetrievalContext } from "@agent-issues/core";
import { sql, type SQL } from "drizzle-orm";

import type { SqliteExecutor } from "../../db/sqlite-executor.js";
import { toVisibleMarkdownText } from "./visible-markdown.js";

type SearchDocumentRow = {
	source_type: SearchSourceType;
	source_id: string;
	reference: string;
	short_reference: string;
	title: string;
	parent_id: string | null;
	parent_label: string | null;
	project_id: string;
	project_label: string;
	status_or_role: string | null;
	updated_at: string;
	match_field: SearchResult["match"]["field"];
	match_rank: number;
	relevance: number;
	body?: string;
	snippet_match_text?: string;
};

type ContextTermSearchRow = {
	id: string;
	short_reference: string;
	term: string;
	definition: string;
	updated_at: string;
	project_id: string;
	project_label: string;
	scope_entity_id: string | null;
	scope_label: string | null;
};

type SearchDocumentTextRow = {
	source_type: SearchSourceType;
	source_id: string;
	body: string;
};

type TypoVocabularyDocumentRow = {
	rowid: number;
	source_type: SearchSourceType;
	title: string;
	body: string;
};

type SearchDocumentIdentityRow = {
	rowid: number;
};

type SearchDocumentKeyRow = {
	source_type: SearchSourceType;
	source_id: string;
};

type TypoVocabularyMatchRow = SearchDocumentRow & {
	matched_term: string;
};

const MAXIMUM_SEARCH_CANDIDATES = 100;
const MAXIMUM_SEARCH_RESULTS = 20;
const MAXIMUM_SEARCH_DIAGNOSTICS = 100;

export class LocalSearchStore {
	public constructor(executor: SqliteExecutor) {
		this.executor = executor;
	}

	protected readonly executor: SqliteExecutor;
	protected searchDiagnostics: SearchDiagnostic[] = [];

	public getSearchCapability(): SearchCapability {
		return { state: "available" };
	}

	public getSearchDiagnostics(): SearchDiagnostic[] {
		return [...this.searchDiagnostics];
	}

	public search(input: SearchRequest): SearchResponse {
		const startedAt = performance.now();
		const candidateCounts = { identity: 0, fullText: 0, typo: 0 };
		try {
			if (input.filters?.sourceTypes?.length === 0) {
				return this.recordSearchResponse({ state: "available", results: [] }, startedAt, candidateCounts);
			}

			const query = input.query.trim();
			if (query.length === 0) {
				return this.recordSearchResponse({ state: "available", results: [] }, startedAt, candidateCounts);
			}
			const parsedQuery = parseSearchQuery(query);
			if (!parsedQuery.ok) {
				return this.recordSearchResponse({ state: "parse-error", error: parsedQuery.error }, startedAt, candidateCounts);
			}

			const projectId = input.scope.type === "current-project" ? input.scope.projectId : null;
			const resultLimit = Math.min(input.limit ?? MAXIMUM_SEARCH_RESULTS, MAXIMUM_SEARCH_RESULTS);
			const sourceTypes = input.filters?.sourceTypes;
			const includeEntities = Number(sourceTypes?.includes("entity") ?? true);
			const includePlanEntries = Number(sourceTypes?.includes("plan-entry") ?? true);
			const includeIssueComments = Number(sourceTypes?.includes("issue-comment") ?? true);
			const includeContexts = Number(sourceTypes?.includes("context") ?? true);
			const includeContextTerms = Number(sourceTypes?.includes("context-term") ?? true);
			const relevanceQuery = toFts5RelevanceQuery(parsedQuery.query.expression);
			const trigramQuery = toTrigramCandidateQuery(parsedQuery.query.expression) ?? sql`SELECT NULL AS rowid WHERE 0`;
			const trigramTitleQuery = toTrigramCandidateQuery(parsedQuery.query.expression, "title") ?? sql`SELECT NULL AS rowid WHERE 0`;
			const relevanceCte = relevanceQuery
			? sql`, full_text_scores AS (
				SELECT search_documents_fts.rowid, bm25(search_documents_fts) AS relevance
				FROM search_documents_fts
				JOIN eligible_documents ON eligible_documents.rowid = search_documents_fts.rowid
				WHERE search_documents_fts MATCH ${relevanceQuery}
			)`
			: sql`, full_text_scores AS (SELECT NULL AS rowid, 0 AS relevance WHERE 0)`;
			const identityRows = this.executor.drizzle.all<SearchDocumentRow>(sql`
			SELECT source_type, source_id, reference, short_reference, title, parent_id, parent_label, project_id,
				project_label, status_or_role, updated_at,
				CASE
					WHEN lower(source_id) = lower(${query}) OR lower(reference) = lower(${query}) OR lower(short_reference) = lower(${query}) THEN 'identity'
					WHEN source_id LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR short_reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' THEN 'identity'
					ELSE 'title'
				END AS match_field,
				CASE
					WHEN lower(source_id) = lower(${query}) OR lower(reference) = lower(${query}) OR lower(short_reference) = lower(${query}) THEN 0
					WHEN source_id LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR short_reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' THEN 1
					WHEN lower(title) = lower(${query}) THEN 2
					ELSE 3
				END AS match_rank,
				0 AS relevance
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId}
				AND (
					(${includeEntities} AND source_type = 'entity')
					OR (${includePlanEntries} AND source_type = 'plan-entry')
					OR (${includeIssueComments} AND source_type = 'issue-comment')
					OR (${includeContexts} AND source_type = 'context')
					OR (${includeContextTerms} AND source_type = 'context-term')
				)
				AND (${projectId} IS NULL OR project_id = ${projectId})
				AND (
					lower(source_id) = lower(${query})
					OR lower(reference) = lower(${query})
					OR lower(short_reference) = lower(${query})
					OR lower(title) = lower(${query})
					OR source_id LIKE ${`${escapeLike(query)}%`} ESCAPE '\\'
					OR reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\'
					OR short_reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\'
					OR title LIKE ${`${escapeLike(query)}%`} ESCAPE '\\'
				)
			ORDER BY
				CASE
					WHEN lower(source_id) = lower(${query}) OR lower(reference) = lower(${query}) OR lower(short_reference) = lower(${query}) THEN 0
					WHEN source_id LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' OR short_reference LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' THEN 1
					WHEN lower(title) = lower(${query}) THEN 2
					ELSE 3
				END,
				updated_at DESC,
				reference ASC
			LIMIT ${MAXIMUM_SEARCH_CANDIDATES}
		`);
			const fullTextRows = this.executor.drizzle.all<SearchDocumentRow>(sql`
			WITH eligible_documents AS (
				SELECT rowid
				FROM search_documents
				WHERE tenant_id = ${this.executor.tenantId}
					AND (
						(${includeEntities} AND source_type = 'entity')
						OR (${includePlanEntries} AND source_type = 'plan-entry')
						OR (${includeIssueComments} AND source_type = 'issue-comment')
						OR (${includeContexts} AND source_type = 'context')
						OR (${includeContextTerms} AND source_type = 'context-term')
					)
					AND (${projectId} IS NULL OR project_id = ${projectId})
			), matching_documents AS (
				SELECT rowid FROM (${toFts5CandidateQuery(parsedQuery.query.expression)})
				UNION
				SELECT rowid FROM (${trigramQuery})
			), title_matches AS (
				SELECT rowid FROM (${toFts5CandidateQuery(parsedQuery.query.expression, "title")})
				UNION
				SELECT rowid FROM (${trigramTitleQuery})
			) ${relevanceCte}
			SELECT document.source_type, document.source_id, document.reference, document.short_reference,
				document.title, document.parent_id, document.parent_label, document.project_id,
				document.project_label, document.status_or_role, document.updated_at, document.body,
				CASE WHEN title_matches.rowid IS NULL THEN 'body' ELSE 'title' END AS match_field,
				4 AS match_rank, COALESCE(full_text_scores.relevance, 0) AS relevance
			FROM matching_documents
			JOIN search_documents AS document ON document.rowid = matching_documents.rowid
			LEFT JOIN title_matches ON title_matches.rowid = document.rowid
			LEFT JOIN full_text_scores ON full_text_scores.rowid = document.rowid
			ORDER BY COALESCE(full_text_scores.relevance, 0), document.updated_at DESC, document.reference ASC
			LIMIT ${MAXIMUM_SEARCH_CANDIDATES}
		`);
			const typoRows = this.findTypoRows(parsedQuery.query.expression, projectId, {
			includeEntities,
			includePlanEntries,
			includeIssueComments,
			includeContexts,
			includeContextTerms
			});
			const rows = [
				...identityRows.map((row) => ({ path: "identity" as const, row })),
				...fullTextRows.map((row) => ({ path: "fullText" as const, row })),
				...typoRows.map(({ matched_term, ...row }) => ({ path: "typo" as const, row: { ...row, snippet_match_text: matched_term } }))
			].slice(0, MAXIMUM_SEARCH_CANDIDATES);
			candidateCounts.identity = rows.filter(({ path }) => path === "identity").length;
			candidateCounts.fullText = rows.filter(({ path }) => path === "fullText").length;
			candidateCounts.typo = rows.filter(({ path }) => path === "typo").length;
			const resultRows = new Map<string, SearchDocumentRow>();
			for (const { row } of rows) {
				const key = `${row.source_type}:${row.source_id}`;
				if (!resultRows.has(key) || row.match_field === "identity") {
					resultRows.set(key, row);
				}
			}

			const rankedRows = [...resultRows.values()]
				.map((row) => ({ row, codeCompatibility: input.retrievalContext ? this.getCodeCompatibility(row, input.retrievalContext) : undefined }))
				.sort((left, right) => {
					const textDifference = compareSearchTextRelevance(left.row, right.row);
					if (textDifference !== 0 || input.retrievalContext?.diagnostics.length) return textDifference;
					const compatibilityDifference = compareCodeCompatibility(left.codeCompatibility ?? "unknown", right.codeCompatibility ?? "unknown");
					return compatibilityDifference !== 0 ? compatibilityDifference : compareSearchRows(left.row, right.row);
				});
			return this.recordSearchResponse({
				state: "available",
				results: rankedRows
					.slice(0, resultLimit)
					.map(({ row, codeCompatibility }) => toSearchResult(row, parsedQuery.query.expression, codeCompatibility)),
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

	protected getCodeCompatibility(row: SearchDocumentRow, context: WorkspaceRetrievalContext): CodeCompatibility | undefined {
		if (row.source_type !== "entity" || row.status_or_role !== "done") return undefined;
		const observation = this.executor.drizzle.get<{
			repository_identity: string | null;
			commit_sha: string | null;
			calculated_version_state: "available" | "unknown";
			calculated_version: string | null;
		}>(sql`SELECT repository_identity, commit_sha, calculated_version_state, calculated_version
			FROM completion_observations
			WHERE tenant_id = ${this.executor.tenantId} AND issue_id = ${row.source_id}
			ORDER BY completion_ordinal DESC LIMIT 1`);
		return getCodeCompatibility(observation ? {
			repositoryIdentity: observation.repository_identity,
			commitSha: observation.commit_sha,
			calculatedVersionState: observation.calculated_version_state,
			calculatedVersion: observation.calculated_version
		} : {
			repositoryIdentity: null,
			commitSha: null,
			calculatedVersionState: "unknown",
			calculatedVersion: null
		}, context);
	}

	public synchronizeEntitySearchDocuments(): void {
		this.executor.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${this.executor.tenantId} AND source_type = 'entity'`);
		this.executor.drizzle.run(sql`INSERT INTO search_documents (
			tenant_id, source_type, source_id, project_id, project_label, reference,
			short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
		)
		SELECT entity.tenant_id, 'entity', entity.id, entity.project_id, project.title,
			entity.reference, entity.short_reference, entity.title, entity.body, entity.status,
			parent.id, parent.title, entity.updated_at
		FROM entities AS entity
		JOIN entities AS project
			ON project.tenant_id = entity.tenant_id
			AND project.id = entity.project_id
			AND project.kind = 'project'
		LEFT JOIN entities AS parent
			ON parent.tenant_id = entity.tenant_id
			AND parent.id = (
				SELECT relation.from_id
				FROM relations AS relation
				WHERE relation.tenant_id = entity.tenant_id
					AND relation.to_id = entity.id
					AND relation.type IN ('owns', 'tracks', 'decomposes', 'creates', 'records')
				ORDER BY relation.from_id
				LIMIT 1
			)
		WHERE entity.tenant_id = ${this.executor.tenantId} AND entity.tombstone = 0`);
	}

	public synchronizeSearchDocuments(): void {
		this.synchronizeEntitySearchDocuments();
		this.synchronizePlanEntrySearchDocuments();
		this.synchronizeIssueCommentSearchDocuments();
		this.synchronizeContextSearchDocuments();
		this.synchronizeContextTermSearchDocuments();
		this.normalizeSearchDocumentBodies();
		this.synchronizeTypoVocabulary();
	}

	public synchronizePlanEntrySearchDocument(sourceId: string): void {
		this.replaceSearchDocument("plan-entry", sourceId, () => {
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			SELECT entry.tenant_id, 'plan-entry', entry.id, plan.project_id, project.title,
				entry.reference, entry.short_reference, plan.title, entry.body, entry.role,
				plan.id, plan.title, entry.updated_at
			FROM plan_entries AS entry
			JOIN entities AS plan
				ON plan.tenant_id = entry.tenant_id
				AND plan.id = entry.plan_id
			JOIN entities AS project
				ON project.tenant_id = entry.tenant_id
				AND project.id = plan.project_id
				AND project.kind = 'project'
			WHERE entry.tenant_id = ${this.executor.tenantId} AND entry.id = ${sourceId} AND entry.tombstone = 0`);
		});
	}

	public synchronizeEntitySearchDocumentsForChange(sourceId: string): void {
		this.synchronizeSearchDocumentsByKey(this.findEntitySearchDocumentsForChange(sourceId));
	}

	public prepareEntitySearchDocumentsForChange(sourceId: string): () => void {
		const affectedDocuments = this.findEntitySearchDocumentsForChange(sourceId);
		return () => this.synchronizeSearchDocumentsByKey(affectedDocuments);
	}

	protected findEntitySearchDocumentsForChange(sourceId: string): SearchDocumentKeyRow[] {
		const affectedDocuments = this.executor.drizzle.all<SearchDocumentKeyRow>(sql`
			WITH RECURSIVE subtree(id) AS (
				SELECT ${sourceId}
				UNION
				SELECT relation.to_id
				FROM relations AS relation
				JOIN subtree ON subtree.id = relation.from_id
				WHERE relation.tenant_id = ${this.executor.tenantId}
					AND relation.type IN ('contains', 'owns', 'records', 'tracks', 'creates', 'decomposes')
			)
			SELECT source_type, source_id
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId}
				AND (
					source_id IN (SELECT id FROM subtree)
					OR parent_id IN (SELECT id FROM subtree)
					OR project_id = ${sourceId}
					OR source_id IN (
						SELECT relation.from_id
						FROM relations AS relation
						WHERE relation.tenant_id = ${this.executor.tenantId}
							AND relation.to_id = ${sourceId}
							AND relation.type = 'handsOff'
					)
				)
		`);
		affectedDocuments.push({ source_type: "entity", source_id: sourceId });
		return affectedDocuments;
	}

	protected synchronizeSearchDocumentsByKey(affectedDocuments: SearchDocumentKeyRow[]): void {
		const seen = new Set<string>();
		for (const document of affectedDocuments) {
			const key = `${document.source_type}:${document.source_id}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			this.synchronizeSearchDocument(document.source_type, document.source_id);
		}
	}

	public synchronizeEntitySearchDocument(sourceId: string): void {
		this.replaceSearchDocument("entity", sourceId, () => {
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			SELECT entity.tenant_id, 'entity', entity.id, entity.project_id, project.title,
				entity.reference, entity.short_reference, entity.title, entity.body, entity.status,
				parent.id, parent.title, entity.updated_at
			FROM entities AS entity
			JOIN entities AS project
				ON project.tenant_id = entity.tenant_id
				AND project.id = entity.project_id
				AND project.kind = 'project'
			LEFT JOIN entities AS parent
				ON parent.tenant_id = entity.tenant_id
				AND parent.id = (
					SELECT relation.from_id
					FROM relations AS relation
					WHERE relation.tenant_id = entity.tenant_id
						AND relation.to_id = entity.id
						AND relation.type IN ('owns', 'tracks', 'decomposes', 'creates', 'records')
					ORDER BY relation.from_id
					LIMIT 1
				)
			WHERE entity.tenant_id = ${this.executor.tenantId} AND entity.id = ${sourceId} AND entity.tombstone = 0`);
		});
	}

	public synchronizeIssueCommentSearchDocument(sourceId: string): void {
		this.replaceSearchDocument("issue-comment", sourceId, () => {
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			SELECT comment.tenant_id, 'issue-comment', comment.id, issue.project_id, project.title,
				comment.reference, comment.short_reference, issue.title, comment.body, NULL,
				issue.id, issue.title, comment.updated_at
			FROM issue_comments AS comment
			JOIN entities AS issue
				ON issue.tenant_id = comment.tenant_id
				AND issue.id = comment.issue_id
			JOIN entities AS project
				ON project.tenant_id = comment.tenant_id
				AND project.id = issue.project_id
				AND project.kind = 'project'
			WHERE comment.tenant_id = ${this.executor.tenantId} AND comment.id = ${sourceId} AND comment.tombstone = 0`);
		});
	}

	public synchronizeContextSearchDocument(sourceId: string): void {
		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		this.replaceSearchDocument("context", sourceId, () => {
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			SELECT context.tenant_id, 'context', context.id, project.id, project.title,
				context.reference, context.short_reference, context.title, context.summary, NULL,
				scope.id, scope.title, context.updated_at
			FROM contexts AS context
			LEFT JOIN entities AS scope
				ON scope.tenant_id = context.tenant_id
				AND scope.id = context.scope_entity_id
			JOIN entities AS project
				ON project.tenant_id = context.tenant_id
				AND project.id = COALESCE(scope.project_id, ${defaultProjectId})
				AND project.kind = 'project'
			WHERE context.tenant_id = ${this.executor.tenantId} AND context.id = ${sourceId}`);
		});
	}

	public synchronizeContextTermSearchDocument(sourceId: string): void {
		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		this.replaceSearchDocument("context-term", sourceId, () => {
			const row = this.executor.drizzle.all<ContextTermSearchRow>(sql`
				SELECT term.id, term.short_reference, term.term, term.definition, term.updated_at,
					project.id AS project_id, project.title AS project_label,
					scope.id AS scope_entity_id, scope.title AS scope_label
				FROM context_terms AS term
				JOIN contexts AS context
					ON context.tenant_id = term.tenant_id
					AND context.key = term.context_key
				LEFT JOIN entities AS scope
					ON scope.tenant_id = context.tenant_id
					AND scope.id = context.scope_entity_id
				JOIN entities AS project
					ON project.tenant_id = context.tenant_id
					AND project.id = COALESCE(scope.project_id, ${defaultProjectId})
					AND project.kind = 'project'
				WHERE term.tenant_id = ${this.executor.tenantId} AND term.id = ${sourceId} AND term.tombstone = 0
			`)[0];
			if (!row) {
				return;
			}
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			VALUES (
				${this.executor.tenantId}, 'context-term', ${row.id}, ${row.project_id}, ${row.project_label},
				${encodeCanonicalReference("contextTerm", row.id)}, ${row.short_reference}, ${row.term}, ${row.definition}, NULL,
				${row.scope_entity_id}, ${row.scope_label}, ${row.updated_at}
			)`);
		});
	}

	public synchronizePlanEntrySearchDocuments(): void {
		this.executor.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${this.executor.tenantId} AND source_type = 'plan-entry'`);
		this.executor.drizzle.run(sql`INSERT INTO search_documents (
			tenant_id, source_type, source_id, project_id, project_label, reference,
			short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
		)
		SELECT entry.tenant_id, 'plan-entry', entry.id, plan.project_id, project.title,
			entry.reference, entry.short_reference, plan.title, entry.body, entry.role,
			plan.id, plan.title, entry.updated_at
		FROM plan_entries AS entry
		JOIN entities AS plan
			ON plan.tenant_id = entry.tenant_id
			AND plan.id = entry.plan_id
		JOIN entities AS project
			ON project.tenant_id = entry.tenant_id
			AND project.id = plan.project_id
			AND project.kind = 'project'
		WHERE entry.tenant_id = ${this.executor.tenantId} AND entry.tombstone = 0`);
	}

	public synchronizeIssueCommentSearchDocuments(): void {
		this.executor.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${this.executor.tenantId} AND source_type = 'issue-comment'`);
		this.executor.drizzle.run(sql`INSERT INTO search_documents (
			tenant_id, source_type, source_id, project_id, project_label, reference,
			short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
		)
		SELECT comment.tenant_id, 'issue-comment', comment.id, issue.project_id, project.title,
			comment.reference, comment.short_reference, issue.title, comment.body, NULL,
			issue.id, issue.title, comment.updated_at
		FROM issue_comments AS comment
		JOIN entities AS issue
			ON issue.tenant_id = comment.tenant_id
			AND issue.id = comment.issue_id
		JOIN entities AS project
			ON project.tenant_id = comment.tenant_id
			AND project.id = issue.project_id
			AND project.kind = 'project'
		WHERE comment.tenant_id = ${this.executor.tenantId} AND comment.tombstone = 0`);
	}

	public synchronizeContextSearchDocuments(): void {
		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		this.executor.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${this.executor.tenantId} AND source_type = 'context'`);
		this.executor.drizzle.run(sql`INSERT INTO search_documents (
			tenant_id, source_type, source_id, project_id, project_label, reference,
			short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
		)
		SELECT context.tenant_id, 'context', context.id, project.id, project.title,
			context.reference, context.short_reference, context.title, context.summary, NULL,
			scope.id, scope.title, context.updated_at
		FROM contexts AS context
		LEFT JOIN entities AS scope
			ON scope.tenant_id = context.tenant_id
			AND scope.id = context.scope_entity_id
		JOIN entities AS project
			ON project.tenant_id = context.tenant_id
			AND project.id = COALESCE(scope.project_id, ${defaultProjectId})
			AND project.kind = 'project'
		WHERE context.tenant_id = ${this.executor.tenantId}`);
	}

	public synchronizeContextTermSearchDocuments(): void {
		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		this.executor.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${this.executor.tenantId} AND source_type = 'context-term'`);
		const rows = this.executor.drizzle.all<ContextTermSearchRow>(sql`
			SELECT term.id, term.short_reference, term.term, term.definition, term.updated_at,
				project.id AS project_id, project.title AS project_label,
				scope.id AS scope_entity_id, scope.title AS scope_label
			FROM context_terms AS term
			JOIN contexts AS context
				ON context.tenant_id = term.tenant_id
				AND context.key = term.context_key
			LEFT JOIN entities AS scope
				ON scope.tenant_id = context.tenant_id
				AND scope.id = context.scope_entity_id
			JOIN entities AS project
				ON project.tenant_id = context.tenant_id
				AND project.id = COALESCE(scope.project_id, ${defaultProjectId})
				AND project.kind = 'project'
			WHERE term.tenant_id = ${this.executor.tenantId} AND term.tombstone = 0
		`);

		for (const row of rows) {
			this.executor.drizzle.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			VALUES (
				${this.executor.tenantId}, 'context-term', ${row.id}, ${row.project_id}, ${row.project_label},
				${encodeCanonicalReference("contextTerm", row.id)}, ${row.short_reference}, ${row.term}, ${row.definition}, NULL,
				${row.scope_entity_id}, ${row.scope_label}, ${row.updated_at}
			)`);
		}
	}

	protected normalizeSearchDocumentBodies(): void {
		const rows = this.executor.drizzle.all<SearchDocumentTextRow>(sql`
			SELECT source_type, source_id, body
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId}
		`);
		for (const row of rows) {
			this.executor.drizzle.run(sql`
				UPDATE search_documents
				SET body = ${toVisibleMarkdownText(row.body)}
				WHERE tenant_id = ${this.executor.tenantId}
					AND source_type = ${row.source_type}
					AND source_id = ${row.source_id}
			`);
		}
	}

	protected synchronizeTypoVocabulary(): void {
		this.executor.drizzle.run(sql`DELETE FROM search_typo_vocabulary_documents WHERE tenant_id = ${this.executor.tenantId}`);
		this.executor.drizzle.run(sql`DELETE FROM search_typo_vocabulary WHERE tenant_id = ${this.executor.tenantId}`);
		const documents = this.executor.drizzle.all<TypoVocabularyDocumentRow>(sql`
			SELECT rowid, source_type, title, body
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId}
		`);
		for (const document of documents) {
			this.insertTypoVocabularyTerms(document, document.title, document.source_type === "context-term" ? "term" : "title");
			this.insertTypoVocabularyTerms(document, document.body, document.source_type === "context-term" ? "definition" : "body");
		}
	}

	protected replaceSearchDocument(sourceType: SearchSourceType, sourceId: string, insertDocument: () => void): void {
		const existing = this.executor.drizzle.all<SearchDocumentIdentityRow>(sql`
			SELECT rowid
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId} AND source_type = ${sourceType} AND source_id = ${sourceId}
		`)[0];
		if (existing) {
			this.executor.drizzle.run(sql`DELETE FROM search_typo_vocabulary_documents
				WHERE tenant_id = ${this.executor.tenantId} AND document_rowid = ${existing.rowid}`);
		}
		this.executor.drizzle.run(sql`DELETE FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId} AND source_type = ${sourceType} AND source_id = ${sourceId}`);

		insertDocument();
		const document = this.executor.drizzle.all<TypoVocabularyDocumentRow>(sql`
			SELECT rowid, source_type, title, body
			FROM search_documents
			WHERE tenant_id = ${this.executor.tenantId} AND source_type = ${sourceType} AND source_id = ${sourceId}
		`)[0];
		if (document) {
			const body = toVisibleMarkdownText(document.body);
			this.executor.drizzle.run(sql`UPDATE search_documents SET body = ${body}
				WHERE tenant_id = ${this.executor.tenantId} AND source_type = ${sourceType} AND source_id = ${sourceId}`);
			this.insertTypoVocabularyTerms({ ...document, body }, document.title, sourceType === "context-term" ? "term" : "title");
			this.insertTypoVocabularyTerms({ ...document, body }, body, sourceType === "context-term" ? "definition" : "body");
		}

		this.executor.drizzle.run(sql`DELETE FROM search_typo_vocabulary
			WHERE tenant_id = ${this.executor.tenantId}
				AND NOT EXISTS (
					SELECT 1 FROM search_typo_vocabulary_documents AS membership
					WHERE membership.tenant_id = search_typo_vocabulary.tenant_id
						AND membership.term = search_typo_vocabulary.term
				)`);
	}

	protected synchronizeSearchDocument(sourceType: SearchSourceType, sourceId: string): void {
		switch (sourceType) {
			case "entity":
				this.synchronizeEntitySearchDocument(sourceId);
				break;
			case "plan-entry":
				this.synchronizePlanEntrySearchDocument(sourceId);
				break;
			case "issue-comment":
				this.synchronizeIssueCommentSearchDocument(sourceId);
				break;
			case "context":
				this.synchronizeContextSearchDocument(sourceId);
				break;
			case "context-term":
				this.synchronizeContextTermSearchDocument(sourceId);
				break;
		}
	}

	protected insertTypoVocabularyTerms(document: TypoVocabularyDocumentRow, value: string, matchField: SearchResult["match"]["field"]): void {
		for (const term of normalizeSearchTerms(value)) {
			this.executor.drizzle.run(sql`INSERT OR IGNORE INTO search_typo_vocabulary (tenant_id, term)
				VALUES (${this.executor.tenantId}, ${term})`);
			this.executor.drizzle.run(sql`INSERT OR IGNORE INTO search_typo_vocabulary_documents (tenant_id, term, document_rowid, match_field)
				VALUES (${this.executor.tenantId}, ${term}, ${document.rowid}, ${matchField})`);
		}
	}

	protected findTypoRows(
		expression: SearchExpression,
		projectId: string | null,
		includedSourceTypes: {
			includeEntities: number;
			includePlanEntries: number;
			includeIssueComments: number;
			includeContexts: number;
			includeContextTerms: number;
		}
	): TypoVocabularyMatchRow[] {
		const fuzzyTerms = getFuzzyTerms(expression);
		if (fuzzyTerms.length === 0) {
			return [];
		}

		const vocabulary = this.executor.drizzle
			.all<{ term: string }>(sql`SELECT term FROM search_typo_vocabulary WHERE tenant_id = ${this.executor.tenantId}`)
			.map(({ term }) => term);
		const matchingTermsByQueryTerm = new Map<string, Set<string>>();
		for (const fuzzyTerm of fuzzyTerms) {
			const maximumDistance = getMaximumTypoDistance(fuzzyTerm);
			if (maximumDistance === 0) {
				continue;
			}
			const matchingTerms = new Set(vocabulary.filter((term) => {
				const distance = damerauLevenshteinDistance(fuzzyTerm, term);
				return distance > 0 && distance <= maximumDistance;
			}));
			if (matchingTerms.size > 0) {
				matchingTermsByQueryTerm.set(fuzzyTerm, matchingTerms);
			}
		}
		const matchedTerms = [...new Set([...matchingTermsByQueryTerm.values()].flatMap((terms) => [...terms]))];
		if (matchedTerms.length === 0) {
			return [];
		}

		const terms = sql.join(matchedTerms.map((term) => sql`${term}`), sql`, `);
		const { includeEntities, includePlanEntries, includeIssueComments, includeContexts, includeContextTerms } = includedSourceTypes;
		return this.executor.drizzle.all<TypoVocabularyMatchRow>(sql`
			SELECT document.source_type, document.source_id, document.reference, document.short_reference,
				document.title, document.parent_id, document.parent_label, document.project_id,
				document.project_label, document.status_or_role, document.updated_at, document.body,
				membership.match_field AS match_field, 5 AS match_rank, 0 AS relevance, membership.term AS matched_term
			FROM search_typo_vocabulary_documents AS membership
			JOIN search_documents AS document ON document.rowid = membership.document_rowid
			WHERE membership.tenant_id = ${this.executor.tenantId}
				AND membership.term IN (${terms})
				AND (
					(${includeEntities} AND document.source_type = 'entity')
					OR (${includePlanEntries} AND document.source_type = 'plan-entry')
					OR (${includeIssueComments} AND document.source_type = 'issue-comment')
					OR (${includeContexts} AND document.source_type = 'context')
					OR (${includeContextTerms} AND document.source_type = 'context-term')
				)
				AND (${projectId} IS NULL OR document.project_id = ${projectId})
			ORDER BY CASE membership.match_field WHEN 'title' THEN 0 WHEN 'term' THEN 0 ELSE 1 END
			LIMIT ${MAXIMUM_SEARCH_CANDIDATES}
		`).filter((row) => matchesSearchExpression(row, expression, matchingTermsByQueryTerm));
	}
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function toSearchResult(row: SearchDocumentRow, expression?: SearchExpression, codeCompatibility?: CodeCompatibility): SearchResult {
	return {
		id: `${row.source_type}:${row.source_id}`,
		identity: {
			sourceType: row.source_type,
			sourceId: row.source_id,
			reference: row.reference,
			shortReference: row.short_reference
		},
		title: row.title,
		...(row.parent_label ? { parentLabel: row.parent_label } : {}),
		projectId: row.project_id,
		projectLabel: row.project_label,
		...(row.status_or_role ? { statusOrRole: row.status_or_role } : {}),
		updatedAt: row.updated_at,
		navigationTarget: toSearchNavigationTarget(row),
		match: { field: row.match_field },
			...(codeCompatibility ? { codeCompatibility } : {}),
		...(row.body && expression && row.match_field === "body" ? { snippet: createSearchSnippet(row.body, expression, row.snippet_match_text) } : {})
	};
}

function toFts5CandidateQuery(expression: SearchExpression, column?: "title"): SQL {
	switch (expression.type) {
		case "term":
			return selectFts5Matches(expression.value, column);
		case "phrase":
			return selectFts5Matches(`"${expression.value}"`, column);
		case "prefix":
			return selectFts5Matches(`${expression.value}*`, column);
		case "and":
			return combineFts5Candidates(expression.operands.map((operand) => toFts5CandidateQuery(operand, column)), "INTERSECT");
		case "or":
			return combineFts5Candidates(expression.operands.map((operand) => toFts5CandidateQuery(operand, column)), "UNION");
		case "not":
			return sql`SELECT rowid FROM eligible_documents WHERE rowid NOT IN (${toFts5CandidateQuery(expression.operand, column)})`;
		case "near":
			return selectFts5Matches(`NEAR(${toFts5TermQuery(expression.left)} ${toFts5TermQuery(expression.right)}, ${expression.distance})`, column);
	}
}

function selectFts5Matches(query: string, column?: "title"): SQL {
	const columnQuery = column ? `${column} : (${query})` : query;
	return sql`
		SELECT search_documents_fts.rowid
		FROM search_documents_fts
		JOIN eligible_documents ON eligible_documents.rowid = search_documents_fts.rowid
		WHERE search_documents_fts MATCH ${columnQuery}
	`;
}

function toTrigramCandidateQuery(expression: SearchExpression, column?: "title"): SQL | undefined {
	if (expression.type !== "term" || expression.expansion !== "fuzzy" || expression.value.length < 3) {
		return undefined;
	}
	return sql`
		SELECT search_documents_trigram.rowid
		FROM search_documents_trigram
		JOIN eligible_documents ON eligible_documents.rowid = search_documents_trigram.rowid
		WHERE search_documents_trigram MATCH ${column ? `title : (${expression.value})` : expression.value}
	`;
}

function getFuzzyTerms(expression: SearchExpression): string[] {
	if (expression.type === "term") {
		return expression.expansion === "fuzzy" ? [expression.value] : [];
	}
	if (expression.type === "and" || expression.type === "or") {
		return expression.operands.flatMap(getFuzzyTerms);
	}
	return [];
}

function getMaximumTypoDistance(term: string): number {
	if (term.length >= 8) {
		return 2;
	}
	return term.length >= 4 ? 1 : 0;
}

function normalizeSearchTerms(value: string): string[] {
	return [...new Set((value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}]+/gu) ?? []))];
}

function matchesSearchExpression(
	document: Pick<SearchDocumentRow, "title" | "body">,
	expression: SearchExpression,
	matchingTermsByQueryTerm: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
	const titleTerms = normalizeSearchTerms(document.title);
	const bodyTerms = normalizeSearchTerms(document.body ?? "");
	const documentTerms = new Set([...titleTerms, ...bodyTerms]);
	if (expression.type === "term") {
		if (expression.expansion === "strict") {
			return documentTerms.has(expression.value);
		}
		const typoTerms = matchingTermsByQueryTerm.get(expression.value);
		return documentTerms.has(expression.value) || [...(typoTerms ?? [])].some((term) => documentTerms.has(term));
	}
	if (expression.type === "phrase") {
		return matchesPhrase(titleTerms, expression.value) || matchesPhrase(bodyTerms, expression.value);
	}
	if (expression.type === "prefix") {
		return [...documentTerms].some((term) => term.startsWith(expression.value));
	}
	if (expression.type === "and") {
		return expression.operands.every((operand) => matchesSearchExpression(document, operand, matchingTermsByQueryTerm));
	}
	if (expression.type === "or") {
		return expression.operands.some((operand) => matchesSearchExpression(document, operand, matchingTermsByQueryTerm));
	}
	if (expression.type === "not") {
		return !matchesSearchExpression(document, expression.operand, matchingTermsByQueryTerm);
	}
	return matchesNearExpression(titleTerms, expression) || matchesNearExpression(bodyTerms, expression);
}

function matchesPhrase(documentTerms: string[], phrase: string): boolean {
	const phraseTerms = normalizeSearchTerms(phrase);
	return phraseTerms.length > 0 && documentTerms.some((_, index) => phraseTerms.every((term, phraseIndex) => documentTerms[index + phraseIndex] === term));
}

function matchesNearExpression(documentTerms: string[], expression: Extract<SearchExpression, { type: "near" }>): boolean {
	const leftTerms = normalizeSearchTerms(expression.left.value);
	const rightTerms = normalizeSearchTerms(expression.right.value);
	for (let leftIndex = 0; leftIndex < documentTerms.length; leftIndex += 1) {
		if (!leftTerms.every((term, index) => documentTerms[leftIndex + index] === term)) {
			continue;
		}
		for (let rightIndex = 0; rightIndex < documentTerms.length; rightIndex += 1) {
			if (rightTerms.every((term, index) => documentTerms[rightIndex + index] === term)
				&& Math.abs(rightIndex - leftIndex) <= expression.distance + Math.max(leftTerms.length, rightTerms.length)) {
				return true;
			}
		}
	}
	return false;
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
	for (let targetIndex = 0; targetIndex <= targetCharacters.length; targetIndex += 1) {
		matrix[0]![targetIndex + 1] = maximumDistance;
		matrix[1]![targetIndex + 1] = targetIndex;
	}

	const lastSeen = new Map<string, number>();
	for (let sourceIndex = 1; sourceIndex <= sourceCharacters.length; sourceIndex += 1) {
		let lastMatchIndex = 0;
		for (let targetIndex = 1; targetIndex <= targetCharacters.length; targetIndex += 1) {
			const matchingSourceIndex = lastSeen.get(targetCharacters[targetIndex - 1]!) ?? 0;
			const matchingTargetIndex = lastMatchIndex;
			const substitutionCost = sourceCharacters[sourceIndex - 1] === targetCharacters[targetIndex - 1] ? 0 : 1;
			if (substitutionCost === 0) {
				lastMatchIndex = targetIndex;
			}
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

function toFts5TermQuery(expression: SearchExpression): string {
	if (expression.type === "term") {
		return expression.value;
	}
	if (expression.type === "phrase") {
		return `"${expression.value}"`;
	}
	throw new Error("Only terms and phrases can be NEAR operands.");
}

function toFts5RelevanceQuery(expression: SearchExpression): string | undefined {
	if (expression.type === "term" || expression.type === "phrase") {
		return toFts5TermQuery(expression);
	}
	if (expression.type === "prefix") {
		return `${expression.value}*`;
	}
	if (expression.type === "near") {
		return `NEAR(${toFts5TermQuery(expression.left)} ${toFts5TermQuery(expression.right)}, ${expression.distance})`;
	}
	if (expression.type === "not") {
		return undefined;
	}
	const queries = expression.operands
		.map(toFts5RelevanceQuery)
		.filter((query): query is string => query !== undefined);
	return queries.length > 0 ? queries.join(" OR ") : undefined;
}

function combineFts5Candidates(queries: SQL[], operator: "INTERSECT" | "UNION"): SQL {
	const [firstQuery, ...remainingQueries] = queries;
	if (!firstQuery) {
		throw new Error("Search expressions must contain at least one operand.");
	}
	return remainingQueries.reduce(
		(result, query) => sql`SELECT rowid FROM (${result}) ${sql.raw(operator)} SELECT rowid FROM (${query})`,
		firstQuery
	);
}

function compareSearchRows(left: SearchDocumentRow, right: SearchDocumentRow): number {
	const textDifference = compareSearchTextRelevance(left, right);
	if (textDifference !== 0) return textDifference;
	const updateDifference = right.updated_at.localeCompare(left.updated_at);
	return updateDifference !== 0 ? updateDifference : left.reference.localeCompare(right.reference);
}

function compareSearchTextRelevance(left: SearchDocumentRow, right: SearchDocumentRow): number {
	const rankDifference = left.match_rank - right.match_rank;
	return rankDifference !== 0 ? rankDifference : left.relevance - right.relevance;
}

function createSearchSnippet(body: string, expression: SearchExpression, matchText: string = findSnippetMatchText(expression)): SearchResult["snippet"] {
	const maximumLength = 160;
	const match = findNormalizedSearchTextMatch(body, matchText);
	const snippetStart = match && match.start > 40 ? match.start - 40 : 0;
	const snippetEnd = Math.min(body.length, snippetStart + maximumLength);
	const truncatedStart = snippetStart > 0;
	const truncatedEnd = snippetEnd < body.length;
	const text = `${truncatedStart ? "..." : ""}${body.slice(snippetStart, snippetEnd)}${truncatedEnd ? "..." : ""}`;
	return {
		text,
		highlights: match ? [{
			start: match.start - snippetStart + (truncatedStart ? 3 : 0),
			end: match.end - snippetStart + (truncatedStart ? 3 : 0)
		}] : []
	};
}

function findNormalizedSearchTextMatch(text: string, matchText: string): { start: number; end: number } | undefined {
	const normalizedMatchText = normalizeSnippetText(matchText);
	if (normalizedMatchText.length === 0) {
		return undefined;
	}

	let normalizedText = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	for (const character of text) {
		const normalizedCharacter = normalizeSnippetText(character);
		for (const normalizedPart of normalizedCharacter) {
			normalizedText += normalizedPart;
			starts.push(offset);
			ends.push(offset + character.length);
		}
		offset += character.length;
	}

	const index = normalizedText.indexOf(normalizedMatchText);
	if (index === -1) {
		return undefined;
	}
	return { start: starts[index]!, end: ends[index + normalizedMatchText.length - 1]! };
}

function normalizeSnippetText(value: string): string {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function findSnippetMatchText(expression: SearchExpression): string {
	if (expression.type === "term" || expression.type === "phrase" || expression.type === "prefix") {
		return expression.value;
	}
	if (expression.type === "and") {
		const phrase = expression.operands
			.filter((operand) => operand.type === "term" || operand.type === "phrase" || operand.type === "prefix")
			.map((operand) => operand.value)
			.join(" ");
		return phrase || findSnippetMatchText(expression.operands[0]!);
	}
	if (expression.type === "or") {
		return findSnippetMatchText(expression.operands[0]!);
	}
	if (expression.type === "not") {
		return findSnippetMatchText(expression.operand);
	}
	return findSnippetMatchText(expression.left);
}

function toSearchNavigationTarget(row: SearchDocumentRow): SearchResult["navigationTarget"] {
	if (row.source_type === "entity") {
		return { type: "entity", entityId: row.source_id };
	}
	if (row.source_type === "plan-entry" && row.parent_id) {
		return { type: "plan-entry", planId: row.parent_id, entryId: row.source_id };
	}
	if (row.source_type === "issue-comment" && row.parent_id) {
		return { type: "issue-comment", issueId: row.parent_id, commentId: row.source_id };
	}
	if (row.source_type === "context") {
		return row.parent_id ? { type: "context", scopeRef: row.parent_id } : { type: "context" };
	}
	if (row.source_type === "context-term") {
		return row.parent_id
			? { type: "context-term", scopeRef: row.parent_id, term: row.title }
			: { type: "context-term", term: row.title };
	}
	throw new Error(`Search document has an unsupported navigation target: ${row.source_type}:${row.source_id}`);
}