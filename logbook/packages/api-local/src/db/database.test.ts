import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveMigratedEntityIdentity, MIGRATION_BENCHMARK } from "@agent-issues/core";
import { defineContextTerm } from "../features/context/context-store.js";
import {
	deleteTenant,
	ensureDatabase,
	listTenants,
	renameTenant,
	resolveLegacyWorkspaceTenantId,
	resolveTenantRootPath,
	resolveTenantSlug,
	resolveWellKnownLocalTenantId
} from "./database.js";
import type { SqliteInternalConnection } from "./sqlite-executor.js";
import { createSqliteExecutor } from "./sqlite-executor.js";
import { createEntity, getEntityDetails, listEntities, queryEntityRelations } from "../features/entity-store/store.js";
import { runMigrations } from "./migration-runner.js";
import { migrations } from "../migrations/index.js";

const inspectionHandles = new Map<string, Database.Database>();

function rawDb(connection: SqliteInternalConnection): Database.Database {
	const existing = inspectionHandles.get(connection.dbPath);
	if (existing) {
		return existing;
	}
	const handle = new Database(connection.dbPath);
	inspectionHandles.set(connection.dbPath, handle);
	return handle;
}


const tempDirs: string[] = [];

async function openTestDatabase(dbPath: string, tenant: string): Promise<SqliteInternalConnection> {
	return (await ensureDatabase(dbPath, { tenant })).executor;
}

function backupsDirectoryFor(dbPath: string): string {
	return path.join(path.dirname(dbPath), "backups");
}

function listBackupFiles(dbPath: string): string[] {
	const backupsDirectory = backupsDirectoryFor(dbPath);
	return existsSync(backupsDirectory) ? readdirSync(backupsDirectory) : [];
}

