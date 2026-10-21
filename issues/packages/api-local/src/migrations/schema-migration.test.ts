import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveMigratedEntityIdentity, MIGRATION_BENCHMARK } from "@agent-issues/core";
import { ensureDatabase, resolveWellKnownLocalTenantId } from "../db/database.js";
import type { SqliteInternalConnection } from "../db/sqlite-executor.js";
import { migrations } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_FIXTURE = path.join(here, "__fixtures__", "schema-v7.db");
const DOMAIN_TABLES = ["counters", "entities", "relations", "contexts", "context_terms"] as const;

// A real (not synthetic) pre-ADR43 backup of a personal `agent-issues.db`,
// scrubbed of the counters-only ghost tenants left behind by an unrelated,
// already-resolved test-isolation bug (ISS167) before being adopted here
// (ISS177) - see this fixture's provenance in ISS177's body for the full
// story of how it was captured and cleaned. Genuinely messier than the
// hand-written `schema-v7.db` fixture above: four real legacy per-folder
// tenants (ADR7's original, pre-ISS63 model), each with real entities,
// relations, contexts, context terms, and (for two of them) handoffs -
// exercising the full one-time legacy-tenant backfill migration
// (`buildConsolidateLegacyTenantsBackfillMigration`, ISS181) against real
// data shapes rather than a single minimal tenant.
const REAL_WORLD_FIXTURE = path.join(here, "__fixtures__", "real-world-multi-tenant-v7.db");
const REAL_WORLD_LEGACY_TENANT_IDS = [
	"agent-issues-de3fbe614e21",
	"content-hub-5ab5819bb0a8",
	"eye-share-devops-net-9999b3e54780",
	"weave-e2d77991499a"
] as const;

const tempDirs: string[] = [];
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

function closeInspectionHandle(connection: SqliteInternalConnection): void {
	const handle = inspectionHandles.get(connection.dbPath);
	if (!handle) {
		return;
	}
	handle.close();
	inspectionHandles.delete(connection.dbPath);
}

function stageFixture(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-golden-"));
	tempDirs.push(tempDir);
	const staged = path.join(tempDir, "schema-v7.db");
	copyFileSync(GOLDEN_FIXTURE, staged);
	return staged;
}

function snapshotTables(dbPath: string): Record<string, unknown[]> {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const snapshot: Record<string, unknown[]> = {};
		for (const table of DOMAIN_TABLES) {
			snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
		}
		return snapshot;
	} finally {
		db.close();
	}
}

