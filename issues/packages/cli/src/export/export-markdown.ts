import type { DatabaseSnapshot, InitiativeBundle, ContextDetails } from "@agent-issues/api-local";
import { projectPlanEntries, type EntityRecord, type IssueCommentRecord, type PlanEntryRecord, type RelationRecord, type UserDirectoryRecord } from "@agent-issues/core";

export type InitiativeMarkdownExport = {
	bundle: InitiativeBundle;
	commentsByIssueId?: Record<string, IssueCommentRecord[]>;
	context: ContextDetails;
	planEntries?: PlanEntryRecord[];
	relations: RelationRecord[];
	users?: UserDirectoryRecord[];
};

type InitiativeRenderOptions = {
	includeFrontmatter?: boolean;
	headingLevel?: 1 | 2;
};

export type ProjectMarkdownExport = {
	commentsByIssueId?: Record<string, IssueCommentRecord[]>;
	snapshot: DatabaseSnapshot;
};

export function renderInitiativeMarkdownExport(
	input: InitiativeMarkdownExport,
	options: InitiativeRenderOptions = {}
): string {
	const { bundle, commentsByIssueId = {}, context, planEntries = [], relations, users = [] } = input;
	const includeFrontmatter = options.includeFrontmatter ?? true;
	const headingLevel = options.headingLevel ?? 1;
	const entityIds = collectBundleEntityIds(bundle);
	const bundleRelations = relations.filter(
		(relation) => entityIds.has(relation.fromId) && entityIds.has(relation.toId)
	);
	const frontmatter = {
		type: "initiative-export",
		initiative: summarizeEntity(bundle.initiative),
		counts: {
			entities: bundle.entities.length,
			prds: bundle.prds.length,
			userStories: bundle.userStories.length,
			adrs: bundle.adrs.length,
			issues: bundle.issues.length,
			relations: bundleRelations.length
		},
		connections: summarizeRelations(bundleRelations),
		context: summarizeContext(context),
		generatedAt: new Date().toISOString()
	};

	const sections = [
		includeFrontmatter ? renderFrontmatter(frontmatter) : "",
		renderEntitySection(bundle.initiative, headingLevel),
		renderContextSection(context, headingLevel + 1),
		renderEntityCollection("PRDs", bundle.prds, headingLevel + 1),
		renderEntityCollection("User Stories", bundle.userStories, headingLevel + 1),
		renderEntityCollection("ADRs", bundle.adrs, headingLevel + 1),
		renderEntityCollection("Issues", bundle.issues, headingLevel + 1, commentsByIssueId, users),
		renderEntityCollection("Entities", bundle.entities.filter((entity) => entity.id !== bundle.initiative.id && !["prd", "userStory", "adr", "issue"].includes(entity.kind)), headingLevel + 1, commentsByIssueId, users, planEntries),
		renderRelationsSection("Relations", bundleRelations, headingLevel + 1)
	];

	return sections
		.filter((section) => section.length > 0)
		.join("\n\n");
}

export function renderProjectMarkdownExport(input: ProjectMarkdownExport): string {
	const { commentsByIssueId = {}, snapshot } = input;
	const frontmatter = {
		type: "project-export",
		generatedAt: snapshot.generatedAt,
		counts: {
			entities: snapshot.entities.length,
			relations: snapshot.relations.length,
			initiatives: snapshot.initiatives.length,
			projectAdrs: snapshot.projectAdrs.length,
			orphans: snapshot.orphans.length
		},
		connections: summarizeRelations(snapshot.relations),
		sharedContext: summarizeContext(snapshot.contexts.shared)
	};

	const initiativeSections = snapshot.initiatives.map((bundle) => {
		const context = snapshot.contexts.initiatives.find((details) => details.context.scopeEntityId === bundle.initiative.id) ?? emptyInitiativeContext(bundle.initiative);
		return renderInitiativeMarkdownExport({
			bundle,
			commentsByIssueId,
			context,
			planEntries: snapshot.planEntries,
			relations: snapshot.relations,
			users: snapshot.users
		}, {
			includeFrontmatter: false,
			headingLevel: 2
		});
	});

	return [
		renderFrontmatter(frontmatter),
		"# Project Export",
		renderProjectSummary(snapshot),
		renderUserDirectorySection(snapshot),
		renderEntityCollection("Entities", snapshot.entities, 2, commentsByIssueId, snapshot.users, snapshot.planEntries),
		renderRelationsSection("Relations", snapshot.relations, 2),
		initiativeSections.join("\n\n")
	]
		.filter((section) => section.length > 0)
		.join("\n\n");
}

