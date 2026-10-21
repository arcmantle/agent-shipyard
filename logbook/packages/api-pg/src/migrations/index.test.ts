import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPool, installInstructionBundle, migratePgDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migration-runner.js";
import { PgStore } from "../pg-store.js";
import { deriveMigratedContextIdentity, deriveMigratedContextTermId, deriveMigratedEntityIdentity, MIGRATION_BENCHMARK } from "@agent-issues/core";
import { migrations as productionMigrations } from "./index.js";
import { createLegacyV7Schema } from "./legacy-v7-fixture.test-support.js";

const ADMIN_CONNECTION_STRING =
	process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";

describe("api migrations chain", () => {
	let adminPool: Pool;

	beforeAll(() => {
		adminPool = createPgPool({ connectionString: ADMIN_CONNECTION_STRING });
	});

	afterAll(async () => {
		await adminPool.end();
	});

	it("rejects an unsupported mixed schema before creating the migration ledger or changing schema", async () => {
		const schemaName = `mixed_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query("CREATE TABLE entities (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, metadata JSONB)");
			const before = await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			);

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/unsupported source profile/i);

			const after = await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			);
			expect(after.rows).toEqual(before.rows);
			expect(after.rows).not.toContainEqual({ table_name: "schema_migrations" });
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects a present-but-empty migration ledger without mutation", async () => {
		const schemaName = `empty_ledger_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query(`CREATE TABLE schema_migrations (
				id TEXT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
			const catalogBefore = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

			const catalogAfter = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			expect(catalogAfter.rows).toEqual(catalogBefore.rows);
			expect((await schemaPool.query("SELECT id, applied_at FROM schema_migrations")).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("reports a malformed migration ledger shape without mutation", async () => {
		const schemaName = `malformed_ledger_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query("CREATE TABLE schema_migrations (migration_id TEXT, applied_at TIMESTAMPTZ)");
			const catalogBefore = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/unsupported source profile.*ledger shape.*evidence:.*recovery:/i);

			const catalogAfter = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			expect(catalogAfter.rows).toEqual(catalogBefore.rows);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it.each([
		["view", "CREATE VIEW unrelated_object AS SELECT 1 AS value"],
		["sequence", "CREATE SEQUENCE unrelated_object"]
	])("rejects an otherwise empty schema containing an unrelated %s without mutation", async (objectKind, createObject) => {
		const schemaName = `nonempty_object_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query(createObject);
			const catalogSql = `SELECT relation.relkind, relation.relname, pg_get_viewdef(relation.oid, true) AS view_definition
				FROM pg_class AS relation
				WHERE relation.relnamespace = $1::regnamespace ORDER BY relation.relkind, relation.relname`;
			const catalogBefore = (await schemaPool.query(catalogSql, [schemaName])).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				new RegExp(`unsupported source profile.*evidence:.*${objectKind} unrelated_object.*recovery:`, "i")
			);

			expect((await schemaPool.query(catalogSql, [schemaName])).rows).toEqual(catalogBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects an otherwise empty schema containing an unrelated collation without mutation", async () => {
		const schemaName = `nonempty_collation_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query('CREATE COLLATION unrelated_object FROM "C"');
			const catalogSql = `SELECT collation_row.collname, collation_row.collprovider, collation_row.collisdeterministic,
				collation_row.collcollate, collation_row.collctype
				FROM pg_collation AS collation_row
				WHERE collation_row.collnamespace = $1::regnamespace ORDER BY collation_row.collname`;
			const catalogBefore = (await schemaPool.query(catalogSql, [schemaName])).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/unsupported source profile.*evidence:.*collation unrelated_object.*recovery:/i
			);

			expect((await schemaPool.query(catalogSql, [schemaName])).rows).toEqual(catalogBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects an otherwise empty schema containing an unrelated text-search configuration without mutation", async () => {
		const schemaName = `nonempty_text_search_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query("CREATE TEXT SEARCH CONFIGURATION unrelated_object (COPY = pg_catalog.english)");
			const catalogSql = `SELECT configuration.cfgname, configuration.cfgparser
				FROM pg_ts_config AS configuration
				WHERE configuration.cfgnamespace = $1::regnamespace ORDER BY configuration.cfgname`;
			const catalogBefore = (await schemaPool.query(catalogSql, [schemaName])).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/unsupported source profile.*evidence:.*text search configuration unrelated_object.*recovery:/i
			);

			expect((await schemaPool.query(catalogSql, [schemaName])).rows).toEqual(catalogBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects an otherwise empty schema containing an extension without mutation", async () => {
		const schemaName = `nonempty_extension_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query(`CREATE EXTENSION hstore WITH SCHEMA ${schemaName}`);
			const extensionSql = `SELECT extension.extname, namespace.nspname, extension.extversion
				FROM pg_extension AS extension
				JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
				WHERE namespace.nspname = $1 ORDER BY extension.extname`;
			const extensionBefore = (await schemaPool.query(extensionSql, [schemaName])).rows;
			const relationsBefore = (await schemaPool.query(
				`SELECT relation.relkind, relation.relname FROM pg_class AS relation
				 WHERE relation.relnamespace = $1::regnamespace ORDER BY relation.relkind, relation.relname`,
				[schemaName]
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/unsupported source profile.*evidence:.*extension hstore.*recovery:/i
			);

			expect((await schemaPool.query(extensionSql, [schemaName])).rows).toEqual(extensionBefore);
			expect((await schemaPool.query(
				`SELECT relation.relkind, relation.relname FROM pg_class AS relation
				 WHERE relation.relnamespace = $1::regnamespace ORDER BY relation.relkind, relation.relname`,
				[schemaName]
			)).rows).toEqual(relationsBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects a view named schema_migrations without mutation", async () => {
		const schemaName = `ledger_view_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await schemaPool.query("CREATE VIEW schema_migrations AS SELECT 'not-a-ledger'::text AS id");
			const catalogSql = `SELECT relation.relkind, relation.relname, pg_get_viewdef(relation.oid, true) AS view_definition
				FROM pg_class AS relation
				WHERE relation.relnamespace = $1::regnamespace ORDER BY relation.relkind, relation.relname`;
			const catalogBefore = (await schemaPool.query(catalogSql, [schemaName])).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/unsupported source profile.*evidence:.*view schema_migrations.*recovery:/i
			);

			expect((await schemaPool.query(catalogSql, [schemaName])).rows).toEqual(catalogBefore);
			expect((await schemaPool.query("SELECT id FROM schema_migrations")).rows).toEqual([{ id: "not-a-ledger" }]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("creates an empty schema with final tables and the complete migration ledger", async () => {
		const schemaName = `final_baseline_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await migratePgDatabase(schemaPool);
			const tables = await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			);
			expect(tables.rows).toEqual([
				{ table_name: "completion_observations" },
				{ table_name: "context_terms" },
				{ table_name: "contexts" },
				{ table_name: "counters" },
				{ table_name: "entities" },
				{ table_name: "instruction_bundles" },
				{ table_name: "instruction_defaults" },
				{ table_name: "instruction_history" },
				{ table_name: "instruction_overrides" },
				{ table_name: "instruction_personal_fragments" },
				{ table_name: "issue_breakdown_drafts" },
				{ table_name: "issue_comment_references" },
				{ table_name: "issue_comments" },
				{ table_name: "plan_entries" },
				{ table_name: "plan_entry_references" },
				{ table_name: "plan_entry_supersessions" },
				{ table_name: "project_settings" },
				{ table_name: "relations" },
				{ table_name: "revision_entries" },
				{ table_name: "schema_migrations" },
				{ table_name: "users" }
			]);
			expect((await schemaPool.query("SELECT id FROM schema_migrations ORDER BY applied_at, id")).rows).toEqual([
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
				{ id: "pioneer-entity-types" },
				{ id: "issue-breakdown-drafts" },
				{ id: "project-settings" },
				{ id: "completion-observations" },
				{ id: "completion-observation-version-state" },
				{ id: "search" },
				{ id: "instruction-defaults" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-history" },
				{ id: "instruction-resets" }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("upgrades the previous approved schema with the user-directory migration", async () => {
		const schemaName = `user_directory_upgrade_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, productionMigrations.slice(0, 2));
			await migratePgDatabase(schemaPool);

			expect((await schemaPool.query("SELECT id FROM schema_migrations ORDER BY applied_at, id")).rows).toEqual([
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
				{ id: "pioneer-entity-types" },
				{ id: "issue-breakdown-drafts" },
				{ id: "project-settings" },
				{ id: "completion-observations" },
				{ id: "completion-observation-version-state" },
				{ id: "search" },
				{ id: "instruction-defaults" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-history" },
				{ id: "instruction-resets" }
			]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("upgrades instruction history and reset support without losing existing overrides", async () => {
		const schemaName = `latest_data_migration_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await runMigrations(schemaPool, productionMigrations.slice(0, productionMigrations.findIndex((migration) => migration.id === "instruction-history")));
			await installInstructionBundle(schemaPool, { version: "history-upgrade", items: [{ key: "skill/history", kind: "skill", body: "Default" }] });
			await schemaPool.query(`INSERT INTO instruction_overrides (tenant_id, user_id, item_key, kind, body, revision, content_hash, default_version)
				VALUES ('history-owner', 'alice', 'skill/history', 'skill', 'Existing source', 4, 'existing-hash', 'history-upgrade')`);
			await migratePgDatabase(schemaPool);

			expect((await schemaPool.query("SELECT id FROM schema_migrations ORDER BY applied_at, id")).rows.at(-1)).toEqual({ id: "instruction-resets" });
			const store = new PgStore(schemaPool, "history-owner", undefined, { tenantId: "history-owner", userId: "alice" });
			expect(await store.readInstructionRevision({ version: "history-upgrade", key: "skill/history", revision: 4 })).toMatchObject({
				body: "Existing source", source: { type: "override", revision: 4, contentHash: "existing-hash", defaultVersion: "history-upgrade" }
			});
			expect(await store.resetInstructionSource({ version: "history-upgrade", key: "skill/history", expectedRevision: 4 })).toMatchObject({ body: "Default", source: { type: "default", revision: 5 } });
			await migratePgDatabase(schemaPool);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("transforms the approved Postgres legacy v7 profile directly and preserves entity history", async () => {
		const schemaName = `legacy_v7_direct_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Schema(schemaPool);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES
				('tenant-a', 'PROJ1', 'project', 'Agent Issues', 'active', '', 'authored', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
				('tenant-a', 'INIT1', 'initiative', 'Migration initiative', 'active', '', 'authored', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
				('tenant-a', 'ISS1', 'issue', 'Current title', 'in-progress', 'current body', 'authored', '2024-01-02T00:00:00.000Z', '2024-01-04T00:00:00.000Z')`);
			await schemaPool.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
				VALUES
				('tenant-a', 'PROJ1', 'INIT1', 'contains', '2024-01-01T00:00:00.000Z'),
				('tenant-a', 'INIT1', 'ISS1', 'tracks', '2024-01-02T00:00:00.000Z')`);
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				VALUES
				('history-v1', 'tenant-a', 'ISS1', 1, 'creator', 'First title', 'first body', 'authored', 'todo', 'INIT1', '2024-01-02T00:00:00.000Z'),
				('history-v2', 'tenant-a', 'ISS1', 2, 'editor', 'Second title', 'second body', 'authored', 'in-progress', 'INIT1', '2024-01-03T00:00:00.000Z')`);
			await schemaPool.query(`INSERT INTO contexts
				(tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				VALUES ('tenant-a', 'INIT1', 'INIT1', 'Initiative context', 'Current context summary.',
					'2024-01-02T00:00:00.000Z', '2024-01-05T00:00:00.000Z')`);
			await schemaPool.query(`INSERT INTO context_terms
				(tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at)
				VALUES ('tenant-a', 'INIT1', 'Checkpoint', 'A direct migration marker.', '["historical migration"]',
					'2024-01-02T00:00:00.000Z', '2024-01-06T00:00:00.000Z')`);

			await migratePgDatabase(schemaPool);

			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows).toEqual([
				{ table_name: "completion_observations" },
				{ table_name: "context_terms" },
				{ table_name: "contexts" },
				{ table_name: "counters" },
				{ table_name: "entities" },
				{ table_name: "instruction_bundles" },
				{ table_name: "instruction_defaults" },
				{ table_name: "instruction_history" },
				{ table_name: "instruction_overrides" },
				{ table_name: "instruction_personal_fragments" },
				{ table_name: "issue_breakdown_drafts" },
				{ table_name: "issue_comment_references" },
				{ table_name: "issue_comments" },
				{ table_name: "plan_entries" },
				{ table_name: "plan_entry_references" },
				{ table_name: "plan_entry_supersessions" },
				{ table_name: "project_settings" },
				{ table_name: "relations" },
				{ table_name: "revision_entries" },
				{ table_name: "schema_migrations" },
				{ table_name: "users" }
			]);
			expect((await schemaPool.query("SELECT id FROM schema_migrations ORDER BY id")).rows).toEqual([
				{ id: "adr-status-to-current" },
				{ id: "completion-observation-version-state" },
				{ id: "completion-observations" },
				{ id: "context-term-provenance" },
				{ id: "debt-metadata" },
				{ id: "entity-type" },
				{ id: "final-baseline" },
				{ id: "instruction-defaults" },
				{ id: "instruction-history" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-resets" },
				{ id: "issue-breakdown-drafts" },
				{ id: "issue-comments" },
				{ id: "legacy-v7-direct" },
				{ id: "pioneer-entity-types" },
				{ id: "plan-entries" },
				{ id: "plan-entry-supersession-position" },
				{ id: "project-settings" },
				{ id: "record-provenance" },
				{ id: "relation-provenance" },
				{ id: "search" },
				{ id: "short-entity-reference" },
				{ id: "short-record-reference" },
				{ id: "user-directory" }
			]);
			const issueIdentity = deriveMigratedEntityIdentity("issue", "ISS1");
			const issueId = issueIdentity.stableId;
			const projectId = deriveMigratedEntityIdentity("project", "PROJ1").stableId;
			const initiativeIdentity = deriveMigratedEntityIdentity("initiative", "INIT1");
			expect((await schemaPool.query("SELECT from_id::text, to_id::text, type FROM relations ORDER BY created_at")).rows).toEqual([
				{ from_id: projectId, to_id: initiativeIdentity.stableId, type: "contains" },
				{ from_id: initiativeIdentity.stableId, to_id: issueId, type: "tracks" }
			]);
			const store = new PgStore(schemaPool, "tenant-a", "Agent Issues");
			const plan = await store.createEntity({ kind: "plan", title: "Migrated Plan", parentId: initiativeIdentity.stableId });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "question", body: "Can this Plan synchronize?" });
			expect((await store.exportCanonicalChains()).planEntries).toContainEqual(expect.objectContaining({
				head: expect.objectContaining({ id: entry.id, planId: plan.id })
			}));
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 1 })).resolves.toMatchObject({
				author: "creator",
				body: "first body",
				headRevision: 3,
				title: "First title"
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 2 })).resolves.toMatchObject({
				author: "editor",
				body: "second body",
				title: "Second title"
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 3 })).resolves.toMatchObject({
				body: "current body",
				title: "Current title"
			});
			await expect(store.materializeEntityRevision({ entityId: projectId, revision: 1 })).resolves.toMatchObject({
				author: "system",
				headRevision: 1,
				title: "Agent Issues"
			});
			await expect(store.materializeContextRevision({ scopeRef: initiativeIdentity.reference, revision: 1 })).resolves.toMatchObject({
				author: "system",
				summary: "Current context summary.",
				title: "Initiative context"
			});
			await expect(store.materializeContextTermRevision({ scopeRef: initiativeIdentity.reference, term: "Checkpoint", revision: 1 })).resolves.toMatchObject({
				author: "system",
				avoid: ["historical migration"],
				definition: "A direct migration marker."
			});
			const migratedHead = await store.getEntityDetails(issueId);
			const updated = await store.updateEntity({
				author: "post-migration-writer",
				body: "updated after migration",
				entityId: issueId,
				expectedContentHash: migratedHead.entity.contentHash,
				expectedRevision: migratedHead.entity.revision
			});
			expect(updated).toMatchObject({ body: "updated after migration", revision: 4 });
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 3 })).resolves.toMatchObject({
				body: "current body",
				headRevision: 4
			});
			const ledgerBefore = (await schemaPool.query("SELECT id, applied_at FROM schema_migrations")).rows;
			await migratePgDatabase(schemaPool);
			expect((await schemaPool.query("SELECT id, applied_at FROM schema_migrations")).rows).toEqual(ledgerBefore);
			expect((await schemaPool.query(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
				 WHERE relnamespace = $1::regnamespace AND relname = ANY($2) ORDER BY relname`,
				[schemaName, ["context_terms", "contexts", "counters", "entities", "issue_comment_references", "issue_comments", "relations", "revision_entries"]]
			)).rows).toEqual([
				"context_terms", "contexts", "counters", "entities", "issue_comment_references", "issue_comments", "relations", "revision_entries"
			].map((relname) => ({ relforcerowsecurity: true, relname, relrowsecurity: true })));
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("recovers a history-only entity graph as tombstoned final heads", async () => {
		const schemaName = `legacy_v7_deleted_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO counters (tenant_id, kind, next_value) VALUES
				('tenant-1', 'initiative', 2),
				('tenant-1', 'issue', 2)`);
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at) VALUES
				('initiative-history-1', 'tenant-1', 'INIT1', 1, 'planner', 'Initiative first', 'initiative first body', 'authored', 'active', 'PROJ1', '2024-01-01'),
				('initiative-history-2', 'tenant-1', 'INIT1', 2, 'lead', 'Initiative second', 'initiative second body', 'authored', 'active', 'PROJ1', '2024-01-02')`);
			await schemaPool.query("DELETE FROM entities WHERE tenant_id = 'tenant-1' AND id IN ('INIT1', 'ISS1')");

			await migratePgDatabase(schemaPool);

			const issueId = deriveMigratedEntityIdentity("issue", "ISS1").stableId;
			const initiativeId = deriveMigratedEntityIdentity("initiative", "INIT1").stableId;
			const projectId = deriveMigratedEntityIdentity("project", "PROJ1").stableId;
			expect((await schemaPool.query(
				`SELECT id::text, project_id::text, kind, title, body, status, revision, tombstone, created_at, updated_at
				 FROM entities WHERE tenant_id = 'tenant-1' AND id = ANY($1) ORDER BY kind`,
				[[initiativeId, issueId]]
			)).rows).toEqual([
				{
					body: "initiative second body",
					created_at: "2024-01-01",
					id: initiativeId,
					kind: "initiative",
					project_id: projectId,
					revision: 3,
					status: "active",
					title: "Initiative second",
					tombstone: true,
					updated_at: "2024-01-02"
				},
				{
					body: "second",
					created_at: "2024-01-02",
					id: issueId,
					kind: "issue",
					project_id: projectId,
					revision: 3,
					status: "in-progress",
					title: "Second",
					tombstone: true,
					updated_at: "2024-01-03"
				}
			]);
			const store = new PgStore(schemaPool, "tenant-1");
			await expect(store.materializeEntityRevision({ entityId: initiativeId, revision: 1 })).resolves.toMatchObject({
				author: "planner",
				body: "initiative first body",
				createdAt: "2024-01-01",
				parentId: projectId,
				title: "Initiative first",
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: initiativeId, revision: 2 })).resolves.toMatchObject({
				author: "lead",
				body: "initiative second body",
				createdAt: "2024-01-02",
				parentId: projectId,
				title: "Initiative second",
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: initiativeId, revision: 3 })).resolves.toMatchObject({
				author: "lead",
				createdAt: "2024-01-02",
				parentId: null,
				tombstone: true
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 1 })).resolves.toMatchObject({
				author: "creator",
				createdAt: "2024-01-02",
				parentId: initiativeId,
				title: "First",
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 2 })).resolves.toMatchObject({
				author: "editor",
				createdAt: "2024-01-03",
				parentId: initiativeId,
				title: "Second",
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 3 })).resolves.toMatchObject({
				author: "editor",
				createdAt: "2024-01-03",
				parentId: null,
				title: "Second",
				tombstone: true
			});
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("resolves a live child through a history-only parent across multiple projects", async () => {
		const schemaName = `legacy_v7_mixed_graph_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES ('tenant-1', 'PROJ2', 'project', 'Second project', 'active', '', 'authored', '2024-01-01', '2024-01-01')`);
			await schemaPool.query("INSERT INTO counters (tenant_id, kind, next_value) VALUES ('tenant-1', 'initiative', 2)");
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				VALUES ('initiative-history-1', 'tenant-1', 'INIT1', 1, 'planner', 'Initiative', 'initiative body', 'authored', 'active', 'PROJ1', '2024-01-01')`);
			await schemaPool.query("DELETE FROM entities WHERE tenant_id = 'tenant-1' AND id = 'INIT1'");

			await migratePgDatabase(schemaPool);

			const initiativeId = deriveMigratedEntityIdentity("initiative", "INIT1").stableId;
			const issueId = deriveMigratedEntityIdentity("issue", "ISS1").stableId;
			const projectId = deriveMigratedEntityIdentity("project", "PROJ1").stableId;
			expect((await schemaPool.query(
				`SELECT id::text, project_id::text, tombstone FROM entities
				 WHERE tenant_id = 'tenant-1' AND id = ANY($1) ORDER BY id`,
				[[initiativeId, issueId]]
			)).rows).toEqual([
				{ id: initiativeId, project_id: projectId, tombstone: true },
				{ id: issueId, project_id: projectId, tombstone: false }
			].sort((left, right) => left.id.localeCompare(right.id)));
			const store = new PgStore(schemaPool, "tenant-1");
			await expect(store.materializeEntityRevision({ entityId: initiativeId, revision: 1 })).resolves.toMatchObject({
				author: "planner",
				parentId: projectId,
				tombstone: false
			});
			await expect(store.materializeEntityRevision({ entityId: initiativeId, revision: 2 })).resolves.toMatchObject({
				parentId: null,
				tombstone: true
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 1 })).resolves.toMatchObject({
				parentId: initiativeId
			});
			expect((await schemaPool.query(
				`SELECT DISTINCT project_id::text FROM revision_entries
				 WHERE tenant_id = 'tenant-1' AND record_kind = 'entity' AND record_key = $1`,
				[`36:${issueId}`]
			)).rows).toEqual([{ project_id: projectId }]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects a structural ancestry cycle across live and history-only entities before writes", async () => {
		const schemaName = `legacy_v7_mixed_cycle_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query("INSERT INTO counters (tenant_id, kind, next_value) VALUES ('tenant-1', 'initiative', 2)");
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				VALUES ('initiative-cycle', 'tenant-1', 'INIT1', 1, 'planner', 'Initiative', '', 'authored', 'active', 'ISS1', '2024-01-01')`);
			await schemaPool.query("DELETE FROM entities WHERE tenant_id = 'tenant-1' AND id = 'INIT1'");
			const entitiesBefore = (await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows;
			const historyBefore = (await schemaPool.query(
				"SELECT id, entity_id, version, parent_id FROM history_entries ORDER BY entity_id, version"
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/history-only structural ancestry cycle.*ISS1.*INIT1.*ISS1/i
			);

			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore);
			expect((await schemaPool.query(
				"SELECT id, entity_id, version, parent_id FROM history_entries ORDER BY entity_id, version"
			)).rows).toEqual(historyBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects a cycle among history-only entities before writes", async () => {
		const schemaName = `legacy_v7_deleted_cycle_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO counters (tenant_id, kind, next_value) VALUES
				('tenant-1', 'initiative', 2),
				('tenant-1', 'issue', 2)`);
			await schemaPool.query(`INSERT INTO history_entries
				(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at)
				VALUES ('initiative-cycle', 'tenant-1', 'INIT1', 1, 'planner', 'Initiative', '', 'authored', 'active', 'ISS1', '2024-01-01')`);
			await schemaPool.query("DELETE FROM entities WHERE tenant_id = 'tenant-1' AND id IN ('INIT1', 'ISS1')");
			const historyBefore = (await schemaPool.query(
				"SELECT id, entity_id, version, parent_id FROM history_entries ORDER BY entity_id, version"
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/history-only structural ancestry cycle.*INIT1.*ISS1.*INIT1/i
			);

			expect((await schemaPool.query(
				"SELECT id, entity_id, version, parent_id FROM history_entries ORDER BY entity_id, version"
			)).rows).toEqual(historyBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects an unresolved context project mapping without dropping source tables or recording a checkpoint", async () => {
		const schemaName = `legacy_v7_context_scope_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES ('tenant-1', 'PROJ2', 'project', 'Second project', 'active', '', 'authored', '2024-01-01', '2024-01-01')`);
			await schemaPool.query(`INSERT INTO contexts
				(tenant_id, key, scope_entity_id, title, summary, created_at, updated_at)
				VALUES ('tenant-1', 'missing-context', NULL, 'Missing', 'Unresolved scope', '2024-01-02', '2024-01-03')`);
			const tablesBefore = (await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/context.*missing-context.*project scope/i);

			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows).toEqual(tablesBefore);
			expect((await schemaPool.query("SELECT key, scope_entity_id FROM contexts")).rows).toContainEqual({
				key: "missing-context",
				scope_entity_id: null
			});
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects cyclic structural ancestry before writes and leaves no ledger", async () => {
		const schemaName = `legacy_v7_cycle_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query("DELETE FROM relations WHERE tenant_id = 'tenant-1' AND from_id = 'PROJ1' AND to_id = 'INIT1'");
			await schemaPool.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
				VALUES ('tenant-1', 'ISS1', 'INIT1', 'decomposes', '2024-01-03')`);
			const relationsBefore = (await schemaPool.query(
				"SELECT tenant_id, from_id, to_id, type, created_at FROM relations ORDER BY from_id, to_id, type"
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/structural ancestry cycle.*INIT1.*ISS1.*INIT1/i);

			expect((await schemaPool.query(
				"SELECT tenant_id, from_id, to_id, type, created_at FROM relations ORDER BY from_id, to_id, type"
			)).rows).toEqual(relationsBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects multiple project ancestors deterministically before writes", async () => {
		const schemaName = `legacy_v7_multi_project_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES ('tenant-1', 'PROJ2', 'project', 'Second project', 'active', '', 'authored', '2024-01-01', '2024-01-01')`);
			await schemaPool.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at)
				VALUES ('tenant-1', 'PROJ2', 'INIT1', 'contains', '2024-01-03')`);
			const entitiesBefore = (await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/entity INIT1 has ambiguous structural parents: PROJ1, PROJ2/i
			);

			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects multiple same-project structural parents before writes", async () => {
		const schemaName = `legacy_v7_ambiguous_parent_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES ('tenant-1', 'EPIC1', 'epic', 'Epic', 'active', '', 'authored', '2024-01-01', '2024-01-01')`);
			await schemaPool.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES
				('tenant-1', 'PROJ1', 'EPIC1', 'contains', '2024-01-01'),
				('tenant-1', 'EPIC1', 'ISS1', 'tracks', '2024-01-03')`);
			const tablesBefore = (await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows;
			const entitiesBefore = (await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows;
			const relationsBefore = (await schemaPool.query(
				"SELECT * FROM relations ORDER BY tenant_id, from_id, to_id, type"
			)).rows;
			const historyBefore = (await schemaPool.query(
				"SELECT * FROM history_entries ORDER BY tenant_id, entity_id, version, id"
			)).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(
				/entity ISS1 has ambiguous structural parents: EPIC1, INIT1/i
			);

			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows).toEqual(tablesBefore);
			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore);
			expect((await schemaPool.query(
				"SELECT * FROM relations ORDER BY tenant_id, from_id, to_id, type"
			)).rows).toEqual(relationsBefore);
			expect((await schemaPool.query(
				"SELECT * FROM history_entries ORDER BY tenant_id, entity_id, version, id"
			)).rows).toEqual(historyBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("assigns a parentless entity and all its revisions to the sole project", async () => {
		const schemaName = `legacy_v7_parentless_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query("DELETE FROM relations WHERE tenant_id = 'tenant-1' AND to_id = 'ISS1'");

			await migratePgDatabase(schemaPool);

			const issueId = deriveMigratedEntityIdentity("issue", "ISS1").stableId;
			const projectId = deriveMigratedEntityIdentity("project", "PROJ1").stableId;
			expect((await schemaPool.query(
				"SELECT project_id::text FROM entities WHERE tenant_id = 'tenant-1' AND id = $1",
				[issueId]
			)).rows).toEqual([{ project_id: projectId }]);
			expect((await schemaPool.query(
				`SELECT DISTINCT project_id::text FROM revision_entries
				 WHERE tenant_id = 'tenant-1' AND record_kind = 'entity' AND record_key = $1`,
				[`36:${issueId}`]
			)).rows).toEqual([{ project_id: projectId }]);
			const store = new PgStore(schemaPool, "tenant-1");
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 1 })).resolves.toMatchObject({
				parentId: deriveMigratedEntityIdentity("initiative", "INIT1").stableId
			});
			await expect(store.materializeEntityRevision({ entityId: issueId, revision: 3 })).resolves.toMatchObject({ parentId: null });
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("preserves default and Unicode context records across multiple projects", async () => {
		const schemaName = `legacy_v7_unicode_context_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1);
			await schemaPool.query(`INSERT INTO entities
				(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
				VALUES ('tenant-1', 'PROJ2', 'project', 'Second project', 'active', '', 'authored', '2024-01-01', '2024-01-01')`);
			await schemaPool.query(`INSERT INTO contexts
				(tenant_id, key, scope_entity_id, title, summary, created_at, updated_at) VALUES
				('tenant-1', 'default:PROJ1', NULL, 'Default', 'Project default', '2024-01-02', '2024-01-05'),
				('tenant-1', '設計:INIT1', 'INIT1', '設計', 'Unicode context', '2024-01-03', '2024-01-06')`);
			await schemaPool.query(`INSERT INTO context_terms
				(tenant_id, context_key, term, definition, avoid_terms, created_at, updated_at) VALUES
				('tenant-1', 'default:PROJ1', 'Order', 'Default term', '[]', '2024-01-03', '2024-01-07'),
				('tenant-1', '設計:INIT1', '状態🔒', 'Unicode term', '["旧語"]', '2024-01-04', '2024-01-08')`);

			await migratePgDatabase(schemaPool);

			const projectId = deriveMigratedEntityIdentity("project", "PROJ1").stableId;
			const unicodeContextId = deriveMigratedContextIdentity("設計:INIT1").stableId;
			const unicodeTermId = deriveMigratedContextTermId("設計:INIT1", "状態🔒");
			expect((await schemaPool.query(
				`SELECT record_kind, record_key, project_id::text FROM revision_entries
				 WHERE id = ANY($1) ORDER BY record_kind`,
				[[`legacy-context:${unicodeContextId}`, `legacy-term:${unicodeTermId}`]]
			)).rows).toEqual([
				{ project_id: projectId, record_key: `${Buffer.byteLength(unicodeContextId, "utf8")}:${unicodeContextId}`, record_kind: "context" },
				{ project_id: projectId, record_key: `${Buffer.byteLength(unicodeTermId, "utf8")}:${unicodeTermId}`, record_kind: "context-term" }
			]);
			const store = new PgStore(schemaPool, "tenant-1");
			await expect(store.materializeContextRevision({ scopeRef: deriveMigratedEntityIdentity("initiative", "INIT1").reference, revision: 1 }))
				.resolves.toMatchObject({ summary: "Unicode context", title: "設計" });
			await expect(store.materializeContextTermRevision({
				scopeRef: deriveMigratedEntityIdentity("initiative", "INIT1").reference,
				term: "状態🔒",
				revision: 1
			})).resolves.toMatchObject({ avoid: ["旧語"], definition: "Unicode term" });
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rolls back the full direct route when a reconstructed revision ID collides", async () => {
		const schemaName = `legacy_v7_rollback_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(schemaPool, 1, true);
			const tablesBefore = (await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows;
			const entitiesBefore = (await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows;

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/duplicate key|unique constraint/i);

			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
				[schemaName]
			)).rows).toEqual(tablesBefore);
			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore);
			expect((await schemaPool.query(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'schema_migrations'",
				[schemaName]
			)).rows).toEqual([]);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("uses a bounded direct-route statement count when legacy rows and revisions double", async () => {
		const statementCounts: number[] = [];
		for (const copies of MIGRATION_BENCHMARK.postgres.legacyV7.fixtureCopies) {
			const schemaName = `legacy_v7_bounded_${copies}_${randomUUID().replace(/-/g, "_")}`;
			await adminPool.query(`CREATE SCHEMA ${schemaName}`);
			const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
			try {
				await createLegacyV7Fixture(schemaPool, copies);
				const instrumented = instrumentPoolQueries(schemaPool);
				await migratePgDatabase(instrumented.pool);
				statementCounts.push(instrumented.statementCount());
			} finally {
				await schemaPool.end();
				await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
			}
		}

		expect(statementCounts).toEqual(MIGRATION_BENCHMARK.postgres.legacyV7.statementCounts);
		expect(statementCounts[1]).toBe(statementCounts[0]);
	});

	it("serializes concurrent legacy-v7 direct runners and records one checkpoint", async () => {
		const schemaName = `legacy_v7_concurrent_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const setupPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const firstPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const secondPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await createLegacyV7Fixture(setupPool, 1);
			await Promise.all([migratePgDatabase(firstPool), migratePgDatabase(secondPool)]);
			expect((await setupPool.query("SELECT id FROM schema_migrations ORDER BY id")).rows).toEqual(
			["legacy-v7-direct", ...productionMigrations.map(({ id }) => id)]
				.sort()
				.map((id) => ({ id }))
		);
			expect((await setupPool.query("SELECT count(*)::integer AS count FROM entities")).rows).toEqual([{ count: 3 }]);
		} finally {
			await Promise.all([setupPool.end(), firstPool.end(), secondPool.end()]);
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("migrates an empty schema and then accepts the generated current-final profile without mutation", async () => {
		const schemaName = `current_final_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await migratePgDatabase(schemaPool);
			const schemaBefore = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			const ledgerBefore = await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id");
			const entitiesBefore = await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id");

			await migratePgDatabase(schemaPool);

			const schemaAfter = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			const ledgerAfter = await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id");
			expect(schemaAfter.rows).toEqual(schemaBefore.rows);
			expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore.rows);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("serializes concurrent classification and routing with one database-schema advisory lock", async () => {
		const schemaName = `concurrent_route_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const setupPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const firstPool = new Pool({ application_name: `${schemaName}_first`, connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const secondPool = new Pool({ application_name: `${schemaName}_second`, connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
		const lockHolder = await adminPool.connect();
		let lockTransactionOpen = false;

		try {
			await migratePgDatabase(setupPool);
			const ledgerBefore = (await setupPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id")).rows;
			await lockHolder.query("BEGIN");
			lockTransactionOpen = true;
			await lockHolder.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))", [schemaName]);

			const firstMigration = migratePgDatabase(firstPool);
			const secondMigration = migratePgDatabase(secondPool);
			let waitingApplications: string[] = [];
			for (let attempt = 0; attempt < 100 && waitingApplications.length < 2; attempt++) {
				const waiting = await adminPool.query<{ application_name: string }>(
					`SELECT application_name FROM pg_stat_activity
					 WHERE application_name = ANY($1) AND wait_event_type = 'Lock' AND wait_event = 'advisory'
					 ORDER BY application_name`,
					[[`${schemaName}_first`, `${schemaName}_second`]]
				);
				waitingApplications = waiting.rows.map(({ application_name }) => application_name);
			}
			expect(waitingApplications).toEqual([`${schemaName}_first`, `${schemaName}_second`]);

			await lockHolder.query("COMMIT");
			lockTransactionOpen = false;
			await Promise.all([firstMigration, secondMigration]);
			expect((await setupPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id")).rows).toEqual(ledgerBefore);
		} finally {
			if (lockTransactionOpen) {
				await lockHolder.query("ROLLBACK");
			}
			lockHolder.release();
			await Promise.all([setupPool.end(), firstPool.end(), secondPool.end()]);
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it.each([
		["missing ID", async (pool: Pool) => pool.query("DELETE FROM schema_migrations WHERE id = 'final-baseline'")],
		["missing Plan-entry position ID", async (pool: Pool) => pool.query("DELETE FROM schema_migrations WHERE id = 'plan-entry-supersession-position'")],
		["unknown ID", async (pool: Pool) => pool.query("UPDATE schema_migrations SET id = '9999-unknown' WHERE id = 'final-baseline'")],
		["dialect-inappropriate ID", async (pool: Pool) => pool.query("UPDATE schema_migrations SET id = '0004-backfill-tenant-bootstrap' WHERE id = 'final-baseline'")],
		["nominal-final ledger with a non-final schema", async (pool: Pool) => pool.query("ALTER TABLE entities ADD COLUMN metadata JSONB")],
		["changed content under a recorded migration ID", async (pool: Pool) => pool.query("DROP INDEX entities_tenant_reference_idx")]
	])("rejects a Postgres %s before further mutation", async (_label, corruptProfile) => {
		const schemaName = `rejected_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await migratePgDatabase(schemaPool);
			await corruptProfile(schemaPool);
			const schemaBefore = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			const ledgerBefore = await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id");
			const entitiesBefore = await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id");

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

			const schemaAfter = await schemaPool.query(
				`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
				 FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
				[schemaName]
			);
			const ledgerAfter = await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id");
			expect(schemaAfter.rows).toEqual(schemaBefore.rows);
			expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);
			expect((await schemaPool.query("SELECT * FROM entities ORDER BY tenant_id, id")).rows).toEqual(entitiesBefore.rows);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("rejects duplicate migration IDs when a malformed Postgres ledger makes them representable", async () => {
		const schemaName = `duplicate_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await migratePgDatabase(schemaPool);
			await schemaPool.query("ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey");
			await schemaPool.query(`INSERT INTO schema_migrations (id, applied_at)
				SELECT id, applied_at + interval '1 second' FROM schema_migrations ORDER BY applied_at, id LIMIT 1`);
			const ledgerBefore = await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id");

			await expect(migratePgDatabase(schemaPool)).rejects.toThrow(/unsupported source profile.*evidence:.*recovery:/i);

			expect((await schemaPool.query("SELECT id, applied_at FROM schema_migrations ORDER BY applied_at, id")).rows).toEqual(ledgerBefore.rows);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

	it("produces the exact final schema, indexes, types, and forced RLS policies on a fresh install", async () => {
		const schemaName = `chain_${randomUUID().replace(/-/g, "_")}`;
		await adminPool.query(`CREATE SCHEMA ${schemaName}`);
		const schemaPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });

		try {
			await migratePgDatabase(schemaPool);

			const { rows: tableRows } = await schemaPool.query(
				`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
				[schemaName]
			);
			expect(tableRows.map((row) => row.table_name)).toEqual([
				"completion_observations",
				"context_terms",
				"contexts",
				"counters",
				"entities",
				"instruction_bundles",
				"instruction_defaults",
				"instruction_history",
				"instruction_overrides",
				"instruction_personal_fragments",
				"issue_breakdown_drafts",
				"issue_comment_references",
				"issue_comments",
				"plan_entries",
				"plan_entry_references",
				"plan_entry_supersessions",
				"project_settings",
				"relations",
				"revision_entries",
				"schema_migrations",
				"users"
			]);

			const { rows: indexRows } = await schemaPool.query(
				`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname NOT LIKE '%_pkey' AND indexname NOT LIKE '%_pk' ORDER BY indexname`,
				[schemaName]
			);
			expect(indexRows.map((row) => row.indexname)).toEqual([
				"completion_observations_tenant_id_id_key",
				"completion_observations_tenant_issue_idx",
				"context_terms_search_idx",
				"context_terms_tenant_context_key_idx",
				"context_terms_tenant_id_idx",
				"context_terms_tenant_short_reference_idx",
				"contexts_search_idx",
				"contexts_tenant_id_idx",
				"contexts_tenant_reference_idx",
				"contexts_tenant_scope_entity_id_idx",
				"contexts_tenant_short_reference_idx",
				"entities_search_idx",
				"entities_tenant_reference_idx",
				"entities_tenant_short_reference_idx",
				"issue_breakdown_drafts_active_target_idx",
				"issue_breakdown_drafts_target_idx",
				"issue_comment_references_tenant_issue_idx",
				"issue_comments_search_idx",
				"issue_comments_tenant_id_reference_key",
				"issue_comments_tenant_issue_idx",
				"issue_comments_tenant_short_reference_idx",
				"plan_entries_search_idx",
				"plan_entries_tenant_id_reference_key",
				"plan_entries_tenant_id_short_reference_key",
				"plan_entries_tenant_plan_idx",
				"relations_tenant_to_id_idx",
				"revision_entries_chain_idx",
				"revision_entries_project_idx",
				"users_tenant_authentication_subject_idx"
			]);

			const { rows: policyRows } = await schemaPool.query(
				`SELECT tablename, qual, with_check FROM pg_policies
				 WHERE schemaname = $1 AND policyname = 'tenant_isolation' ORDER BY tablename`,
				[schemaName]
			);
			expect(policyRows.map((row) => row.tablename)).toEqual(
				["completion_observations", "context_terms", "contexts", "counters", "entities", "issue_breakdown_drafts", "issue_comment_references", "issue_comments", "plan_entries", "plan_entry_references", "plan_entry_supersessions", "project_settings", "relations", "revision_entries", "users"].sort()
			);
			expect(policyRows.every((row) => row.qual === "(tenant_id = current_setting('app.tenant_id'::text, true))")).toBe(true);
			expect(policyRows.every((row) => row.with_check === "(tenant_id = current_setting('app.tenant_id'::text, true))")).toBe(true);
			const { rows: securityRows } = await schemaPool.query(
				`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
				 WHERE relnamespace = $1::regnamespace AND relname = ANY($2) ORDER BY relname`,
				[schemaName, ["completion_observations", "context_terms", "contexts", "counters", "entities", "issue_breakdown_drafts", "issue_comment_references", "issue_comments", "plan_entries", "plan_entry_references", "plan_entry_supersessions", "project_settings", "relations", "revision_entries", "users"]]
			);
			expect(securityRows).toEqual(securityRows.map((row) => ({ ...row, relforcerowsecurity: true, relrowsecurity: true })));

			const { rows: columnRows } = await schemaPool.query(
				`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'revision_entries'`,
				[schemaName]
			);
			const columns = columnRows.map((row) => row.column_name as string);
			expect(columns).toEqual(expect.arrayContaining(["project_id", "record_kind", "record_key", "patch_format", "reverse_patch", "source_hash", "target_hash"]));
			expect(columnRows.find((row) => row.column_name === "source_hash")?.data_type).toBe("bytea");
			expect(columnRows.find((row) => row.column_name === "target_hash")?.data_type).toBe("bytea");
			const { rows: constraintRows } = await schemaPool.query(
				`SELECT conname AS name, pg_get_constraintdef(oid) AS definition
				 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
				[`${schemaName}.revision_entries`]
			);
			expect(constraintRows).toEqual([
				{ definition: "CHECK ((patch_format > 0))", name: "revision_entries_patch_format_positive" },
				{ definition: "CHECK ((record_kind = ANY (ARRAY['entity'::text, 'context'::text, 'context-term'::text, 'issue-comment'::text, 'plan-entry'::text])))", name: "revision_entries_record_kind" },
				{ definition: "CHECK ((revision > 0))", name: "revision_entries_revision_positive" },
				{ definition: "CHECK ((octet_length(source_hash) = 32))", name: "revision_entries_source_hash_length" },
				{ definition: "CHECK ((octet_length(target_hash) = 32))", name: "revision_entries_target_hash_length" }
			]);
			await schemaPool.query("SET app.tenant_id = 'malformed-test'");
			const insertRevisionEntry = `INSERT INTO revision_entries
				(id, tenant_id, project_id, record_kind, record_key, revision, author, patch_format,
				 reverse_patch, source_hash, target_hash, created_at)
				VALUES ($1, 'malformed-test', '00000000-0000-0000-0000-000000000001', $2, 'record', $3, 'author', $4,
				 decode('', 'hex'), decode($5, 'hex'), decode($6, 'hex'), '2026-01-01T00:00:00.000Z')`;
			for (const [label, recordKind, revision, patchFormat, sourceHash, targetHash] of [
				["record kind", "unknown", 1, 1, "00".repeat(32), "00".repeat(32)],
				["revision", "entity", 0, 1, "00".repeat(32), "00".repeat(32)],
				["patch format", "entity", 1, 0, "00".repeat(32), "00".repeat(32)],
				["source hash", "entity", 1, 1, "00".repeat(31), "00".repeat(32)],
				["target hash", "entity", 1, 1, "00".repeat(32), "00".repeat(33)]
			] as const) {
				await expect(schemaPool.query(insertRevisionEntry, [label, recordKind, revision, patchFormat, sourceHash, targetHash]), label).rejects.toThrow();
			}

			const { rows: appliedRows } = await schemaPool.query(`SELECT id FROM schema_migrations ORDER BY applied_at`);
			expect(appliedRows).toEqual([
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
				{ id: "pioneer-entity-types" },
				{ id: "issue-breakdown-drafts" },
				{ id: "project-settings" },
				{ id: "completion-observations" },
				{ id: "completion-observation-version-state" },
				{ id: "search" },
				{ id: "instruction-defaults" },
				{ id: "instruction-overrides" },
				{ id: "instruction-personal-fragments" },
				{ id: "instruction-history" },
				{ id: "instruction-resets" }
			]);

			const { rows: identityColumns } = await schemaPool.query(
				`SELECT table_name, column_name, data_type FROM information_schema.columns
					WHERE table_schema = $1 AND table_name IN ('entities', 'relations', 'contexts', 'revision_entries')`,
				[schemaName]
			);
			const columnType = (tableName: string, columnName: string) => identityColumns.find((column) => column.table_name === tableName && column.column_name === columnName)?.data_type;
			expect(columnType("entities", "id")).toBe("uuid");
			expect(columnType("entities", "reference")).toBe("text");
			expect(columnType("entities", "short_reference")).toBe("text");
			expect(columnType("relations", "from_id")).toBe("uuid");
			expect(columnType("contexts", "id")).toBe("uuid");
			expect(columnType("contexts", "reference")).toBe("text");
			expect(columnType("revision_entries", "project_id")).toBe("uuid");
			expect(identityColumns.some((column) => column.column_name === "stable_id" || column.column_name === "entity_stable_id")).toBe(false);
		} finally {
			await schemaPool.end();
			await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
		}
	});

});