async function stageLegacyTablesAlongsideFinalSchema(dbPath: string): Promise<void> {
	const retainedSource = new Database(GOLDEN_FIXTURE, { readonly: true, fileMustExist: true });
	const sourceTables = retainedSource.prepare(`SELECT name, sql FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string; sql: string }>;
	const sourceRows = new Map(sourceTables.map(({ name }) => [name, retainedSource.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
	retainedSource.close();

	const migrated = await ensureDatabase(dbPath, { tenant: "fixture" });
	rawDb(migrated.db).pragma("foreign_keys = OFF");
	for (const { name, sql } of sourceTables) {
		rawDb(migrated.db).exec(sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE legacy_v7_${name}`));
		const rows = sourceRows.get(name) ?? [];
		if (rows.length === 0) continue;
		const columns = Object.keys(rows[0] as Record<string, unknown>);
		const insert = rawDb(migrated.db).prepare(`INSERT INTO legacy_v7_${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
		for (const row of rows as Array<Record<string, unknown>>) insert.run(...columns.map((column) => row[column]));
	}
	rawDb(migrated.db).pragma("foreign_keys = ON");
	closeInspectionHandle(migrated.db);
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

describe("golden-fixture migration wall", () => {
	it("implements the SQLite legacy route without clone or historical migration replay", () => {
		const directSource = readFileSync(path.join(here, "legacy-v7-direct.ts"), "utf8");
		const databaseSource = readFileSync(path.join(here, "..", "db", "database.ts"), "utf8");

		expect(directSource).not.toMatch(/\.serialize\(|mkdtempSync|tmpdir|clone\.db|buildFinalClone|runMigrations/);
		expect(databaseSource).not.toMatch(/migrateLegacySqliteV7Sequentially|buildFinalClone/);
		expect(databaseSource).toMatch(/transformLegacySqliteV7\(db\)/);
	});

	it("opens legacy v7 through one direct checkpoint with an exactly contracted final schema", async () => {
		const staged = stageFixture();

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();
		const backupDirectory = path.join(path.dirname(staged), "backups");
		const backups = readdirSync(backupDirectory);
		expect(backups).toHaveLength(MIGRATION_BENCHMARK.sqlite.legacyV7.backups);
		const backup = new Database(path.join(backupDirectory, backups[0]!), { readonly: true, fileMustExist: true });
		try {
			expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'").get()).toEqual({ name: "handoffs" });
			expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revision_entries'").get()).toBeUndefined();
		} finally {
			backup.close();
		}

		const migrated = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			expect(migrated.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all()).toEqual([
				{ id: "legacy-v7-direct" },
				...migrations.map(({ id }) => ({ id }))
			]);
			expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()).toEqual({ name: "users" });
			expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_comments'").get()).toEqual({ name: "issue_comments" });
			expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
				'entity_delta_entries',
				'context_delta_entries',
				'context_term_delta_entries',
				'entity_aliases',
				'entity_revision_entries',
				'context_revision_entries',
				'context_term_revision_entries'
			) ORDER BY name`).all()).toEqual([]);
			expect(migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'legacy_v7_%' ORDER BY name`).all()).toEqual([]);
		} finally {
			migrated.close();
		}
	});

	it("rejects final schema mixed with staged legacy tables without mutation or another backup", async () => {
		const staged = stageFixture();
		await stageLegacyTablesAlongsideFinalSchema(staged);
		const database = new Database(staged);
		const schemaBefore = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const backupsDirectory = path.join(path.dirname(staged), "backups");
		const backupsBefore = readdirSync(backupsDirectory);
		database.close();

		await expect(ensureDatabase(staged, { tenant: "fixture" })).rejects.toThrow(/unsupported source profile/i);

		const inspected = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			expect(inspected.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'legacy_v7_%'").get()).toEqual({ count: 7 });
			expect(inspected.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all()).toEqual([
				{ id: "legacy-v7-direct" },
				...migrations.map(({ id }) => ({ id }))
			]);
		} finally {
			inspected.close();
		}
		expect(readdirSync(backupsDirectory)).toEqual(backupsBefore);
	});

	it("preserves every record when a pre-Drizzle v7 database is opened", async () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);
		const legacyHandoffs = new Database(staged, { readonly: true, fileMustExist: true });
		const handoffs = legacyHandoffs.prepare("SELECT * FROM handoffs ORDER BY rowid").all() as Array<{ id: string; entity_id: string; summary: string; body: string }>;
		legacyHandoffs.close();

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();
		const migratedSchema = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const columns = migratedSchema.prepare(`PRAGMA table_info(revision_entries)`).all() as Array<{ name: string }>;
			expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
				"project_id", "record_kind", "record_key", "patch_format",
				"reverse_patch", "source_hash", "target_hash"
			]));
			expect(columns.some((column) => column.name.startsWith("prior_"))).toBe(false);
			const legacyTables = migratedSchema.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
				AND name IN ('entity_delta_entries', 'context_delta_entries', 'context_term_delta_entries')`).all();
			expect(legacyTables).toEqual([]);
			expect(migratedSchema.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get()).toBeUndefined();
		} finally {
			migratedSchema.close();
		}

		const after = snapshotTables(staged);

		expect(after.context_terms).toEqual(
			expect.arrayContaining((before.context_terms as Record<string, unknown>[]).map((row) => expect.objectContaining(row)))
		);
		expect(after.context_terms).toHaveLength(before.context_terms.length);
		expect(after.context_terms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ revision: 1, tombstone: 0, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
			])
		);
		const migrated = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const contextBaselines = migrated.prepare(`SELECT delta.revision, delta.author, delta.patch_format, length(delta.reverse_patch) AS patch_bytes, lower(hex(delta.source_hash)) AS source_hash, lower(hex(delta.target_hash)) AS target_hash, delta.created_at
				FROM revision_entries AS delta
				JOIN contexts AS head ON head.tenant_id = delta.tenant_id AND delta.record_kind = 'context'
					AND delta.record_key = CAST(length(CAST(head.id AS BLOB)) AS TEXT) || ':' || head.id
				WHERE delta.created_at = head.updated_at
				ORDER BY delta.record_key`).all();
			expect(contextBaselines).toHaveLength(before.contexts.length);
			expect(contextBaselines).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, author: "system", patch_format: 1, source_hash: expect.stringMatching(/^[0-9a-f]{64}$/), target_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]));

			const termBaselines = migrated.prepare(`SELECT delta.revision, delta.author, delta.patch_format, length(delta.reverse_patch) AS patch_bytes, lower(hex(delta.source_hash)) AS source_hash, lower(hex(delta.target_hash)) AS target_hash, delta.created_at
				FROM revision_entries AS delta
				JOIN context_terms AS head ON head.tenant_id = delta.tenant_id AND delta.record_kind = 'context-term'
					AND delta.record_key = CAST(length(CAST(head.id AS BLOB)) AS TEXT) || ':' || head.id
				WHERE delta.created_at = head.updated_at
				ORDER BY delta.record_key`).all();
			expect(termBaselines).toHaveLength(before.context_terms.length);
			expect(termBaselines).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, author: "system", patch_format: 1, source_hash: expect.stringMatching(/^[0-9a-f]{64}$/), target_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })]));
		} finally {
			migrated.close();
		}

		for (const row of before.contexts as Array<{ tenant_id: string; key: string; title: string; summary: string; scope_entity_id: string | null }>) {
			expect(after.contexts).toEqual(expect.arrayContaining([expect.objectContaining({
				tenant_id: row.tenant_id,
				key: row.key,
				title: row.title,
				summary: row.summary,
				scope_entity_id: row.scope_entity_id ? deriveMigratedEntityIdentity("initiative", row.scope_entity_id).stableId : null
			})]));
		}
		expect(after.contexts).toHaveLength((before.contexts as unknown[]).length);
		expect(after.contexts).toEqual(
			expect.arrayContaining([expect.objectContaining({ revision: 1, content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) })])
		);

		const migratedRecords = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			for (const row of before.entities as Array<{ tenant_id: string; id: string; kind: Parameters<typeof deriveMigratedEntityIdentity>[0]; title: string; status: string }>) {
				const identity = deriveMigratedEntityIdentity(row.kind, row.id);
				const status = row.kind === "adr" && ["proposed", "accepted", "superseded"].includes(row.status)
					? "current"
					: row.status;
				expect(migratedRecords.prepare(`SELECT id, reference, title, status FROM entities WHERE tenant_id = ? AND id = ?`).get(row.tenant_id, identity.stableId)).toEqual({ id: identity.stableId, reference: identity.reference, title: row.title, status });
			}
		} finally {
			migratedRecords.close();
		}
		expect(after.entities).toHaveLength(before.entities.length + 2 + handoffs.length);
		expect(after.relations).toHaveLength(before.relations.length + 2 + handoffs.length);

		// counters gains one row per newly-recognized entity kind (project, epic,
		// version - ISS38) that this pre-existing tenant didn't have before.
		expect(after.counters).toEqual(expect.arrayContaining(before.counters));
		expect(after.counters).toHaveLength(before.counters.length + 5);

		const projectId = deriveMigratedEntityIdentity("project", "PROJ0").stableId;
		const epicId = deriveMigratedEntityIdentity("epic", "EPIC0").stableId;
		const initiativeId = deriveMigratedEntityIdentity("initiative", "INIT1").stableId;
		expect(after.entities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", id: projectId, kind: "project" }),
				expect.objectContaining({ tenant_id: "fixture", id: epicId, kind: "epic" })
			])
		);
		expect(after.relations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", from_id: projectId, to_id: epicId, type: "contains" }),
				expect.objectContaining({ tenant_id: "fixture", from_id: epicId, to_id: initiativeId, type: "contains" })
			])
		);
		expect(after.counters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tenant_id: "fixture", kind: "project", next_value: 1 }),
				expect.objectContaining({ tenant_id: "fixture", kind: "epic", next_value: 1 }),
				expect.objectContaining({ tenant_id: "fixture", kind: "version", next_value: 1 })
			])
		);
		expect(handoffs).toHaveLength(1);
		const handoffId = deriveMigratedEntityIdentity("handoff", handoffs[0]!.id).stableId;
		expect(after.entities).toContainEqual(expect.objectContaining({ id: handoffId, kind: "handoff", title: handoffs[0]!.summary, body: handoffs[0]!.body }));
		expect(after.relations).toContainEqual(expect.objectContaining({ from_id: handoffId, to_id: initiativeId, type: "handsOff" }));
	});

	it("backfills a revision-1 ledger entry for every pre-existing record and the new sentinels", async () => {
		const staged = stageFixture();
		const before = snapshotTables(staged);

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		db.close();

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const historyRows = db2
				.prepare(`SELECT record_key, revision, author FROM revision_entries WHERE tenant_id = 'fixture' AND record_kind = 'entity' ORDER BY record_key`)
				.all() as Array<{ record_key: string; revision: number; author: string }>;

			const currentIds = db2.prepare(`SELECT id FROM entities WHERE tenant_id = 'fixture' ORDER BY id`).all() as Array<{ id: string }>;
			const seededIds = historyRows.map((row) => row.record_key.slice(row.record_key.indexOf(":") + 1));
			expect(seededIds.sort()).toEqual(currentIds.map((row) => row.id).sort());
			expect(historyRows.every((row) => row.revision === 1)).toBe(true);
			expect(historyRows.every((row) => row.author === "system")).toBe(true);
		} finally {
			db2.close();
		}
	});

	it("scopes deterministic revision entry ids by tenant", async () => {
		const staged = stageFixture();
		const legacy = new Database(staged);
		try {
			for (const table of ["counters", "entities", "relations", "contexts", "context_terms"] as const) {
				legacy.prepare(`INSERT INTO ${table} SELECT 'other-tenant', ${table === "counters"
					? "kind, next_value"
					: table === "entities"
						? "id, kind, title, status, body, body_source, created_at, updated_at"
						: table === "relations"
							? "from_id, to_id, type, created_at"
							: table === "contexts"
								? "key, scope_entity_id, title, summary, created_at, updated_at"
								: "context_key, term, definition, avoid_terms, created_at, updated_at"}
					FROM ${table} WHERE tenant_id = 'fixture'`).run();
			}
		} finally {
			legacy.close();
		}

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		try {
			const entries = rawDb(db).prepare(`SELECT id, tenant_id, record_kind FROM revision_entries ORDER BY tenant_id, record_kind, id`).all() as Array<{
				id: string;
				record_kind: string;
				tenant_id: string;
			}>;
			expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
			expect(new Set(entries.map(({ tenant_id }) => tenant_id))).toEqual(new Set(["fixture", resolveWellKnownLocalTenantId()]));
			expect(new Set(entries.map(({ record_kind }) => record_kind))).toEqual(new Set(["context", "context-term", "entity"]));
		} finally {
			db.close();
		}
	});

	it("records the legacy v7 transformation and materialized migrations", async () => {
		const staged = stageFixture();

		const { db } = await ensureDatabase(staged, { tenant: "fixture" });
		const schemaBefore = rawDb(db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const ledgerBefore = rawDb(db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all();
		db.close();

		const reopened = await ensureDatabase(staged, { tenant: "fixture" });
		try {
			expect(rawDb(reopened.db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(rawDb(reopened.db).prepare("SELECT id, applied_at FROM schema_migrations ORDER BY rowid").all()).toEqual(ledgerBefore);
		} finally {
			closeInspectionHandle(reopened.db);
		}

		const db2 = new Database(staged, { readonly: true, fileMustExist: true });
		try {
			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "legacy-v7-direct" },
				...migrations.map(({ id }) => ({ id }))
			].sort((left, right) => left.id.localeCompare(right.id)));
		} finally {
			db2.close();
		}
	});
});

