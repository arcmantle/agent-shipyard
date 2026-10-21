import { DEFAULT_PROJECT_ID, deriveMigratedEntityIdentity, encodeCanonicalReference, type Migration } from "@agent-issues/core";
import { sql } from "drizzle-orm";
import { toVisibleMarkdownText } from "../features/search/visible-markdown.js";

type ContextTermSearchRow = {
	tenant_id: string;
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
	tenant_id: string;
	source_type: string;
	source_id: string;
	body: string;
};

export const recordSearchMigration: Migration = {
	id: "record-search",
	async up(conn) {
		if (conn.dialect !== "sqlite") {
			throw new Error("SQLite record search migration requires the SQLite dialect.");
		}

		const defaultProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		await conn.run(sql`DELETE FROM search_documents WHERE source_type IN ('plan-entry', 'issue-comment', 'context', 'context-term')`);
		await conn.run(sql`INSERT INTO search_documents (
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
		WHERE entry.tombstone = 0`);
		await conn.run(sql`INSERT INTO search_documents (
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
		WHERE comment.tombstone = 0`);
		await conn.run(sql`INSERT INTO search_documents (
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
			AND project.kind = 'project'`);
		const terms = await conn.all<ContextTermSearchRow>(sql`
			SELECT term.tenant_id, term.id, term.short_reference, term.term, term.definition, term.updated_at,
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
			WHERE term.tombstone = 0
		`);
		for (const term of terms) {
			await conn.run(sql`INSERT INTO search_documents (
				tenant_id, source_type, source_id, project_id, project_label, reference,
				short_reference, title, body, status_or_role, parent_id, parent_label, updated_at
			)
			VALUES (
				${term.tenant_id}, 'context-term', ${term.id}, ${term.project_id}, ${term.project_label},
				${encodeCanonicalReference("contextTerm", term.id)}, ${term.short_reference}, ${term.term}, ${term.definition}, NULL,
				${term.scope_entity_id}, ${term.scope_label}, ${term.updated_at}
			)`);
		}
		const documents = await conn.all<SearchDocumentTextRow>(sql`SELECT tenant_id, source_type, source_id, body FROM search_documents`);
		for (const document of documents) {
			await conn.run(sql`UPDATE search_documents
				SET body = ${toVisibleMarkdownText(document.body)}
				WHERE tenant_id = ${document.tenant_id}
					AND source_type = ${document.source_type}
					AND source_id = ${document.source_id}`);
		}
	}
};