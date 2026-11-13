import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ContextDetails, InitiativeBundle } from "@agent-issues/api-local";
import type { EntityRecord, IssueCommentRecord, PlanEntryRecord, RelationRecord, UserDirectoryRecord } from "@agent-issues/core";
import { renderFrontmatter, renderInitiativeMarkdownExport, renderIssueConversationMarkdown, renderPlanProjectionMarkdown } from "./export-markdown.js";

export type DirectoryExportResult = {
	mode: "directory";
	scope: "initiative" | "project";
	outputPath: string;
	files: string[];
};

export function writeInitiativeDirectoryExport(input: {
	bundle: InitiativeBundle;
	commentsByIssueId?: Record<string, IssueCommentRecord[]>;
	context: ContextDetails;
	outputPath: string;
	planEntries?: PlanEntryRecord[];
	relations: RelationRecord[];
	users?: UserDirectoryRecord[];
	force?: boolean;
}): DirectoryExportResult {
	prepareOutputDirectory(input.outputPath, input.force ?? false);

	const files: string[] = [];
	const entityIds = collectBundleEntityIds(input.bundle);
	const scopedRelations = input.relations.filter(
		(relation) => entityIds.has(relation.fromId) && entityIds.has(relation.toId)
	);

	writeMarkdownFile(
		input.outputPath,
		"initiative.md",
		renderInitiativeMarkdownExport(
			{
				bundle: input.bundle,
				commentsByIssueId: input.commentsByIssueId,
				context: input.context,
				planEntries: input.planEntries,
				relations: input.relations,
				users: input.users
			},
			{ includeFrontmatter: true, headingLevel: 1 }
		),
		files
	);
	writeMarkdownFile(input.outputPath, "context.md", renderContextMarkdown(input.context), files);
	writeEntityGroup(input.outputPath, "prds", input.bundle.prds, scopedRelations, files);
	writeEntityGroup(input.outputPath, "user-stories", input.bundle.userStories, scopedRelations, files);
	writeEntityGroup(input.outputPath, "adrs", input.bundle.adrs, scopedRelations, files);
	writeEntityGroup(input.outputPath, "issues", input.bundle.issues, scopedRelations, files, input.commentsByIssueId, input.users);
	writeEntityGroup(input.outputPath, "entities", input.bundle.entities.filter((entity) => entity.id !== input.bundle.initiative.id && !["prd", "userStory", "adr", "issue"].includes(entity.kind)), scopedRelations, files, input.commentsByIssueId, input.users, input.planEntries);
	writeRelationGroups(input.outputPath, scopedRelations, files);

	return {
		mode: "directory",
		scope: "initiative",
		outputPath: path.resolve(input.outputPath),
		files: files.sort((left, right) => left.localeCompare(right))
	};
}

function renderEntityMarkdown(
	entity: EntityRecord,
	relations: RelationRecord[],
	commentsByIssueId: Record<string, IssueCommentRecord[]> = {},
	users: UserDirectoryRecord[] = [],
	planEntries: PlanEntryRecord[] = []
): string {
	const directIncoming = relations.filter((relation) => relation.toId === entity.id);
	const directOutgoing = relations.filter((relation) => relation.fromId === entity.id);
	const frontmatter = {
		id: entity.id,
		kind: entity.kind,
		status: entity.status,
		title: entity.title,
		bodySource: entity.bodySource,
		category: entity.category,
		priority: entity.priority,
		type: entity.type,
		createdBy: entity.createdBy,
		updatedBy: entity.updatedBy,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
		incomingConnections: directIncoming.map(summarizeRelation),
		outgoingConnections: directOutgoing.map(summarizeRelation)
	};
	const body = entity.body.trim().length > 0 ? entity.body : "_No body._";
	const conversation = entity.kind === "issue"
		? renderIssueConversationMarkdown(commentsByIssueId[entity.id] ?? [], users, 2)
		: "";
	const planProjection = entity.kind === "plan"
		? renderPlanProjectionMarkdown(planEntries.filter((entry) => entry.planId === entity.id), 2)
		: "";

	return [
		renderFrontmatter(frontmatter),
		`# ${entity.id} ${entity.title}`,
		`Kind: ${entity.kind}`,
		`Status: ${entity.status}`,
		body,
		planProjection,
		conversation
	].join("\n\n");
}