describe("real-world multi-tenant migration (ISS177 regression fixture)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let dbPath: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-real-world-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		mkdirSync(path.join(homeDirectory, ".agent-issues"), { recursive: true });
		dbPath = path.join(homeDirectory, ".agent-issues", "agent-issues.db");
		copyFileSync(REAL_WORLD_FIXTURE, dbPath);
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("consolidates every genuine legacy tenant into its own project, manufacturing no phantom projects", async () => {
		const before = new Database(dbPath, { readonly: true, fileMustExist: true });
			const entityCountBefore = REAL_WORLD_LEGACY_TENANT_IDS.reduce((sum, tenantId) => {
			const row = before.prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(tenantId) as { count: number };
			return sum + row.count;
		}, 0);
			const handoffCountBefore = REAL_WORLD_LEGACY_TENANT_IDS.reduce((sum, tenantId) => {
				const row = before.prepare(`SELECT COUNT(*) AS count FROM handoffs WHERE tenant_id = ?`).get(tenantId) as { count: number };
				return sum + row.count;
			}, 0);
		before.close();

		const { db } = await ensureDatabase(undefined, { projectIdentity: "agent-issues" });
		try {
			const wellKnownTenantId = resolveWellKnownLocalTenantId();
			expect(db.tenantId).toBe(wellKnownTenantId);

			expect(rawDb(db).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('project_migrations', '__drizzle_migrations')`).all()).toEqual([]);
			const migratedProjectTitles = rawDb(db)
				.prepare(`SELECT title FROM entities WHERE tenant_id = ? AND kind = 'project' AND title != 'Default Project' ORDER BY title`)
				.all(wellKnownTenantId) as Array<{ title: string }>;
			expect(migratedProjectTitles.map((row) => row.title)).toEqual([
				"Agent Issues",
				"Content Hub",
				"Eye Share Devops Net",
				"Weave"
			]);

			// Exactly one freshly-minted project per real legacy tenant, plus the
			// well-known tenant's own PROJ0 sentinel - no ghost project should be
			// manufactured for a counter-only tenant with no real content (ISS177).
			const projectCount = (
				rawDb(db).prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ? AND kind = 'project'`).get(wellKnownTenantId) as {
					count: number;
				}
			).count;
			expect(projectCount).toBe(REAL_WORLD_LEGACY_TENANT_IDS.length + 1);

			// Every real entity from every legacy tenant survives the fold-in,
			// remapped under the well-known tenant, plus one fresh project+epic
			// pair per legacy tenant and the well-known tenant's own pair.
			const entityCountAfter = (
				rawDb(db).prepare(`SELECT COUNT(*) AS count FROM entities WHERE tenant_id = ?`).get(wellKnownTenantId) as { count: number }
			).count;
			expect(entityCountAfter).toBe(entityCountBefore + handoffCountBefore + (REAL_WORLD_LEGACY_TENANT_IDS.length + 1) * 2);

			// No tenant id survives outside the well-known tenant - full
			// consolidation, no residue left behind.
			const remainingForeignTenants = rawDb(db).prepare(`SELECT DISTINCT tenant_id FROM entities WHERE tenant_id != ?`).all(wellKnownTenantId);
			expect(remainingForeignTenants).toEqual([]);
		} finally {
			db.close();
		}
	});

});