function renderProjectSummary(snapshot: DatabaseSnapshot): string {
	return [
		`Generated at: ${snapshot.generatedAt}`,
		`Initiatives: ${snapshot.initiatives.length}`,
		`Entities: ${snapshot.entities.length}`,
		`Relations: ${snapshot.relations.length}`
	].join("\n");
}

function renderUserDirectorySection(snapshot: DatabaseSnapshot): string {
	const users = collectReferencedUsers(snapshot);
	if (users.length === 0) {
		return "## User Directory\n\nNone.";
	}

	return [
		"## User Directory",
		...users.map((user) => `- ${user.id}: ${user.authenticationSubject}${user.displayName ? ` (${user.displayName})` : ""}`)
	].join("\n");
}

function collectReferencedUsers(snapshot: DatabaseSnapshot): Array<Pick<UserDirectoryRecord, "id" | "authenticationSubject" | "displayName">> {
	const userIds = new Set<string>();
	for (const entity of snapshot.entities) {
		userIds.add(entity.createdBy);
		userIds.add(entity.updatedBy);
	}
	for (const relation of snapshot.relations) {
		userIds.add(relation.createdBy);
	}
	for (const context of [snapshot.contexts.shared, ...snapshot.contexts.initiatives]) {
		if (context.context.createdBy) userIds.add(context.context.createdBy);
		if (context.context.updatedBy) userIds.add(context.context.updatedBy);
		for (const term of context.terms) {
			userIds.add(term.createdBy);
			userIds.add(term.updatedBy);
		}
	}

	return snapshot.users
		.filter((user) => userIds.has(user.id))
		.map((user) => ({ id: user.id, authenticationSubject: user.authenticationSubject, displayName: user.displayName }));
}

function renderEntitySection(
	entity: EntityRecord,
	level: 1 | 2 | 3,
	commentsByIssueId: Record<string, IssueCommentRecord[]> = {},
	users: UserDirectoryRecord[] = [],
	planEntries: PlanEntryRecord[] = []
): string {
	const header = `${"#".repeat(level)} ${entity.id} ${entity.title}`;
	const metadata = [
		`Kind: ${entity.kind}`,
		`Status: ${entity.status}`,
		...(entity.category ? [`Category: ${entity.category}`] : []),
		...(entity.priority ? [`Priority: ${entity.priority}`] : []),
		...(entity.type ? [`Type: ${entity.type}`] : []),
		`Created by: ${entity.createdBy}`,
		`Updated by: ${entity.updatedBy}`,
		`Created: ${entity.createdAt}`,
		`Updated: ${entity.updatedAt}`,
		`Body source: ${entity.bodySource}`
	].join("\n");
	const body = entity.body.trim().length > 0 ? entity.body : "_No body._";

	const conversation = entity.kind === "issue"
		? renderIssueConversationMarkdown(commentsByIssueId[entity.id] ?? [], users, level + 1)
		: "";
	const planProjection = entity.kind === "plan"
		? renderPlanProjectionMarkdown(planEntries.filter((entry) => entry.planId === entity.id), level + 1)
		: "";

	return [header, metadata, body, planProjection, conversation].filter((section) => section.length > 0).join("\n\n");
}

