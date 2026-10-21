import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

import {
	AGENT_ISSUES_DIRECTORY,
	DEFAULT_DATABASE_FILENAME,
	DEFAULT_EPIC_ID,
	DEFAULT_EPIC_TITLE,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_TITLE,
	deriveMigratedEntityIdentity,
	ENTITY_KINDS,
	formatTenantDisplayName,
	formatUnsupportedSourceProfile,
	isDirectEntitySelector,
	resolveAgentIssuesHomeDirectory,
	resolveWellKnownLocalTenantId,
	sanitizePathSegment,
	shortEntityReference,
	type DeleteTenantResult,
	type RenameTenantResult,
	type TenantRecordCounts,
	type TenantSummary
} from "@agent-issues/core";
import { createEntity } from "../features/entity-store/store.js";
import { createSqliteUpgradeBackup, runMigrations } from "./migration-runner.js";
import { createSqliteExecutor, type SqliteExecutor, type SqliteInternalConnection } from "./sqlite-executor.js";
import { openSqliteConnection } from "./sqlite-connection.js";
import { inspectSqliteSourceProfile } from "./source-profile.js";
import { migrations } from "../migrations/index.js";
import { insertLegacySqliteV7Rows, transformLegacySqliteV7 } from "../migrations/legacy-v7-direct.js";
import { buildLegacySqliteV7Rows } from "../migrations/legacy-v7-semantic.js";

export {
	resolveAgentIssuesHomeDirectory,
	resolveWellKnownLocalTenantId,
	sanitizePathSegment,
	type DeleteTenantResult,
	type RenameTenantResult,
	type TenantRecordCounts,
	type TenantSummary
};

export type DatabaseHandle = SqliteInternalConnection;

export type OpenDatabaseResult = {
	db: DatabaseHandle;
	executor: SqliteInternalConnection;
	dbPath: string;
};

export type DatabaseLocationOptions = {
	tenant?: string;
	currentWorkingDirectory?: string;
	projectIdentity?: string;
};

const LEGACY_TENANTS_DIRECTORY = "tenants";

const EXPECTED_FINAL_LEDGER_IDS = migrations.map(({ id }) => id);

export function resolveDatabasePath(inputPath?: string, options?: DatabaseLocationOptions): string {
	if (inputPath) {
		return path.resolve(inputPath);
	}

	return path.join(resolveAgentIssuesHomeDirectory(), DEFAULT_DATABASE_FILENAME);
}

export function querySqlite(dbPath: string, statement: string): unknown[] {
	const db = openSqliteConnection(dbPath, { fileMustExist: true, readonly: true });
	try {
		return db.drizzle.all(sql.raw(statement));
	} finally {
		db.close();
	}
}

export async function ensureDatabase(inputPath?: string, options?: DatabaseLocationOptions): Promise<OpenDatabaseResult> {
	const dbPath = resolveDatabasePath(inputPath, options);
	mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = createSqliteExecutor(dbPath);
	try {
		const prepareUpgradeBackup = createSqliteUpgradeBackup(db, dbPath);
		db.tenantId = resolveTenantSlug(options);
		const sourceProfile = inspectSqliteSourceProfile(db, EXPECTED_FINAL_LEDGER_IDS);
		if (!sourceProfile.supported) {
			throw new Error(formatUnsupportedSourceProfile(sourceProfile));
		}
		db.drizzle.run(sql.raw("PRAGMA journal_mode = WAL"));
		db.drizzle.run(sql.raw("PRAGMA foreign_keys = ON"));
		if (sourceProfile.profile === "empty") {
			await runMigrations(db, migrations);
		} else if (sourceProfile.profile === "legacy-sqlite-v7") {
			prepareUpgradeBackup();
			await transformLegacySqliteV7(db);
			await runMigrations(db, migrations, { prepareBackup: prepareUpgradeBackup });
		} else if (sourceProfile.profile === "current-final") {
			await runMigrations(db, migrations, { prepareBackup: prepareUpgradeBackup });
		}
		if (!inputPath) {
			importLegacyTenantDataIfNeeded(db, options);
		}
		if (!isTenantBootstrapped(db)) {
			ensureFullChainInvariant(db, dbPath);
			ensureTenantCounters(db);
		}
		db.currentProjectId = resolveCurrentProjectId(db, options?.currentWorkingDirectory, options?.projectIdentity);

		return { db, executor: db, dbPath };
	} catch (error) {
		db.close();
		throw error;
	}
}

