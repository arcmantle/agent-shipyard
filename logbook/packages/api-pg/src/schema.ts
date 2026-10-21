import { sql } from "drizzle-orm";
import { boolean, customType, foreignKey, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * Postgres mirror of `@agent-issues/core`'s `schema.ts` (ADR11: one schema
 * definition per dialect, sharing table/column names so `PgStore`'s queries
 * stay structurally consistent with `SqliteStore`'s). Drizzle requires a
 * separate table-builder module per dialect (`sqlite-core` vs `pg-core`),
 * so this cannot literally be the same source file - keep it in lockstep
 * with core's `schema.ts` by hand until/unless a shared table-shape
 * generator is introduced.
 */
export const counters = pgTable(
	"counters",
	{
		tenantId: text("tenant_id").notNull(),
		kind: text("kind").notNull(),
		nextValue: integer("next_value").notNull()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.kind] })]
);

export const users = pgTable(
	"users",
	{
		tenantId: text("tenant_id").notNull(),
		id: uuid("id").notNull(),
		authenticationSubject: text("authentication_subject").notNull(),
		displayName: text("display_name"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		uniqueIndex("users_tenant_authentication_subject_idx").on(table.tenantId, table.authenticationSubject)
	]
);

export const entities = pgTable(
	"entities",
	{
		tenantId: text("tenant_id").notNull(),
		id: uuid("id").notNull(),
		reference: text("reference").notNull(),
		shortReference: text("short_reference").notNull(),
		createdBy: uuid("created_by"),
		updatedBy: uuid("updated_by"),
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		status: text("status").notNull(),
		body: text("body").notNull().default(""),
		bodySource: text("body_source").notNull().default("authored"),
		category: text("category"),
		priority: text("priority"),
		type: text("type"),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: boolean("tombstone").notNull().default(false),
		projectId: uuid("project_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		uniqueIndex("entities_tenant_reference_idx").on(table.tenantId, table.reference),
		uniqueIndex("entities_tenant_short_reference_idx").on(table.tenantId, table.shortReference)
	]
);

export const relations = pgTable(
	"relations",
	{
		tenantId: text("tenant_id").notNull(),
		fromId: uuid("from_id").notNull(),
		toId: uuid("to_id").notNull(),
		type: text("type").notNull(),
		createdBy: uuid("created_by"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.fromId, table.toId, table.type] }),
		foreignKey({
			columns: [table.tenantId, table.fromId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tenantId, table.toId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		index("relations_tenant_to_id_idx").on(table.tenantId, table.toId)
	]
);

export const contexts = pgTable(
	"contexts",
	{
		tenantId: text("tenant_id").notNull(),
		id: uuid("id").notNull(),
		reference: text("reference").notNull(),
		shortReference: text("short_reference").notNull(),
		key: text("key").notNull(),
		createdBy: uuid("created_by"),
		updatedBy: uuid("updated_by"),
		scopeEntityId: uuid("scope_entity_id"),
		title: text("title").notNull(),
		summary: text("summary").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.key] }),
		uniqueIndex("contexts_tenant_id_idx").on(table.tenantId, table.id),
		uniqueIndex("contexts_tenant_reference_idx").on(table.tenantId, table.reference),
		uniqueIndex("contexts_tenant_short_reference_idx").on(table.tenantId, table.shortReference),
		foreignKey({
			columns: [table.tenantId, table.scopeEntityId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		uniqueIndex("contexts_tenant_scope_entity_id_idx")
			.on(table.tenantId, table.scopeEntityId)
			.where(sql`scope_entity_id IS NOT NULL`)
	]
);

export const contextTerms = pgTable(
	"context_terms",
	{
		tenantId: text("tenant_id").notNull(),
		id: uuid("id").notNull(),
		shortReference: text("short_reference").notNull(),
		contextKey: text("context_key").notNull(),
		createdBy: uuid("created_by"),
		updatedBy: uuid("updated_by"),
		term: text("term").notNull(),
		definition: text("definition").notNull(),
		avoidTerms: text("avoid_terms").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: boolean("tombstone").notNull().default(false),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.contextKey, table.term] }),
		foreignKey({
			columns: [table.tenantId, table.contextKey],
			foreignColumns: [contexts.tenantId, contexts.key]
		}).onDelete("cascade"),
		index("context_terms_tenant_context_key_idx").on(table.tenantId, table.contextKey),
		uniqueIndex("context_terms_tenant_id_idx").on(table.tenantId, table.id),
		uniqueIndex("context_terms_tenant_short_reference_idx").on(table.tenantId, table.shortReference)
	]
);

export const issueComments = pgTable(
	"issue_comments",
	{
		tenantId: text("tenant_id").notNull(),
		id: uuid("id").notNull(),
		reference: text("reference").notNull(),
		shortReference: text("short_reference").notNull(),
		issueId: uuid("issue_id").notNull(),
		createdBy: uuid("created_by").notNull(),
		updatedBy: uuid("updated_by").notNull(),
		body: text("body").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: boolean("tombstone").notNull().default(false),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		uniqueIndex("issue_comments_tenant_reference_idx").on(table.tenantId, table.reference),
		uniqueIndex("issue_comments_tenant_short_reference_idx").on(table.tenantId, table.shortReference),
		foreignKey({
			columns: [table.tenantId, table.issueId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		index("issue_comments_tenant_issue_idx").on(table.tenantId, table.issueId, table.createdAt, table.reference)
	]
);

export const issueCommentReferences = pgTable(
	"issue_comment_references",
	{
		tenantId: text("tenant_id").notNull(),
		commentId: uuid("comment_id").notNull(),
		issueId: uuid("issue_id").notNull(),
		position: integer("position").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.commentId, table.issueId] }),
		foreignKey({
			columns: [table.tenantId, table.commentId],
			foreignColumns: [issueComments.tenantId, issueComments.id]
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.tenantId, table.issueId],
			foreignColumns: [entities.tenantId, entities.id]
		}).onDelete("cascade"),
		index("issue_comment_references_tenant_issue_idx").on(table.tenantId, table.issueId, table.position)
	]
);

// Project-scoped append-only reverse-patch ledger shared by all record kinds.
// Mirrors api-local's table shape for identical cross-backend behavior.
export const revisionEntries = pgTable(
	"revision_entries",
	{
		id: text("id").notNull(),
		tenantId: text("tenant_id").notNull(),
		projectId: uuid("project_id").notNull(),
		recordKind: text("record_kind").notNull(),
		recordKey: text("record_key").notNull(),
		revision: integer("revision").notNull(),
		author: text("author").notNull(),
		patchFormat: integer("patch_format").notNull(),
		reversePatch: bytea("reverse_patch").notNull(),
		sourceHash: bytea("source_hash").notNull(),
		targetHash: bytea("target_hash").notNull(),
		restoredFromRevision: integer("restored_from_revision"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		index("revision_entries_project_idx").on(table.tenantId, table.projectId),
		uniqueIndex("revision_entries_chain_idx").on(table.tenantId, table.projectId, table.recordKind, table.recordKey, table.revision)
	]
);

export const schema = {
	counters,
	users,
	entities,
	relations,
	contexts,
	contextTerms,
	issueComments,
	issueCommentReferences,
	revisionEntries
};

export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
export type ContextRow = typeof contexts.$inferSelect;
export type ContextTermRow = typeof contextTerms.$inferSelect;
export type IssueCommentRow = typeof issueComments.$inferSelect;
export type IssueCommentReferenceRow = typeof issueCommentReferences.$inferSelect;
export type CounterRow = typeof counters.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RevisionEntryRow = typeof revisionEntries.$inferSelect;