function renderEntityCollection(
	title: string,
	entities: EntityRecord[],
	headingLevel: number,
	commentsByIssueId: Record<string, IssueCommentRecord[]> = {},
	users: UserDirectoryRecord[] = [],
	planEntries: PlanEntryRecord[] = []
): string {
	if (entities.length === 0) {
		return `${"#".repeat(headingLevel)} ${title}\n\nNone.`;
	}

	return [`${"#".repeat(headingLevel)} ${title}`, ...entities.map((entity) => renderEntitySection(entity, 3, commentsByIssueId, users, planEntries))].join("\n\n");
}

export function renderPlanProjectionMarkdown(entries: PlanEntryRecord[], headingLevel: number): string {
	const projection = projectPlanEntries(entries);
	const referencesById = new Map(projection.history.map((entry) => [entry.id, entry.reference]));
	const renderEntry = (entry: PlanEntryRecord) => {
		const references = entry.referencedEntityIds.length > 0 ? ` References: ${entry.referencedEntityIds.join(", ")}.` : "";
		const supersession = entry.supersededEntryIds.length > 0 ? ` Supersedes: ${entry.supersededEntryIds.map((id) => referencesById.get(id) ?? id).join(", ")}.` : "";
		return `- ${entry.reference}: ${entry.tombstone ? "Deleted entry" : entry.body ?? ""}${references}${supersession}`;
	};
	const current = projection.current.map((group) => {
		const content = group.entries.length === 0
			? "None."
			: group.entries.map(renderEntry).join("\n");
		return [`${"#".repeat(headingLevel + 1)} ${group.title}`, content].join("\n\n");
	}).join("\n\n");
	const history = projection.history.length === 0
		? "None."
		: projection.history.map(renderEntry).join("\n");

	return [`${"#".repeat(headingLevel)} Current Plan`, current, `${"#".repeat(headingLevel)} Plan Entry History`, history].join("\n\n");
}

export function renderIssueConversationMarkdown(comments: IssueCommentRecord[], users: UserDirectoryRecord[], headingLevel: number): string {
	const heading = `${"#".repeat(headingLevel)} Conversation`;
	if (comments.length === 0) {
		return `${heading}\n\nNo comments.`;
	}

	return [heading, ...comments.map((comment) => renderIssueComment(comment, users, headingLevel + 1))].join("\n\n");
}

function renderIssueComment(comment: IssueCommentRecord, users: UserDirectoryRecord[], headingLevel: number): string {
	const metadata = [
		`Created by: ${resolveUser(comment.createdBy, users)}`,
		`Updated by: ${resolveUser(comment.updatedBy, users)}`,
		`Created: ${comment.createdAt}`,
		`Updated: ${comment.updatedAt}`,
		`References: ${comment.referencedIssueIds.length > 0 ? comment.referencedIssueIds.join(", ") : "none"}`
	].join("\n");
	const body = comment.tombstone ? "Deleted comment" : comment.body ?? "";

	return [`${"#".repeat(headingLevel)} ${comment.reference}`, metadata, body].join("\n\n");
}

function resolveUser(userId: string, users: UserDirectoryRecord[]): string {
	const user = users.find((candidate) => candidate.id === userId);
	if (!user) {
		return userId;
	}

	return user.displayName ? `${user.displayName} (${user.authenticationSubject})` : user.authenticationSubject;
}

function renderRelationsSection(title: string, relations: RelationRecord[], headingLevel: number): string {
	if (relations.length === 0) {
		return `${"#".repeat(headingLevel)} ${title}\n\nNone.`;
	}

	const lines = relations.map(
		(relation) => `- ${relation.fromId} --${relation.type}--> ${relation.toId} createdBy=${relation.createdBy} created=${relation.createdAt}`
	);

	return [`${"#".repeat(headingLevel)} ${title}`, ...lines].join("\n");
}