export function resolveTenantDirectory(options?: DatabaseLocationOptions): string {
	const requestedTenant = options?.tenant?.trim();
	const slug = requestedTenant
		? resolveTenantSlug(options)
		: resolveLegacyWorkspaceTenantId(options?.currentWorkingDirectory ?? process.cwd());
	return path.join(resolveAgentIssuesHomeDirectory(), LEGACY_TENANTS_DIRECTORY, slug);
}

export function resolveLegacyDatabasePath(options?: DatabaseLocationOptions): string {
	return path.join(resolveTenantRootPath(options?.currentWorkingDirectory ?? process.cwd()), AGENT_ISSUES_DIRECTORY, DEFAULT_DATABASE_FILENAME);
}

export function resolveTenantSlug(options?: DatabaseLocationOptions): string {
	const requestedTenant = options?.tenant?.trim();
	if (requestedTenant) {
		const sanitizedTenant = sanitizePathSegment(requestedTenant);
		if (sanitizedTenant.length === 0) {
			throw new Error(`Invalid tenant name: ${requestedTenant}`);
		}

		return sanitizedTenant;
	}

	return resolveWellKnownLocalTenantId();
}

/**
 * The pre-ISS63 per-workspace tenant formula, retained to locate old
 * per-workspace database files for direct import into the shared database.
 */
export function resolveLegacyWorkspaceTenantId(currentWorkingDirectory: string): string {
	const workspacePath = resolveTenantRootPath(currentWorkingDirectory);
	const workspaceName = sanitizePathSegment(path.basename(workspacePath)) || "workspace";
	const workspaceHash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
	return `${workspaceName}-${workspaceHash}`;
}

export function listTenants(db: SqliteInternalConnection): TenantSummary[] {
	const rows = db.drizzle.all<{
		tenant_id: string;
		entity_count: number;
		relation_count: number;
		context_count: number;
		context_term_count: number;
		history_entry_count: number;
	}>(sql`
			WITH tenant_ids AS (
				SELECT tenant_id FROM entities
				UNION
				SELECT tenant_id FROM relations
				UNION
				SELECT tenant_id FROM contexts
				UNION
				SELECT tenant_id FROM context_terms
				UNION
				SELECT tenant_id FROM revision_entries
			)
			SELECT tenant_ids.tenant_id,
				COALESCE(entity_counts.entity_count, 0) AS entity_count,
				COALESCE(relation_counts.relation_count, 0) AS relation_count,
				COALESCE(context_counts.context_count, 0) AS context_count,
				COALESCE(context_term_counts.context_term_count, 0) AS context_term_count,
				COALESCE(history_entry_counts.history_entry_count, 0) AS history_entry_count
			FROM tenant_ids
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS entity_count
				FROM entities
				GROUP BY tenant_id
			) AS entity_counts ON entity_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS relation_count
				FROM relations
				GROUP BY tenant_id
			) AS relation_counts ON relation_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS context_count
				FROM contexts
				GROUP BY tenant_id
			) AS context_counts ON context_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, COUNT(*) AS context_term_count
				FROM context_terms
				GROUP BY tenant_id
			) AS context_term_counts ON context_term_counts.tenant_id = tenant_ids.tenant_id
			LEFT JOIN (
				SELECT tenant_id, SUM(revision) AS history_entry_count
				FROM entities
				GROUP BY tenant_id
			) AS history_entry_counts ON history_entry_counts.tenant_id = tenant_ids.tenant_id
			ORDER BY tenant_ids.tenant_id
		`);

	return rows.map((row) => ({
		counts: {
			contexts: row.context_count,
			contextTerms: row.context_term_count,
			entities: row.entity_count,
			historyEntries: row.history_entry_count,
			relations: row.relation_count
		},
		displayName: formatTenantDisplayName(row.tenant_id),
		id: row.tenant_id
	}));
}