afterEach(() => {
	for (const handle of inspectionHandles.values()) {
		handle.close();
	}
	inspectionHandles.clear();

	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

describe("tenant resolution", () => {
	it("rejects an unsupported mixed schema before creating a ledger, backup, or changing schema", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-source-profile-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const database = new Database(dbPath);
		database.exec(`
			CREATE TABLE entities (
				id TEXT PRIMARY KEY NOT NULL,
				tenant_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				metadata TEXT
			)
		`);
		const schemaBefore = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		database.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeUndefined();
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("rejects a present-but-empty migration ledger without mutation", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-empty-ledger-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const database = new Database(dbPath);
		database.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
		const schemaBefore = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		database.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(inspected.prepare("SELECT id, applied_at FROM schema_migrations").all()).toEqual([]);
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("reports a malformed migration ledger shape without mutation", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-malformed-ledger-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const database = new Database(dbPath);
		database.exec(`CREATE TABLE schema_migrations (migration_id TEXT, applied_at TEXT)`);
		const schemaBefore = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		database.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*ledger shape.*evidence:.*recovery:/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("rejects a view named schema_migrations without mutation", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-ledger-view-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const database = new Database(dbPath);
		database.exec("CREATE VIEW schema_migrations AS SELECT 'not-a-ledger' AS id");
		const schemaBefore = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		database.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*ledger metadata.*evidence:.*recovery:/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("creates an empty database with final tables and the complete migration ledger", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-final-baseline-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const created = await ensureDatabase(dbPath, { tenant: "test" });
		try {
			const tables = rawDb(created.db).prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			).all();
			expect(tables).toEqual([
				{ name: "completion_observations" },
				{ name: "context_terms" },
				{ name: "contexts" },
				{ name: "counters" },
				{ name: "entities" },
				{ name: "instruction_bundles" },
				{ name: "instruction_defaults" },
				{ name: "instruction_history" },
				{ name: "instruction_overrides" },
				{ name: "instruction_personal_fragments" },
				{ name: "issue_breakdown_drafts" },
				{ name: "issue_comment_references" },
				{ name: "issue_comments" },
				{ name: "plan_entries" },
				{ name: "plan_entry_references" },
				{ name: "plan_entry_supersessions" },
				{ name: "project_settings" },
				{ name: "relations" },
				{ name: "revision_entries" },
				{ name: "schema_migrations" },
				{ name: "search_documents" },
				{ name: "search_documents_fts" },
				{ name: "search_documents_fts_config" },
				{ name: "search_documents_fts_data" },
				{ name: "search_documents_fts_docsize" },
				{ name: "search_documents_fts_idx" },
				{ name: "search_documents_trigram" },
				{ name: "search_documents_trigram_config" },
				{ name: "search_documents_trigram_data" },
				{ name: "search_documents_trigram_docsize" },
				{ name: "search_documents_trigram_idx" },
				{ name: "search_typo_vocabulary" },
				{ name: "search_typo_vocabulary_documents" },
				{ name: "users" }
			]);
			expect(rawDb(created.db).prepare("SELECT id FROM schema_migrations ORDER BY rowid").all()).toEqual([
				{ id: "final-baseline" },
				{ id: "adr-status-to-current" },
				{ id: "user-directory" },
				{ id: "record-provenance" },
				{ id: "context-term-provenance" },
				{ id: "relation-provenance" },
				{ id: "issue-comments" },
				{ id: "debt-metadata" },
				{ id: "entity-type" },
				{ id: "short-entity-reference" },
				{ id: "short-record-reference" },
				{ id: "plan-entries" },
				{ id: "plan-entry-supersession-position" },
				{ id: "entity-search" },
				{ id: "record-search" },
				{ id: "token-search" },
				{ id: "trigram-search" },
				{ id: "search-typo-vocabulary" },
				{ id: "pioneer-entity-types" },
				{ id: "issue-breakdown-drafts" },
				{ id: "project-settings" },
				{ id: "completion-observations" },
				{ id: "completion-observation-version-state" },
				{ id: "instruction-defaults" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-history" },
				{ id: "instruction-resets" }
			]);
			expect(rawDb(created.db).prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			).all()).toEqual([
				{ name: "completion_observations_tenant_issue_idx" },
				{ name: "context_terms_tenant_context_key_idx" },
				{ name: "context_terms_tenant_id_idx" },
				{ name: "context_terms_tenant_short_reference_idx" },
				{ name: "contexts_tenant_id_idx" },
				{ name: "contexts_tenant_reference_idx" },
				{ name: "contexts_tenant_scope_entity_id_idx" },
				{ name: "contexts_tenant_short_reference_idx" },
				{ name: "entities_tenant_reference_idx" },
				{ name: "entities_tenant_short_reference_idx" },
				{ name: "issue_breakdown_drafts_active_target_idx" },
				{ name: "issue_breakdown_drafts_target_idx" },
				{ name: "issue_comment_references_tenant_issue_idx" },
				{ name: "issue_comments_tenant_issue_idx" },
				{ name: "issue_comments_tenant_short_reference_idx" },
				{ name: "plan_entries_tenant_plan_idx" },
				{ name: "relations_tenant_to_id_idx" },
				{ name: "revision_entries_chain_idx" },
				{ name: "revision_entries_project_idx" },
				{ name: "search_documents_entity_identity_idx" },
				{ name: "search_documents_entity_title_idx" },
				{ name: "search_typo_vocabulary_documents_document_idx" },
				{ name: "users_tenant_authentication_subject_idx" }
			]);
			expect(rawDb(created.db).prepare("PRAGMA table_info('revision_entries')").all()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "reverse_patch", type: "BLOB" }),
					expect.objectContaining({ name: "source_hash", type: "BLOB" }),
					expect.objectContaining({ name: "target_hash", type: "BLOB" })
				])
			);
			expect(rawDb(created.db).prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'revision_entries'"
			).get()).toEqual({
				sql: `CREATE TABLE revision_entries (
			id TEXT PRIMARY KEY NOT NULL,
			tenant_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			record_kind TEXT NOT NULL CHECK (record_kind IN ('entity', 'context', 'context-term', 'issue-comment', 'plan-entry')),
			record_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK (revision > 0),
			author TEXT NOT NULL,
			patch_format INTEGER NOT NULL CHECK (patch_format > 0),
			reverse_patch BLOB NOT NULL CHECK (typeof(reverse_patch) = 'blob'),
			source_hash BLOB NOT NULL CHECK (typeof(source_hash) = 'blob' AND length(source_hash) = 32),
			target_hash BLOB NOT NULL CHECK (typeof(target_hash) = 'blob' AND length(target_hash) = 32),
			restored_from_revision INTEGER,
			created_at TEXT NOT NULL
		)`
			});
			const insertRevisionEntry = rawDb(created.db).prepare(`INSERT INTO revision_entries
				(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format,
				 reverse_patch, source_hash, target_hash, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			const validEntry = [
				"entry", "tenant", "project", "entity", "record", 1, "author", 1,
				Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(32), "2026-01-01T00:00:00.000Z"
			] as const;
			for (const [label, index, value] of [
				["record kind", 3, "unknown"],
				["revision", 5, 0],
				["patch format", 7, 0],
				["reverse patch storage class", 8, "not-a-blob"],
				["source hash storage class", 9, "0".repeat(32)],
				["source hash length", 9, Buffer.alloc(31)],
				["target hash storage class", 10, "0".repeat(32)],
				["target hash length", 10, Buffer.alloc(33)]
			] as const) {
				const malformedEntry: unknown[] = [...validEntry];
				malformedEntry[0] = `bad-${label}`;
				malformedEntry[index] = value;
				expect(() => insertRevisionEntry.run(...malformedEntry), label).toThrow();
			}
		} finally {
			created.db.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("upgrades the previous approved schema with the user-directory migration", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-user-directory-upgrade-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const previous = createSqliteExecutor(dbPath);
		await runMigrations(previous, migrations.slice(0, 2));
		previous.close();

		const upgraded = await ensureDatabase(dbPath, { tenant: "test" });
		try {
			expect(rawDb(upgraded.db).prepare("SELECT id FROM schema_migrations ORDER BY rowid").all()).toEqual([
				{ id: "final-baseline" },
				{ id: "adr-status-to-current" },
				{ id: "user-directory" },
				{ id: "record-provenance" },
				{ id: "context-term-provenance" },
				{ id: "relation-provenance" },
				{ id: "issue-comments" },
				{ id: "debt-metadata" },
				{ id: "entity-type" },
				{ id: "short-entity-reference" },
				{ id: "short-record-reference" },
				{ id: "plan-entries" },
				{ id: "plan-entry-supersession-position" },
				{ id: "entity-search" },
				{ id: "record-search" },
				{ id: "token-search" },
				{ id: "trigram-search" },
				{ id: "search-typo-vocabulary" },
				{ id: "pioneer-entity-types" },
				{ id: "issue-breakdown-drafts" },
				{ id: "project-settings" },
				{ id: "completion-observations" },
				{ id: "completion-observation-version-state" },
				{ id: "instruction-defaults" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-history" },
				{ id: "instruction-resets" }
			]);
		} finally {
			upgraded.db.close();
		}
	});

	it("accepts a clean current-final database without schema or ledger mutation", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-current-final-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "test" });
		const schemaBefore = rawDb(created.db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const ledgerBefore = rawDb(created.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all();
		created.db.close();

		const reopened = await ensureDatabase(dbPath, { tenant: "test" });
		try {
			expect(rawDb(reopened.db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(rawDb(reopened.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(ledgerBefore);
		} finally {
			reopened.db.close();
		}
		expect(listBackupFiles(dbPath)).toHaveLength(MIGRATION_BENCHMARK.sqlite.currentFinal.backups);
	});

	it("bypasses migration work for current-final while preserving new-tenant onboarding", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-current-final-onboarding-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "existing-tenant" });
		const ledgerBefore = rawDb(created.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all();
		created.db.close();

		const reopened = await ensureDatabase(dbPath, { tenant: "new-tenant" });
		try {
			expect(rawDb(reopened.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(ledgerBefore);
			expect(rawDb(reopened.db).prepare("SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?").get("new-tenant")).toEqual({ count: 2 });
		} finally {
			reopened.db.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("closes its database handle when project resolution fails after opening", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-open-failure-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "test" });
		created.db.close();
		const close = vi.spyOn(Database.prototype, "close");

		// A stable id names one specific row, so a miss stays an error rather
		// than auto-registering the way a repository-style identity does.
		await expect(
			ensureDatabase(dbPath, { projectIdentity: "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8", tenant: "test" })
		).rejects.toThrow(/Cannot resolve project identity/);

		expect(close).toHaveBeenCalledOnce();
		close.mockRestore();
	});

	it.each([
			["missing ID", (database: SqliteInternalConnection) => rawDb(database).prepare("DELETE FROM schema_migrations WHERE id = 'final-baseline'").run()],
			["unknown ID", (database: SqliteInternalConnection) => rawDb(database).prepare("UPDATE schema_migrations SET id = '9999-unknown' WHERE id = 'final-baseline'").run()],
			["dialect-inappropriate ID", (database: SqliteInternalConnection) => rawDb(database).prepare("UPDATE schema_migrations SET id = '0001-enable-rls-policies' WHERE id = 'final-baseline'").run()]
	])("rejects a current-final SQLite schema with a %s before further mutation", async (_label, corruptLedger) => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-invalid-ledger-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "test" });
		corruptLedger(created.db);
		const schemaBefore = rawDb(created.db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const ledgerBefore = rawDb(created.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all();
		const entitiesBefore = rawDb(created.db).prepare("SELECT * FROM entities ORDER BY tenant_id, id").all();
		created.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(inspected.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(ledgerBefore);
			expect(inspected.prepare("SELECT * FROM entities ORDER BY tenant_id, id").all()).toEqual(entitiesBefore);
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it.each([
			["nominal-final ledger with a non-final schema", (database: SqliteInternalConnection) => rawDb(database).exec("ALTER TABLE entities ADD COLUMN metadata TEXT")],
			["changed content under a recorded migration ID", (database: SqliteInternalConnection) => rawDb(database).exec("DROP INDEX entities_tenant_reference_idx")]
	])("rejects %s before backup or further mutation", async (_label, corruptSchema) => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-invalid-schema-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "test" });
		corruptSchema(created.db);
		const schemaBefore = rawDb(created.db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const ledgerBefore = rawDb(created.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all();
		const entitiesBefore = rawDb(created.db).prepare("SELECT * FROM entities ORDER BY tenant_id, id").all();
		created.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*schema signature.*recovery:/i);

		const inspected = new Database(dbPath, { readonly: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(inspected.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(ledgerBefore);
			expect(inspected.prepare("SELECT * FROM entities ORDER BY tenant_id, id").all()).toEqual(entitiesBefore);
		} finally {
			inspected.close();
		}
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("rejects duplicate migration IDs when a malformed SQLite ledger makes them representable", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-duplicate-ledger-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const created = await ensureDatabase(dbPath, { tenant: "test" });
		const ledger = rawDb(created.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string; applied_at: string }>;
		rawDb(created.db).exec("DROP TABLE schema_migrations; CREATE TABLE schema_migrations (id TEXT NOT NULL, applied_at TEXT NOT NULL)");
		const insert = rawDb(created.db).prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
		for (const row of [...ledger, ledger[0]!]) insert.run(row.id, row.applied_at);
		created.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);
		expect(listBackupFiles(dbPath)).toEqual([]);
	});

	it("opens a database without legacy history or project migration ledgers", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-history-removal-"));
		tempDirs.push(tempDir);

		const { db } = await ensureDatabase(path.join(tempDir, "test.db"), { tenant: "test" });
		try {
						expect(
							rawDb(db).prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('history_entries', 'project_migrations', '__drizzle_migrations')").all()
						).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("defaults to the well-known local tenant regardless of the workspace root path (ISS63)", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveTenantRootPath(nestedDir)).toBe(workspaceRoot);
		expect(resolveTenantSlug({ currentWorkingDirectory: nestedDir })).toBe(resolveWellKnownLocalTenantId());
	});

	it("uses an explicit tenant when provided", async () => {
		expect(resolveTenantSlug({ tenant: " Payments Sandbox " })).toBe("payments-sandbox");
	});

	it("resolves a canonical project reference passed as projectIdentity", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-identity-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: project.reference });
		try {
			expect(selected.db.currentProjectId).toBe(project.id);
		} finally {
			selected.db.close();
		}
	});

	it("resolves a normalized exact project title and rejects ambiguous matches", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-title-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" });
		expect(selected.db.currentProjectId).toBe(project.id);
		createEntity(selected.executor, { kind: "project", title: "project_a" });
		selected.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" })).rejects.toThrow(/ambiguous project identity/i);
	});

	it("registers a repository-style identity the first time it is seen, with its own epic", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-autoregister-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		createEntity(seeded.executor, { kind: "project", title: "Existing Project" });
		seeded.db.close();

		const registered = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "brand-new-repo" });
		let registeredProjectId: string;
		try {
			registeredProjectId = registered.db.currentProjectId!;
			expect(getEntityDetails(registered.executor, registeredProjectId).entity).toMatchObject({
				kind: "project",
				title: "brand-new-repo"
			});
			// The project>epic chain (ADR7) has to exist too, otherwise an
			// initiative created here falls back to the sentinel epic and lands
			// under the Default Project instead. `listEntities` is already
			// scoped to `currentProjectId`, so seeing it here proves ownership.
			const epics = listEntities(registered.executor, "epic");
			expect(epics).toHaveLength(1);

			const initiative = createEntity(registered.executor, { kind: "initiative", title: "First initiative" });
			expect(listEntities(registered.executor, "initiative").map((entity) => entity.id)).toEqual([initiative.id]);
			expect(queryEntityRelations(registered.executor, { entityId: initiative.id }).incoming).toEqual([
				expect.objectContaining({ entity: expect.objectContaining({ id: epics[0]!.id }), relationType: "contains" })
			]);
		} finally {
			registered.db.close();
		}

		const reopened = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "brand-new-repo" });
		try {
			expect(reopened.db.currentProjectId).toBe(registeredProjectId);
			expect(listEntities(reopened.executor, "project").filter((project) => project.title === "brand-new-repo")).toHaveLength(1);
		} finally {
			reopened.db.close();
		}
	});

	it("ignores tombstoned projects when resolving an explicit identity", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-tombstone-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await ensureDatabase(dbPath, { tenant: "test" });
		const project = createEntity(seeded.executor, { kind: "project", title: "Project A" });
		const duplicate = createEntity(seeded.executor, { kind: "project", title: "project_a" });
		rawDb(seeded.db).prepare("UPDATE entities SET tombstone = 1 WHERE id = ?").run(duplicate.id);
		seeded.db.close();

		const selected = await ensureDatabase(dbPath, { tenant: "test", projectIdentity: "project-a" });
		try {
			expect(selected.db.currentProjectId).toBe(project.id);
		} finally {
			selected.db.close();
		}
	});

	it("requires a resolvable identity when multiple live projects exist", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-required-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");
		const soleProject = await ensureDatabase(dbPath, { tenant: "test" });
		const soleProjectId = soleProject.db.currentProjectId;
		soleProject.db.close();

		const reopened = await ensureDatabase(dbPath, { tenant: "test" });
		expect(reopened.db.currentProjectId).toBe(soleProjectId);
		createEntity(reopened.executor, { kind: "project", title: "Project B" });
		reopened.db.close();

		await expect(ensureDatabase(dbPath, { tenant: "test" })).rejects.toThrow(/project identity is required/i);
		await expect(
			ensureDatabase(dbPath, { tenant: "test", projectIdentity: "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8" })
		).rejects.toThrow(/cannot resolve project identity/i);
	});

	it("derives the legacy per-workspace tenant from the workspace root path (pre-ISS63 formula, kept for migration lookups)", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-"));
		tempDirs.push(tempDir);

		const workspaceRoot = path.join(tempDir, "agent-issues");
		const nestedDir = path.join(workspaceRoot, "site", "src");

		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - site\n");

		expect(resolveLegacyWorkspaceTenantId(nestedDir)).toBe(
			`agent-issues-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`
		);
	});

	it("lists tenants with per-table counts and deletes one tenant cleanly", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenants-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		const alphaDb = await openTestDatabase(dbPath, "alpha-team");
		const betaDb = await openTestDatabase(dbPath, "beta-team");

		try {
			const alphaInitiative = createEntity(alphaDb, { kind: "initiative", title: "Alpha" });
			createEntity(alphaDb, { kind: "issue", parentId: alphaInitiative.id, title: "Alpha issue" });
			defineContextTerm(alphaDb, {
				definition: "Alpha glossary term.",
				scopeRef: alphaInitiative.id,
				term: "Alpha term"
			});
			createEntity(alphaDb, { kind: "handoff", title: "Alpha handoff", body: "Ready for handoff.", links: [{ relationType: "handsOff", targetId: alphaInitiative.id }] });

			createEntity(betaDb, { kind: "initiative", title: "Beta" });

			const listed = listTenants(alphaDb);
			expect(listed).toEqual([
				{
					counts: {
						contexts: 1,
						contextTerms: 1,
						entities: 5,
						historyEntries: 5,
						relations: 4
					},
					displayName: "Alpha Team",
					id: "alpha-team"
				},
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);

			const removed = deleteTenant(alphaDb, "alpha-team");
			expect(removed).toMatchObject({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 5,
					historyEntries: 5,
					relations: 4
				},
				counters: 11,
				displayName: "Alpha Team",
				removed: true,
				tenantId: "alpha-team"
			});

			expect(listTenants(betaDb)).toEqual([
				{
					counts: {
						contexts: 0,
						contextTerms: 0,
						entities: 3,
						historyEntries: 3,
						relations: 2
					},
					displayName: "Beta Team",
					id: "beta-team"
				}
			]);
		} finally {
			alphaDb.close();
			betaDb.close();
		}
	});

	it("renames one tenant across all tenant-scoped tables", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-tenant-rename-"));
		tempDirs.push(tempDir);

		const dbPath = path.join(tempDir, "test.db");
		const sourceDb = await openTestDatabase(dbPath, "source-team");
		const otherDb = await openTestDatabase(dbPath, "other-team");

		try {
			const initiative = createEntity(sourceDb, { kind: "initiative", title: "Source initiative" });
			createEntity(sourceDb, { kind: "issue", parentId: initiative.id, title: "Source issue" });
			defineContextTerm(sourceDb, {
				definition: "Source glossary term.",
				scopeRef: initiative.id,
				term: "Source term"
			});
			createEntity(sourceDb, { kind: "handoff", title: "Source handoff", body: "Source handoff.", links: [{ relationType: "handsOff", targetId: initiative.id }] });

			createEntity(otherDb, { kind: "initiative", title: "Other initiative" });

			const renamed = renameTenant(sourceDb, "source-team", "renamed-team");
			expect(renamed).toEqual({
				counts: {
					contexts: 1,
					contextTerms: 1,
					entities: 5,
					historyEntries: 5,
					relations: 4
				},
				counters: 11,
				newDisplayName: "Renamed Team",
				newTenantId: "renamed-team",
				previousDisplayName: "Source Team",
				previousTenantId: "source-team",
				renamed: true
			});

			expect(listTenants(otherDb).map((tenant) => tenant.id)).toEqual(["other-team", "renamed-team"]);

			const sourceCounts = rawDb(sourceDb).prepare(
				`SELECT
					(SELECT COUNT(*) FROM counters WHERE tenant_id = 'source-team') AS counters,
					(SELECT COUNT(*) FROM entities WHERE tenant_id = 'source-team') AS entities,
					(SELECT COUNT(*) FROM relations WHERE tenant_id = 'source-team') AS relations,
					(SELECT COUNT(*) FROM contexts WHERE tenant_id = 'source-team') AS contexts,
					(SELECT COUNT(*) FROM context_terms WHERE tenant_id = 'source-team') AS context_terms,
					(SELECT COUNT(*) FROM revision_entries WHERE tenant_id = 'source-team') AS revision_entries`
			).get() as {
				counters: number;
				entities: number;
				relations: number;
				contexts: number;
				context_terms: number;
				revision_entries: number;
			};
			expect(sourceCounts).toEqual({
				context_terms: 0,
				contexts: 0,
				counters: 0,
				entities: 0,
				revision_entries: 0,
				relations: 0
			});

			expect(() => renameTenant(sourceDb, "other-team", "renamed-team")).toThrow("Target tenant already exists: renamed-team");
		} finally {
			sourceDb.close();
			otherDb.close();
		}
	});
});

describe("full-chain invariant backup", () => {
	it("backs up a pre-existing populated tenant exactly once, not again on a later open", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		// Record the one-time consolidation migration before adding a later
		// tenant. This isolates the full-chain backup contract from the
		// unrelated historical consolidation migration.
		(await ensureDatabase(dbPath, { tenant: resolveWellKnownLocalTenantId() })).db.close();

		// Simulate a later tenant with pre-existing data but no full chain.
		// Raw insertion is deliberate: every ordinary open bootstraps its
		// current tenant before this test can observe the backup behavior.
		const now = new Date().toISOString();
		const rawDb = new Database(dbPath);
		const identity = deriveMigratedEntityIdentity("initiative", "INIT1");
		rawDb.prepare(
			`INSERT INTO entities (tenant_id, id, reference, kind, title, status, body, body_source, created_at, updated_at)
			 VALUES ('late-tenant', ?, ?, 'initiative', 'Pre-existing initiative', 'active', '', 'authored', ?, ?)`
		).run(identity.stableId, identity.reference, now, now);
		rawDb.close();

		expect(listBackupFiles(dbPath)).toEqual([]);

		const firstOpen = (await ensureDatabase(dbPath, { tenant: "late-tenant" })).db;
		firstOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);

		const secondOpen = (await ensureDatabase(dbPath, { tenant: "late-tenant" })).db;
		secondOpen.close();
		expect(listBackupFiles(dbPath)).toHaveLength(1);
	});

	it("never backs up a brand-new tenant that has no pre-existing data", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-backup-fresh-"));
		tempDirs.push(tempDir);
		const dbPath = path.join(tempDir, "test.db");

		const db = await openTestDatabase(dbPath, "fresh-tenant");
		db.close();

		expect(listBackupFiles(dbPath)).toHaveLength(MIGRATION_BENCHMARK.sqlite.fresh.backups);
	});
});

describe("legacy database discovery", () => {
	it("imports external v7 rows directly into an existing final database", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-legacy-import-"));
		tempDirs.push(tempDir);
		const homeDirectory = path.join(tempDir, "home");
		const workspaceDirectory = path.join(tempDir, "workspace");
		const sourceDirectory = path.join(workspaceDirectory, ".agent-issues");
		mkdirSync(path.join(homeDirectory, ".agent-issues"), { recursive: true });
		mkdirSync(sourceDirectory, { recursive: true });
		writeFileSync(path.join(workspaceDirectory, "package.json"), "{}\n");
		const sourcePath = path.join(sourceDirectory, "agent-issues.db");
		copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "__fixtures__", "schema-v7.db"), sourcePath);
		const sourceBefore = readFileSync(sourcePath);
		const source = new Database(sourcePath, { readonly: true });
		const sourceInitiative = source.prepare(`SELECT title FROM entities WHERE tenant_id = 'fixture' AND id = 'INIT1'`).get() as { title: string };
		source.close();
		const originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;

		try {
			const destination = await ensureDatabase(undefined, { tenant: "destination-tenant" });
			const destinationEntity = createEntity(destination.executor, { kind: "initiative", title: "Destination initiative" });
			destination.db.close();

			const imported = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory, tenant: "fixture" });
			try {
				const projectId = deriveMigratedEntityIdentity("project", "PROJ0").stableId;
				const epicId = deriveMigratedEntityIdentity("epic", "EPIC0").stableId;
				const initiativeIdentity = deriveMigratedEntityIdentity("initiative", "INIT1");
				const initiativeId = initiativeIdentity.stableId;
				expect(rawDb(imported.db).prepare(`SELECT id, reference, title, project_id, revision FROM entities WHERE tenant_id = 'fixture' AND id = ?`).get(initiativeId)).toEqual({
					id: initiativeId,
					project_id: projectId,
					reference: initiativeIdentity.reference,
					revision: 1,
					title: sourceInitiative.title
				});
				expect(rawDb(imported.db).prepare(`SELECT from_id, to_id, type FROM relations WHERE tenant_id = 'fixture' AND from_id = ? AND to_id = ?`).get(epicId, initiativeId)).toEqual({
					from_id: epicId,
					to_id: initiativeId,
					type: "contains"
				});
				expect(rawDb(imported.db).prepare(`SELECT record_kind, revision, author FROM revision_entries WHERE tenant_id = 'fixture' AND record_key = ?`).get(`${initiativeId.length}:${initiativeId}`)).toEqual({
					author: "system",
					record_kind: "entity",
					revision: 1
				});
				expect(rawDb(imported.db).prepare(`SELECT title FROM entities WHERE tenant_id = 'destination-tenant' AND id = ?`).get(destinationEntity.id)).toEqual({
					title: "Destination initiative"
				});
			} finally {
				imported.db.close();
			}
			expect(readFileSync(sourcePath)).toEqual(sourceBefore);
		} finally {
			process.env.HOME = originalHome;
		}
	});

	it("rolls back the complete external v7 import on a global revision id conflict", async () => {
		const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-legacy-import-conflict-"));
		tempDirs.push(tempDir);
		const homeDirectory = path.join(tempDir, "home");
		const workspaceDirectory = path.join(tempDir, "workspace");
		const sourceDirectory = path.join(workspaceDirectory, ".agent-issues");
		mkdirSync(path.join(homeDirectory, ".agent-issues"), { recursive: true });
		mkdirSync(sourceDirectory, { recursive: true });
		writeFileSync(path.join(workspaceDirectory, "package.json"), "{}\n");
		const sourcePath = path.join(sourceDirectory, "agent-issues.db");
		copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "__fixtures__", "schema-v7.db"), sourcePath);
		const sourceBefore = readFileSync(sourcePath);
		const originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;

		try {
			const destination = await ensureDatabase(undefined, { tenant: "destination-tenant" });
			const destinationEntity = createEntity(destination.executor, { kind: "initiative", title: "Destination initiative" });
			const initiativeId = deriveMigratedEntityIdentity("initiative", "INIT1").stableId;
			rawDb(destination.db).prepare(`UPDATE revision_entries SET id = ? WHERE tenant_id = 'destination-tenant' AND record_kind = 'entity' AND record_key = ?`).run(
				`legacy-head:fixture:${initiativeId}`,
				`${destinationEntity.id.length}:${destinationEntity.id}`
			);
			destination.db.close();

			const importError = await ensureDatabase(undefined, { currentWorkingDirectory: workspaceDirectory, tenant: "fixture" }).catch((error: unknown) => error);
			let errorCause = importError;
			while (errorCause instanceof Error && errorCause.cause !== undefined) {
				errorCause = errorCause.cause;
			}
			expect(errorCause).toBeInstanceOf(Error);
			expect((errorCause as Error).message).toMatch(/unique constraint failed: revision_entries\.id/i);

			const inspected = new Database(path.join(homeDirectory, ".agent-issues", "agent-issues.db"), { readonly: true });
			try {
				expect(inspected.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = 'fixture'`).get()).toEqual({ count: 0 });
				expect(inspected.prepare(`SELECT title FROM entities WHERE tenant_id = 'destination-tenant' AND id = ?`).get(destinationEntity.id)).toEqual({
					title: "Destination initiative"
				});
			} finally {
				inspected.close();
			}
			expect(readFileSync(sourcePath)).toEqual(sourceBefore);
		} finally {
			process.env.HOME = originalHome;
		}
	});
});
