import { isDeepStrictEqual } from "node:util";

import {
	applyReverseFieldPatch,
	CONTEXT_REVERSE_PATCH_REGISTRY,
	CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
	ENTITY_REVERSE_PATCH_REGISTRY,
	type ReversePatchRegistry
} from "@agent-issues/core";
import { sql } from "drizzle-orm";
import { createSqliteMigrationConn } from "../db/migration-runner.js";
import type { SqliteInternalConnection } from "../db/sqlite-executor.js";
import { finalBaselineMigration } from "./final-baseline.js";
import { userDirectoryMigration } from "./user-directory.js";
import { recordProvenanceMigration } from "./record-provenance.js";
import { contextTermProvenanceMigration } from "./context-term-provenance.js";
import { relationProvenanceMigration } from "./relation-provenance.js";
import { issueCommentsMigration } from "./issue-comments.js";
import { adrStatusMigration } from "./adr-status-migration.js";
import { buildLegacySqliteV7Rows, type LegacySqliteV7RevisionValidation, type LegacySqliteV7Rows } from "./legacy-v7-semantic.js";

export const LEGACY_V7_DIRECT_CHECKPOINT = "legacy-v7-direct";

export async function transformLegacySqliteV7(database: SqliteInternalConnection): Promise<void> {
	const revisionValidation: LegacySqliteV7RevisionValidation[] = [];
	database.drizzle.run(sql.raw("BEGIN"));
	try {
		database.drizzle.run(sql.raw("PRAGMA defer_foreign_keys = ON"));
		const rows = buildLegacySqliteV7Rows(database, "", revisionValidation);
		stageLegacySourceTables(database);
		await finalBaselineMigration.up(createSqliteMigrationConn(database));
		await userDirectoryMigration.up(createSqliteMigrationConn(database));
		await issueCommentsMigration.up(createSqliteMigrationConn(database));
		insertLegacySqliteV7Rows(database, rows);
		await recordProvenanceMigration.up(createSqliteMigrationConn(database));
		await contextTermProvenanceMigration.up(createSqliteMigrationConn(database));
		await relationProvenanceMigration.up(createSqliteMigrationConn(database));
		validateAndContractLegacySqliteV7(database, rows, revisionValidation);
		await adrStatusMigration.up(createSqliteMigrationConn(database));
		database.drizzle.run(sql.raw(`CREATE TABLE schema_migrations (
			id TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`));
		for (const id of [
			LEGACY_V7_DIRECT_CHECKPOINT,
			finalBaselineMigration.id,
			adrStatusMigration.id,
			userDirectoryMigration.id,
			recordProvenanceMigration.id,
			contextTermProvenanceMigration.id,
			relationProvenanceMigration.id,
			issueCommentsMigration.id
		]) {
			database.drizzle.run(sql`INSERT INTO schema_migrations (id, applied_at) VALUES (${id}, ${new Date().toISOString()})`);
		}
		database.drizzle.run(sql.raw("COMMIT"));
	} catch (error) {
		database.drizzle.run(sql.raw("ROLLBACK"));
		throw error;
	}
}

function stageLegacySourceTables(database: SqliteInternalConnection): void {
	const sourceTables = database.drizzle.all<{ name: string }>(sql`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
		ORDER BY name
	`);
	const sourceNames = new Set(sourceTables.map(({ name }) => name));
	const indexes = database.drizzle.all<{ name: string; tbl_name: string }>(sql`
		SELECT name, tbl_name FROM sqlite_master
		WHERE type = 'index' AND sql IS NOT NULL ORDER BY name
	`);
	for (const index of indexes) {
		if (sourceNames.has(index.tbl_name)) {
			database.drizzle.run(sql`DROP INDEX ${sql.identifier(index.name)}`);
		}
	}
	for (const { name } of sourceTables) {
		database.drizzle.run(sql`ALTER TABLE ${sql.identifier(name)} RENAME TO ${sql.identifier(`legacy_v7_${name}`)}`);
	}
}

export function insertLegacySqliteV7Rows(database: SqliteInternalConnection, rows: LegacySqliteV7Rows): void {
	for (const [table, tableRows] of Object.entries(rows)) {
		if (tableRows.length === 0) continue;
		const columns = Object.keys(tableRows[0]!);
		const columnList = sql.join(columns.map((column) => sql.identifier(column)), sql`, `);
		for (const row of tableRows) {
			const values = sql.join(columns.map((column) => sql`${row[column]}`), sql`, `);
			database.drizzle.run(sql`INSERT INTO ${sql.identifier(table)} (${columnList}) VALUES (${values})`);
		}
	}
}

export function validateAndContractLegacySqliteV7(
	database: SqliteInternalConnection,
	rows: LegacySqliteV7Rows,
	revisionValidation: LegacySqliteV7RevisionValidation[]
): void {
	for (const [table, tableRows] of Object.entries(rows)) {
		const columns = Object.keys(tableRows[0] ?? {});
		const actualRows = database.drizzle.all(sql`SELECT * FROM ${sql.identifier(table)} ORDER BY rowid`).map((row) =>
			Object.fromEntries(columns.map((column) => [column, (row as Record<string, unknown>)[column]]))
		);
		if (!isDeepStrictEqual(actualRows, tableRows)) {
			throw new Error(`Legacy v7 direct migration validation failed for ${table}: final rows differ from the semantic transformation.`);
		}
	}
	validateRevisionPatches(rows, revisionValidation);
	const legacyTables = database.drizzle.all<{ name: string }>(sql`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name LIKE 'legacy_v7_%' ORDER BY name
	`);
	for (const { name } of legacyTables) database.drizzle.run(sql`DROP TABLE ${sql.identifier(name)}`);
}

function validateRevisionPatches(rows: LegacySqliteV7Rows, revisionValidation: LegacySqliteV7RevisionValidation[]): void {
	const registries: Record<LegacySqliteV7RevisionValidation["recordKind"], ReversePatchRegistry> = {
		context: CONTEXT_REVERSE_PATCH_REGISTRY,
		"context-term": CONTEXT_TERM_REVERSE_PATCH_REGISTRY,
		entity: ENTITY_REVERSE_PATCH_REGISTRY
	};
	const states = new Map(revisionValidation.map(({ projectId, recordKind, recordKey, state, tenantId }) => [
		`${tenantId}\0${projectId}\0${recordKind}\0${recordKey}`,
		{ registry: registries[recordKind], state }
	]));
	for (const entry of rows.revision_entries) {
		const chain = states.get(`${entry.tenant_id}\0${entry.project_id}\0${entry.record_kind}\0${entry.record_key}`);
		if (!chain) throw new Error(`Legacy v7 direct migration has no materialized head for revision chain ${entry.record_kind}:${entry.record_key}.`);
		applyReverseFieldPatch(chain.state, {
			patchFormat: Number(entry.patch_format),
			reversePatch: entry.reverse_patch as Uint8Array,
			sourceHash: Buffer.from(entry.source_hash as Uint8Array).toString("hex"),
			targetHash: Buffer.from(entry.target_hash as Uint8Array).toString("hex")
		}, chain.registry);
	}
}