async function createLegacyV7Fixture(pool: Pool, copies: number, collideRevisionId: boolean = false): Promise<void> {
	await createLegacyV7Schema(pool);
	for (let copy = 1; copy <= copies; copy++) {
		const tenantId = `tenant-${copy}`;
		const projectId = `PROJ${copy}`;
		const initiativeId = `INIT${copy}`;
		const issueId = `ISS${copy}`;
		const issueStableId = deriveMigratedEntityIdentity("issue", issueId).stableId;
		await pool.query(`INSERT INTO entities
			(tenant_id, id, kind, title, status, body, body_source, created_at, updated_at)
			VALUES
			($1, $2, 'project', 'Project', 'active', '', 'authored', '2024-01-01', '2024-01-01'),
			($1, $3, 'initiative', 'Initiative', 'active', '', 'authored', '2024-01-01', '2024-01-01'),
			($1, $4, 'issue', 'Current', 'in-progress', 'current', 'authored', '2024-01-02', '2024-01-04')`,
			[tenantId, projectId, initiativeId, issueId]);
		await pool.query(`INSERT INTO relations (tenant_id, from_id, to_id, type, created_at) VALUES
			($1, $2, $3, 'contains', '2024-01-01'),
			($1, $3, $4, 'tracks', '2024-01-02')`, [tenantId, projectId, initiativeId, issueId]);
		await pool.query(`INSERT INTO history_entries
			(id, tenant_id, entity_id, version, author, title, body, body_source, status, parent_id, created_at) VALUES
			($1, $2, $3, 1, 'creator', 'First', 'first', 'authored', 'todo', $4, '2024-01-02'),
			($5, $2, $3, 2, 'editor', 'Second', 'second', 'authored', 'in-progress', $4, '2024-01-03')`,
			[collideRevisionId ? `legacy-head:${issueStableId}` : `history-${copy}-1`, tenantId, issueId, initiativeId, `history-${copy}-2`]);
	}
}

function instrumentPoolQueries(pool: Pool): { pool: Pool; statementCount: () => number } {
	let statements = 0;
	const instrumented = new Proxy(pool, {
		get(target, property, receiver) {
			if (property !== "connect") {
				return Reflect.get(target, property, receiver) as unknown;
			}
			return async (): Promise<PoolClient> => {
				const client = await target.connect();
				return new Proxy(client, {
					get(clientTarget, clientProperty, clientReceiver) {
						if (clientProperty !== "query") {
							return Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
						}
						return (...args: unknown[]) => {
							statements++;
							return Reflect.apply(clientTarget.query, clientTarget, args) as unknown;
						};
					}
				}) as PoolClient;
			};
		}
	}) as Pool;
	return { pool: instrumented, statementCount: () => statements };
}