export function deleteTenant(db: SqliteInternalConnection, tenantId: string): DeleteTenantResult {
	const counts = getTenantRecordCounts(db, tenantId);

	const counters = db.drizzle.transaction(() => {
		db.drizzle.run(sql`DELETE FROM revision_entries WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM plan_entry_references WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM plan_entry_supersessions WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM plan_entries WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM context_terms WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM relations WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM contexts WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM entities WHERE tenant_id = ${tenantId}`);
		db.drizzle.run(sql`DELETE FROM search_documents WHERE tenant_id = ${tenantId}`);
		return db.drizzle.run(sql`DELETE FROM counters WHERE tenant_id = ${tenantId}`).changes;
	});

	return {
		counts,
		counters,
		displayName: formatTenantDisplayName(tenantId),
		removed: counters > 0 || Object.values(counts).some((count) => count > 0),
		tenantId
	};
}

export function renameTenant(db: SqliteInternalConnection, previousTenantId: string, newTenantId: string): RenameTenantResult {
	if (previousTenantId === newTenantId) {
		throw new Error("Source and destination tenant ids are the same.");
	}

	if (tenantHasAnyRows(db, newTenantId)) {
		throw new Error(`Target tenant already exists: ${newTenantId}`);
	}

	const counts = getTenantRecordCounts(db, previousTenantId);
	const counters = getTenantCounterCount(db, previousTenantId);
	const renamed = counters > 0 || Object.values(counts).some((count) => count > 0);

	if (!renamed) {
		return {
			counts,
			counters,
			newDisplayName: formatTenantDisplayName(newTenantId),
			newTenantId,
			previousDisplayName: formatTenantDisplayName(previousTenantId),
			previousTenantId,
			renamed: false
		};
	}

	db.drizzle.run(sql.raw("PRAGMA defer_foreign_keys = ON"));
	try {
		db.drizzle.transaction(() => {
			db.drizzle.run(sql`UPDATE plan_entry_references SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE plan_entry_supersessions SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE plan_entries SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE counters SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE project_settings SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE entities SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE search_documents SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE relations SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE contexts SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE context_terms SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
			db.drizzle.run(sql`UPDATE revision_entries SET tenant_id = ${newTenantId} WHERE tenant_id = ${previousTenantId}`);
		});
	} finally {
		db.drizzle.run(sql.raw("PRAGMA defer_foreign_keys = OFF"));
	}

	return {
		counts,
		counters,
		newDisplayName: formatTenantDisplayName(newTenantId),
		newTenantId,
		previousDisplayName: formatTenantDisplayName(previousTenantId),
		previousTenantId,
		renamed: true
	};
}

export function resolveTenantRootPath(currentWorkingDirectory: string): string {
	const resolvedWorkingDirectory = path.resolve(currentWorkingDirectory);
	let candidatePath = resolvedWorkingDirectory;

	while (true) {
		if (existsSync(path.join(candidatePath, "pnpm-workspace.yaml"))) {
			return candidatePath;
		}

		if (existsSync(path.join(candidatePath, ".git"))) {
			return candidatePath;
		}

		const parentPath = path.dirname(candidatePath);
		if (parentPath === candidatePath) {
			break;
		}

		candidatePath = parentPath;
	}

	candidatePath = resolvedWorkingDirectory;
	while (true) {
		if (existsSync(path.join(candidatePath, "package.json"))) {
			return candidatePath;
		}

		const parentPath = path.dirname(candidatePath);
		if (parentPath === candidatePath) {
			return resolvedWorkingDirectory;
		}

		candidatePath = parentPath;
	}
}

function getTenantRecordCounts(db: SqliteInternalConnection, tenantId: string): TenantRecordCounts {
	const row = db.drizzle.get<{
			entity_count: number;
			relation_count: number;
			context_count: number;
			context_term_count: number;
			history_entry_count: number;
		}>(sql`
			SELECT
				(SELECT COUNT(*) FROM entities WHERE tenant_id = ${tenantId}) AS entity_count,
				(SELECT COUNT(*) FROM relations WHERE tenant_id = ${tenantId}) AS relation_count,
				(SELECT COUNT(*) FROM contexts WHERE tenant_id = ${tenantId}) AS context_count,
				(SELECT COUNT(*) FROM context_terms WHERE tenant_id = ${tenantId}) AS context_term_count,
				(SELECT COALESCE(SUM(revision), 0) FROM entities WHERE tenant_id = ${tenantId}) AS history_entry_count
		`)!;

	return {
		contexts: row.context_count,
		contextTerms: row.context_term_count,
		entities: row.entity_count,
		historyEntries: row.history_entry_count,
		relations: row.relation_count
	};
}

function getTenantCounterCount(db: SqliteInternalConnection, tenantId: string): number {
	const row = db.drizzle.get<{ counter_count: number }>(
		sql`SELECT COUNT(*) AS counter_count FROM counters WHERE tenant_id = ${tenantId}`
	)!;

	return row.counter_count;
}

function tenantHasAnyRows(db: SqliteInternalConnection, tenantId: string): boolean {
	const row = db.drizzle.get<{ has_rows: number }>(sql`
		SELECT EXISTS(
			SELECT 1 FROM counters WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM entities WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM search_documents WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM relations WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM contexts WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM context_terms WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM plan_entries WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM plan_entry_references WHERE tenant_id = ${tenantId}
			UNION SELECT 1 FROM plan_entry_supersessions WHERE tenant_id = ${tenantId}
		) AS has_rows
	`)!;

	return row.has_rows === 1;
}

/**
 * Whether the current tenant (`db.tenantId`) has already been through the
 * onboarding pair below at least once. `counters` is seeded the moment a
 * tenant is first onboarded (or retroactively by the one-time historical
 * backfill migration) and never removed while the tenant exists, so an
 * indexed prefix lookup on its `(tenant_id, kind)` primary key answers this
 * in O(1) - unlike `ensureFullChainInvariant`, which would otherwise have to
 * re-inspect this tenant's live entities on every single open just to
 * re-derive "has this already happened?" (ISS179). A tenant, once
 * bootstrapped, stays bootstrapped forever - this is safe to treat as a
 * permanent fact about `db.tenantId`, unlike the legacy-tenant sweep below
 * (a brand-new `--tenant` can still appear later).
 */
function isTenantBootstrapped(db: DatabaseHandle): boolean {
	return db.drizzle.get(sql`SELECT 1 FROM counters WHERE tenant_id = ${db.tenantId} LIMIT 1`) !== undefined;
}

function ensureTenantCounters(db: DatabaseHandle): void {
	for (const kind of ENTITY_KINDS) {
		db.drizzle.run(sql`
			INSERT INTO counters (tenant_id, kind, next_value)
			VALUES (${db.tenantId}, ${kind}, 1)
			ON CONFLICT(tenant_id, kind) DO NOTHING
		`);
	}

	db.drizzle.run(sql`
		INSERT INTO counters (tenant_id, kind, next_value)
		VALUES (${db.tenantId}, ${"handoff"}, 1)
		ON CONFLICT(tenant_id, kind) DO NOTHING
	`);
}

/**
 * Synthesizes the tenant's sentinel default project/epic and attaches any
 * parentless initiative to them, so every initiative always resolves a
 * complete tenant>project>epic>initiative chain (the "full-chain invariant",
 * ADR7). Idempotent on every open, mirroring `ensureTenantCounters`. Backs up
 * the database file the first time this runs against a tenant that already
 * has data (ADR20) — a fresh, empty tenant has nothing worth protecting.
 */
function ensureFullChainInvariant(db: DatabaseHandle, dbPath?: string): void {
	if (dbPath !== undefined && !entityExists(db, DEFAULT_PROJECT_ID) && tenantHasAnyRows(db, db.tenantId)) {
		backupDatabaseFile(db, dbPath);
	}

	const now = new Date().toISOString();
	insertSentinelEntity(db, DEFAULT_PROJECT_ID, "project", DEFAULT_PROJECT_TITLE, now);
	insertSentinelEntity(db, DEFAULT_EPIC_ID, "epic", DEFAULT_EPIC_TITLE, now);
	insertSentinelRelation(db, DEFAULT_PROJECT_ID, DEFAULT_EPIC_ID, now);
	attachOrphanInitiativesToDefaultEpic(db, now);
}

function entityExists(db: DatabaseHandle, entityId: string): boolean {
	const canonicalReference = resolveEntityReference(db, entityId);
	return db.drizzle.get(sql`SELECT 1 FROM entities WHERE tenant_id = ${db.tenantId} AND id = ${canonicalReference}`) !== undefined;
}

function insertSentinelEntity(db: DatabaseHandle, id: string, kind: string, title: string, now: string): void {
	if (tableHasColumn(db, "entities", "reference")) {
		const identity = deriveMigratedEntityIdentity(kind === "project" ? "project" : "epic", id);
		const projectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
		db.drizzle.run(sql`
			INSERT INTO entities (tenant_id, id, reference, short_reference, kind, title, status, body, body_source, project_id, created_at, updated_at)
			VALUES (${db.tenantId}, ${identity.stableId}, ${identity.reference}, ${shortEntityReference({ id: identity.stableId, kind })}, ${kind}, ${title}, 'active', '', 'generated', ${projectId}, ${now}, ${now})
			ON CONFLICT (tenant_id, id) DO NOTHING
		`);
		return;
	}
	if (tableHasColumn(db, "entities", "stable_id")) {
		const identity = deriveMigratedEntityIdentity(kind === "project" ? "project" : "epic", id);
		db.drizzle.run(sql`
			INSERT INTO entities (tenant_id, id, stable_id, kind, title, status, body, body_source, project_id, created_at, updated_at)
			VALUES (${db.tenantId}, ${identity.reference}, ${identity.stableId}, ${kind}, ${title}, 'active', '', 'generated', ${identity.reference}, ${now}, ${now})
			ON CONFLICT (tenant_id, id) DO NOTHING
		`);
		db.drizzle.run(sql`
			INSERT INTO entity_aliases (tenant_id, alias, entity_stable_id) VALUES (${db.tenantId}, ${id}, ${identity.stableId})
			ON CONFLICT (tenant_id, alias) DO NOTHING
		`);
		return;
	}
	if (tableHasColumn(db, "entities", "project_id")) {
		db.drizzle.run(sql`
			INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, project_id, created_at, updated_at)
			VALUES (${db.tenantId}, ${id}, ${kind}, ${title}, 'active', '', 'generated', ${DEFAULT_PROJECT_ID}, ${now}, ${now})
			ON CONFLICT (tenant_id, id) DO NOTHING
		`);
		return;
	}

	db.drizzle.run(sql`
		INSERT INTO entities (tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
		VALUES (${db.tenantId}, ${id}, ${kind}, ${title}, 'active', '', 'generated', ${now}, ${now})
		ON CONFLICT (tenant_id, id) DO NOTHING
	`);
}

function insertSentinelRelation(db: DatabaseHandle, fromId: string, toId: string, now: string): void {
	const canonicalFromId = resolveEntityReference(db, fromId);
	const canonicalToId = resolveEntityReference(db, toId);
	db.drizzle.run(sql`
		INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
		VALUES (${db.tenantId}, ${canonicalFromId}, ${canonicalToId}, 'contains', ${now})
		ON CONFLICT (tenant_id, from_id, to_id, type) DO NOTHING
	`);
}

function resolveEntityReference(db: DatabaseHandle, reference: string): string {
	if (tableHasColumn(db, "entities", "reference")) {
		if (reference === DEFAULT_PROJECT_ID) return deriveMigratedEntityIdentity("project", reference).stableId;
		if (reference === DEFAULT_EPIC_ID) return deriveMigratedEntityIdentity("epic", reference).stableId;
		return reference;
	}
	if (!tableHasColumn(db, "entities", "stable_id")) return reference;
	const row = db.drizzle.get<{ id: string }>(sql`
		SELECT entities.id
		FROM entity_aliases
		JOIN entities ON entities.tenant_id = entity_aliases.tenant_id
			AND entities.stable_id = entity_aliases.entity_stable_id
		WHERE entity_aliases.tenant_id = ${db.tenantId} AND entity_aliases.alias = ${reference}
	`);
	return row?.id ?? reference;
}

function attachOrphanInitiativesToDefaultEpic(db: DatabaseHandle, now: string): void {
	const orphanInitiatives = db.drizzle.all<{ id: string }>(sql`
		SELECT id FROM entities
		WHERE tenant_id = ${db.tenantId} AND kind = 'initiative'
		  AND id NOT IN (
			SELECT to_id FROM relations WHERE tenant_id = ${db.tenantId} AND type = 'contains'
		  )
	`);

	for (const { id } of orphanInitiatives) {
		insertSentinelRelation(db, DEFAULT_EPIC_ID, id, now);
	}
}

/**
 * Every live project in this tenant whose title normalizes to `normalizedTitle`.
 * More than one means the identity is ambiguous; none means it has not been
 * registered yet.
 */
function findProjectsByNormalizedTitle(db: DatabaseHandle, normalizedTitle: string): Array<{ id: string; title: string }> {
	const projects = db.drizzle.all<{ id: string; title: string }>(
		sql`SELECT id, title FROM entities WHERE tenant_id = ${db.tenantId} AND kind = 'project' AND tombstone = 0`
	) as Array<{ id: string; title: string }>;
	return projects.filter((project) => sanitizePathSegment(project.title) === normalizedTitle);
}

/**
 * Registers this workspace's own project the first time agent-issues runs in
 * it, so a fresh repo is usable with no setup step - the zero-config local
 * use ADR "Multi-source project identity resolution" commits to. Creates the
 * project>epic chain (ADR7) the way the cloud gate's
 * `getOrCreateProjectByIdentity` does: without the epic, an initiative
 * created here would fall back to the sentinel `EPIC0` and land under the
 * Default Project instead of this one. Both entities start `active` rather
 * than `draft` - the workspace is being worked in right now, which is what
 * brought this call here.
 *
 * Runs the miss-check and the write in one `immediate` transaction, which
 * takes SQLite's write lock up front. The daemon serializes production access,
 * and the transaction keeps direct backend tests safe from duplicate project
 * registration. A duplicate would make the identity permanently ambiguous.
 */
function registerWorkspaceProject(db: DatabaseHandle, title: string, normalizedTitle: string): string {
	return db.drizzle.transaction(
		() => {
			const alreadyRegistered = findProjectsByNormalizedTitle(db, normalizedTitle);
			if (alreadyRegistered.length > 0) {
				return alreadyRegistered[0]!.id;
			}

			const project = createEntity(db, { kind: "project", status: "active", title });
			createEntity(db, { kind: "epic", parentId: project.id, status: "active", title: DEFAULT_EPIC_TITLE });
			return project.id;
		},
		{ behavior: "immediate" }
	);
}

/**
 * Resolves the current invocation's project from the identity already
 * derived by the CLI. UUID and Canonical reference selectors are direct;
 * repository-style identities use a normalized exact title match, and
 * register themselves when no project matches yet.
 */
export function resolveCurrentProjectId(
	db: DatabaseHandle,
	_currentWorkingDirectory: string = process.cwd(),
	projectIdentity?: string
): string {
	const selector = projectIdentity?.trim();
	if (selector) {
		const directProject = db.drizzle.get<{ id: string }>(
			sql`SELECT id FROM entities WHERE tenant_id = ${db.tenantId} AND kind = 'project' AND tombstone = 0 AND (id = ${selector} OR reference = ${selector})`
		);
		if (directProject) {
			return directProject.id;
		}

		const normalizedSelector = sanitizePathSegment(selector);
		const matchingProjects = findProjectsByNormalizedTitle(db, normalizedSelector);
		if (matchingProjects.length === 0) {
			if (isDirectEntitySelector(selector)) {
				throw new Error(`Cannot resolve project identity "${selector}" in tenant ${db.tenantId}.`);
			}

			return registerWorkspaceProject(db, selector, normalizedSelector);
		}
		if (matchingProjects.length > 1) {
			throw new Error(`Ambiguous project identity "${selector}" in tenant ${db.tenantId}.`);
		}
		return matchingProjects[0]!.id;
	}

	const projects = db.drizzle.all<{ id: string }>(
		sql`SELECT id FROM entities WHERE tenant_id = ${db.tenantId} AND kind = 'project' AND tombstone = 0 ORDER BY id`
	);
	if (projects.length === 1) {
		return projects[0]!.id;
	}
	throw new Error(`Project identity is required for tenant ${db.tenantId}, which contains ${projects.length} projects.`);
}

function backupDatabaseFile(db: DatabaseHandle, dbPath: string): void {
	db.drizzle.all(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)"));

	// Co-located with the actual database file rather than a fixed home-directory
	// path, so this respects an explicit --path/dbPath choice (and keeps tests
	// that use a temp dbPath from writing into the real user home directory).
	const backupsDirectory = path.join(path.dirname(dbPath), "backups");
	mkdirSync(backupsDirectory, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(backupsDirectory, `${path.basename(dbPath, ".db")}-${db.tenantId}-${timestamp}.db`);
	copyFileSync(dbPath, backupPath);
}

function importLegacyTenantDataIfNeeded(db: DatabaseHandle, options?: DatabaseLocationOptions): void {
	if (tenantHasData(db)) {
		return;
	}

	const candidatePaths = [
		path.join(resolveTenantDirectory(options), DEFAULT_DATABASE_FILENAME),
		resolveLegacyDatabasePath(options)
	].filter((candidatePath, index, allPaths) => allPaths.indexOf(candidatePath) === index && existsSync(candidatePath));

	for (const candidatePath of candidatePaths) {
		if (candidatePath === resolveDatabasePath(undefined, options)) {
			continue;
		}

		if (importTenantDataFromExternalDatabase(db, candidatePath)) {
			return;
		}
	}
}

function tenantHasData(db: DatabaseHandle): boolean {
	const row = db.drizzle.get<{ has_entities: number; has_contexts: number }>(sql`
		SELECT EXISTS(SELECT 1 FROM entities WHERE tenant_id = ${db.tenantId} LIMIT 1) AS has_entities,
		       EXISTS(SELECT 1 FROM contexts WHERE tenant_id = ${db.tenantId} LIMIT 1) AS has_contexts
	`)!;

	return row.has_entities === 1 || row.has_contexts === 1;
}

function importTenantDataFromExternalDatabase(db: DatabaseHandle, sourcePath: string): boolean {
	const source = openSqliteConnection(sourcePath, { fileMustExist: true, readonly: true });
	try {
		const sourceProfile = inspectSqliteSourceProfile(source, EXPECTED_FINAL_LEDGER_IDS);
		if (sourceProfile.profile === "empty") {
			return false;
		}
		if (!sourceProfile.supported) {
			throw new Error(formatUnsupportedSourceProfile(sourceProfile));
		}
		if (sourceProfile.profile !== "legacy-sqlite-v7") {
			throw new Error(`External legacy import requires a legacy SQLite v7 source, found ${sourceProfile.profile}.`);
		}
		source.tenantId = db.tenantId;
		const rows = buildLegacySqliteV7Rows(source);
		db.drizzle.run(sql.raw("PRAGMA defer_foreign_keys = ON"));
		try {
			db.drizzle.transaction(() => insertLegacySqliteV7Rows(db, rows));
		} finally {
			db.drizzle.run(sql.raw("PRAGMA defer_foreign_keys = OFF"));
		}
		return true;
	} finally {
		source.close();
	}
}

function tableHasColumn(db: DatabaseHandle, tableName: string, columnName: string): boolean {
	const columns = db.drizzle.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(tableName)})`);
	return columns.some((column) => column.name === columnName);
}