function freshDatabasePath(): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-fresh-"));
	tempDirs.push(tempDir);
	return path.join(tempDir, "fresh.db");
}

describe("fresh install schema parity", () => {
	it("records the complete migration ledger", async () => {
		const dbPath = freshDatabasePath();
		const { db } = await ensureDatabase(dbPath, { tenant: "fresh" });
		db.close();

		const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			const applied = db2.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>;
			expect(applied).toEqual([
				{ id: "adr-status-to-current" },
				{ id: "completion-observation-version-state" },
				{ id: "completion-observations" },
				{ id: "context-term-provenance" },
				{ id: "debt-metadata" },
				{ id: "entity-search" },
				{ id: "entity-type" },
				{ id: "final-baseline" },
				{ id: "instruction-defaults" },
				{ id: "instruction-history" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-resets" },
				{ id: "issue-breakdown-drafts" },
				{ id: "issue-comments" },
				{ id: "pioneer-entity-types" },
				{ id: "plan-entries" },
				{ id: "plan-entry-supersession-position" },
				{ id: "project-settings" },
				{ id: "record-provenance" },
				{ id: "record-search" },
				{ id: "relation-provenance" },
				{ id: "search-typo-vocabulary" },
				{ id: "short-entity-reference" },
				{ id: "short-record-reference" },
				{ id: "token-search" },
				{ id: "trigram-search" },
				{ id: "user-directory" }
			]);
		} finally {
			db2.close();
		}
	});
});