function renderContextMarkdown(context: ContextDetails): string {
	const frontmatter = {
		key: context.context.key,
		scopeKind: context.context.scopeKind,
		scopeEntityId: context.context.scopeEntityId,
		scopeLabel: context.context.scopeLabel,
		title: context.context.title,
		summary: context.context.summary,
		createdBy: context.context.createdBy,
		updatedBy: context.context.updatedBy,
		termCount: context.terms.length
	};
	const termLines = context.terms.length === 0
		? ["No terms."]
		: context.terms.map((term) => `- ${term.term}: ${term.definition}${term.avoid.length > 0 ? ` Avoid: ${term.avoid.join(", ")}.` : ""} Created by: ${term.createdBy}. Updated by: ${term.updatedBy}.`);

	return [renderFrontmatter(frontmatter), `# ${context.context.title}`, context.context.summary || "No summary.", "## Terms", ...termLines].join("\n\n");
}

function renderRelationGroupMarkdown(relationType: string, relations: RelationRecord[]): string {
	const frontmatter = {
		relationType,
		edgeCount: relations.length,
		edges: relations.map(summarizeRelation)
	};
	const lines = relations.length === 0
		? ["None."]
		: relations.map((relation) => `- ${relation.fromId} -> ${relation.toId} (${relation.createdAt}, created by ${relation.createdBy})`);

	return [renderFrontmatter(frontmatter), `# ${relationType}`, ...lines].join("\n\n");
}

function writeEntityGroup(
	rootPath: string,
	groupName: string,
	entities: EntityRecord[],
	relations: RelationRecord[],
	files: string[],
	commentsByIssueId: Record<string, IssueCommentRecord[]> = {},
	users: UserDirectoryRecord[] = [],
	planEntries: PlanEntryRecord[] = []
) {
	if (entities.length === 0) {
		return;
	}

	for (const entity of entities) {
		writeMarkdownFile(rootPath, path.join(groupName, `${entity.id}.md`), renderEntityMarkdown(entity, relations, commentsByIssueId, users, planEntries), files);
	}
}

function writeRelationGroups(rootPath: string, relations: RelationRecord[], files: string[]) {
	const grouped = new Map<string, RelationRecord[]>();

	for (const relation of relations) {
		const existing = grouped.get(relation.type);
		if (existing) {
			existing.push(relation);
		} else {
			grouped.set(relation.type, [relation]);
		}
	}

	for (const [relationType, groupedRelations] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
		writeMarkdownFile(rootPath, path.join("relations", `${relationType}.md`), renderRelationGroupMarkdown(relationType, groupedRelations), files);
	}
}

function writeMarkdownFile(rootPath: string, relativePath: string, content: string, files: string[]) {
	const absolutePath = path.join(rootPath, relativePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, `${content.trimEnd()}\n`, "utf8");
	files.push(path.resolve(absolutePath));
}

function prepareOutputDirectory(outputPath: string, force: boolean) {
	const resolvedPath = path.resolve(outputPath);
	if (existsSync(resolvedPath)) {
		if (!force) {
			throw new Error(`Export output already exists: ${resolvedPath}. Use --force to replace it.`);
		}

		rmSync(resolvedPath, { force: true, recursive: true });
	}

	mkdirSync(resolvedPath, { recursive: true });
}

function summarizeRelation(relation: RelationRecord) {
	return {
		from: relation.fromId,
		type: relation.type,
		to: relation.toId,
		createdBy: relation.createdBy,
		createdAt: relation.createdAt
	};
}

function collectBundleEntityIds(bundle: InitiativeBundle): Set<string> {
	return new Set(bundle.entities.map((entity) => entity.id));
}
