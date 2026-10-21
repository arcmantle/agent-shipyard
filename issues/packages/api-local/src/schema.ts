import { sql } from "drizzle-orm";
import { blob, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const counters = sqliteTable(
	"counters",
	{
		tenantId: text("tenant_id").notNull(),
		kind: text("kind").notNull(),
		nextValue: integer("next_value").notNull()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.kind] })]
);

export const users = sqliteTable(
	"users",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
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

export const entities = sqliteTable(
	"entities",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		reference: text("reference").notNull(),
		shortReference: text("short_reference").notNull(),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
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
		tombstone: integer("tombstone", { mode: "boolean" }).notNull().default(false),
		projectId: text("project_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		uniqueIndex("entities_tenant_reference_idx").on(table.tenantId, table.reference),
		uniqueIndex("entities_tenant_short_reference_idx").on(table.tenantId, table.shortReference)
	]
);

export const relations = sqliteTable(
	"relations",
	{
		tenantId: text("tenant_id").notNull(),
		fromId: text("from_id").notNull(),
		toId: text("to_id").notNull(),
		type: text("type").notNull(),
		createdBy: text("created_by"),
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

export const contexts = sqliteTable(
	"contexts",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		reference: text("reference").notNull(),
		shortReference: text("short_reference").notNull(),
		key: text("key").notNull(),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
		scopeEntityId: text("scope_entity_id"),
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

export const contextTerms = sqliteTable(
	"context_terms",
	{
		tenantId: text("tenant_id").notNull(),
		id: text("id").notNull(),
		shortReference: text("short_reference").notNull(),
		contextKey: text("context_key").notNull(),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
		term: text("term").notNull(),
		definition: text("definition").notNull(),
		avoidTerms: text("avoid_terms").notNull(),
		revision: integer("revision").notNull().default(1),
		contentHash: text("content_hash").notNull().default(""),
		tombstone: integer("tombstone", { mode: "boolean" }).notNull().default(false),
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

// Append-only reverse-delta chain (ADR55/ISS257). Each row stores the
// predecessor title/body for one atomic title/body edit so ISS261's history
// materializer can walk back from the current head one step at a time.
// The UNIQUE constraint on (tenant_id, entity_id, revision) enforces the
// linear chain: one delta per revision per entity, no branches allowed.
export const revisionEntries = sqliteTable(
	"revision_entries",
	{
		id: text("id").primaryKey(),
		tenantId: text("tenant_id").notNull(),
		projectId: text("project_id").notNull(),
		recordKind: text("record_kind").notNull(),
		recordKey: text("record_key").notNull(),
		revision: integer("revision").notNull(),
		author: text("author").notNull(),
		patchFormat: integer("patch_format").notNull(),
		reversePatch: blob("reverse_patch", { mode: "buffer" }).notNull(),
		sourceHash: blob("source_hash", { mode: "buffer" }).notNull(),
		targetHash: blob("target_hash", { mode: "buffer" }).notNull(),
		restoredFromRevision: integer("restored_from_revision"),
		createdAt: text("created_at").notNull()
	},
	(table) => [
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
	revisionEntries
};

export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
export type ContextRow = typeof contexts.$inferSelect;
export type ContextTermRow = typeof contextTerms.$inferSelect;
export type CounterRow = typeof counters.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RevisionEntryRow = typeof revisionEntries.$inferSelect;