describe("legacy pre-tenant migration through the ADR43 runner", () => {
	function writePreTenantDatabase(dbPath: string): void {
		const db = new Database(dbPath);
		try {
			db.exec(`
				CREATE TABLE counters (kind TEXT PRIMARY KEY, next_value INTEGER NOT NULL);
				CREATE TABLE entities (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					title TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE relations (
					from_id TEXT NOT NULL,
					to_id TEXT NOT NULL,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					PRIMARY KEY (from_id, to_id, type)
				);
				CREATE TABLE contexts (
					key TEXT PRIMARY KEY,
					scope_entity_id TEXT,
					title TEXT NOT NULL,
					summary TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE context_terms (
					context_key TEXT NOT NULL,
					term TEXT NOT NULL,
					definition TEXT NOT NULL,
					avoid_terms TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (context_key, term)
				);
			`);
			const now = "2024-01-01T00:00:00.000Z";
			db.prepare(`INSERT INTO counters (kind, next_value) VALUES ('initiative', 2), ('issue', 2)`).run();
			db.prepare(`INSERT INTO entities (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
				"INIT1",
				"initiative",
				"Legacy initiative",
				"active",
				now,
				now
			);
			db.prepare(`INSERT INTO entities (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
				"ISS1",
				"issue",
				"Legacy issue",
				"todo",
				now,
				now
			);
			db.prepare(`INSERT INTO relations (from_id, to_id, type, created_at) VALUES ('INIT1', 'ISS1', 'tracks', ?)`).run(now);
			db.prepare(`INSERT INTO contexts (key, scope_entity_id, title, summary, created_at, updated_at) VALUES ('INIT1', 'INIT1', 'Legacy context', 'Scope summary', ?, ?)`).run(now, now);
			db.prepare(`INSERT INTO context_terms (context_key, term, definition, avoid_terms, created_at, updated_at) VALUES ('INIT1', 'Widget', 'A legacy widget.', '', ?, ?)`).run(now, now);
		} finally {
			db.close();
		}
	}

	it("rejects a pre-ledger schema that does not match either complete v7 fixture", async () => {
		const dbPath = freshDatabasePath();
		writePreTenantDatabase(dbPath);
		const before = new Database(dbPath, { readonly: true, fileMustExist: true });
		const schemaBefore = before.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
		const entitiesBefore = before.prepare("SELECT * FROM entities ORDER BY id").all();
		before.close();

		await expect(ensureDatabase(dbPath, { tenant: "legacy" })).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

		const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			expect(db2.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).toEqual(schemaBefore);
			expect(db2.prepare("SELECT * FROM entities ORDER BY id").all()).toEqual(entitiesBefore);
			expect(db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeUndefined();
		} finally {
			db2.close();
		}
	});
});