function renderContextSection(context: ContextDetails, headingLevel: number): string {
	const header = `${"#".repeat(headingLevel)} Context`;
	const metadata = [
		`Scope: ${context.context.scopeKind}`,
		`Label: ${context.context.scopeLabel}`,
		`Title: ${context.context.title}`,
		`Created by: ${context.context.createdBy ?? "none"}`,
		`Updated by: ${context.context.updatedBy ?? "none"}`,
		`Summary: ${context.context.summary}`
	].join("\n");

	if (context.terms.length === 0) {
		return [header, metadata, "No terms."].join("\n\n");
	}

	const terms = context.terms.map((term) => {
		const avoid = term.avoid.length > 0 ? ` Avoid: ${term.avoid.join(", ")}.` : "";
		return `- ${term.term}: ${term.definition}.${avoid} Created by: ${term.createdBy}. Updated by: ${term.updatedBy}.`;
	});

	return [header, metadata, `${"#".repeat(headingLevel + 1)} Terms`, ...terms].join("\n\n");
}

function summarizeEntity(entity: EntityRecord) {
	return {
		id: entity.id,
		createdBy: entity.createdBy,
		updatedBy: entity.updatedBy,
		kind: entity.kind,
		status: entity.status,
		title: entity.title
	};
}

function summarizeRelations(relations: RelationRecord[]) {
	return relations.map((relation) => ({
		from: relation.fromId,
		type: relation.type,
		to: relation.toId,
		createdBy: relation.createdBy,
		createdAt: relation.createdAt
	}));
}

function summarizeContext(context: ContextDetails) {
	return {
		key: context.context.key,
		scopeKind: context.context.scopeKind,
		scopeEntityId: context.context.scopeEntityId,
		scopeLabel: context.context.scopeLabel,
		title: context.context.title,
		summary: context.context.summary,
		createdBy: context.context.createdBy,
		updatedBy: context.context.updatedBy,
		termCount: context.terms.length,
		terms: context.terms.map((term) => ({
			term: term.term,
			definition: term.definition,
			avoid: term.avoid,
			createdBy: term.createdBy,
			updatedBy: term.updatedBy
		}))
	};
}

export function renderFrontmatter(value: unknown): string {
	return `---\n${toYaml(value, 0)}---`;
}

function toYaml(value: unknown, indent: number): string {
	const prefix = " ".repeat(indent);

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix}[]\n`;
		}

		return value
			.map((entry) => {
				if (isScalar(entry)) {
					return `${prefix}- ${formatScalar(entry)}\n`;
				}

				const nested = toYaml(entry, indent + 2);
				return `${prefix}-\n${nested}`;
			})
			.join("");
	}

	if (isPlainObject(value)) {
		return Object.entries(value)
			.map(([key, entry]) => {
				if (isScalar(entry)) {
					return `${prefix}${key}: ${formatScalar(entry)}\n`;
				}

				if (Array.isArray(entry) && entry.length === 0) {
					return `${prefix}${key}: []\n`;
				}

				return `${prefix}${key}:\n${toYaml(entry, indent + 2)}`;
			})
			.join("");
	}

	return `${prefix}${formatScalar(value)}\n`;
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (value === null) {
		return "null";
	}

	return JSON.stringify(String(value));
}

function isScalar(value: unknown): value is string | number | boolean | null {
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectBundleEntityIds(bundle: InitiativeBundle): Set<string> {
	return new Set([
		bundle.initiative.id,
		...bundle.entities.map((entity) => entity.id),
		...bundle.prds.map((entity) => entity.id),
		...bundle.userStories.map((entity) => entity.id),
		...bundle.adrs.map((entity) => entity.id),
		...bundle.issues.map((entity) => entity.id)
	]);
}

function emptyInitiativeContext(initiative: EntityRecord): ContextDetails {
	return {
		context: {
			id: null,
			reference: null,
			shortReference: null,
			createdBy: null,
			updatedBy: null,
			key: initiative.id,
			scopeKind: "initiative",
			scopeEntityId: initiative.id,
			scopeLabel: initiative.title,
			title: `${initiative.title} Context`,
			summary: "",
			revision: 0,
			contentHash: "",
			createdAt: null,
			updatedAt: null,
			exists: false
		},
		terms: []
	};
}