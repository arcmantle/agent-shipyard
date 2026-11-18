using AgentLogbook.Storage.Postgres;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Tests;

public class PostgresSchemaInitializerTests
{
	private static readonly string[] ExpectedTables =
	[
		"completion_observations", "context_terms", "contexts", "counters", "entities", "instruction_bundles",
		"instruction_defaults", "instruction_history", "instruction_overrides", "instruction_personal_fragments",
		"issue_breakdown_drafts", "issue_comment_references", "issue_comments", "plan_entries",
		"plan_entry_references", "plan_entry_supersessions", "project_settings", "relations", "revision_entries",
		"schema_migrations", "users",
	];

	private const string TableList = "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname";

	[Test]
	public async Task A_fresh_database_gets_the_final_schema_and_only_the_baseline_ledger_entry()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();

		var result = await database.InitializeAsync();

		await Assert.That(result).IsEqualTo(PostgresSchemaInitialization.Created);
		await Assert.That(await database.ColumnAsync(TableList)).IsEquivalentTo(ExpectedTables);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([PostgresSchemaInitializer.BaselineId]);
	}

	[Test]
	public async Task The_baseline_does_not_write_the_typescript_migration_ids()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();

		await database.InitializeAsync();

		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM schema_migrations WHERE id = 'final-baseline'")).IsEqualTo(0L);
	}

	[Test]
	public async Task Repeated_startup_is_idempotent()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		var appliedAt = await database.ScalarAsync<DateTime>("SELECT applied_at FROM schema_migrations");

		var second = await database.InitializeAsync();
		var third = await database.InitializeAsync();

		await Assert.That(second).IsEqualTo(PostgresSchemaInitialization.AlreadyCurrent);
		await Assert.That(third).IsEqualTo(PostgresSchemaInitialization.AlreadyCurrent);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([PostgresSchemaInitializer.BaselineId]);
		await Assert.That(await database.ScalarAsync<DateTime>("SELECT applied_at FROM schema_migrations")).IsEqualTo(appliedAt);
	}

	[Test]
	public async Task Hosts_that_start_together_create_the_schema_once()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();

		var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => database.InitializeAsync()));

		await Assert.That(results.Count(result => result == PostgresSchemaInitialization.Created)).IsEqualTo(1);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo([PostgresSchemaInitializer.BaselineId]);
	}

	[Test]
	public async Task Every_tenant_table_forces_row_level_security_with_a_tenant_policy()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();

		var withoutIsolation = await database.ColumnAsync(
			"""
			SELECT relation.relname FROM pg_class relation
			WHERE relation.relnamespace = 'public'::regnamespace AND relation.relkind = 'r'
				AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = relation.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
				AND NOT (relation.relrowsecurity AND relation.relforcerowsecurity
					AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = relation.relname
						AND (p.policyname = 'tenant_isolation' OR p.policyname LIKE 'instruction\_%\_isolation')
						AND p.qual LIKE '%app.tenant_id%'))
			ORDER BY relation.relname
			""");
		var tenantTables = await database.ScalarAsync<long>(
			"SELECT count(*) FROM pg_class relation WHERE relation.relnamespace = 'public'::regnamespace AND relation.relkind = 'r' AND relation.relrowsecurity");

		await Assert.That(withoutIsolation).IsEmpty();
		await Assert.That(tenantTables).IsEqualTo(18L);
	}

	[Test]
	public async Task The_final_schema_keeps_the_full_text_indexes_and_the_reference_constraints()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();

		var fullText = await database.ColumnAsync(
			"SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%USING gin%' ORDER BY indexname");
		var constraints = await database.ColumnAsync(
			"""
			SELECT conname FROM pg_constraint WHERE conrelid IN ('entities'::regclass, 'relations'::regclass, 'revision_entries'::regclass)
				AND conname IN ('entities_pkey', 'relations_pkey', 'revision_entries_record_kind', 'revision_entries_source_hash_length')
			ORDER BY conname
			""");

		await Assert.That(fullText).IsEquivalentTo([
			"context_terms_search_idx", "contexts_search_idx", "entities_search_idx", "issue_comments_search_idx", "plan_entries_search_idx",
		]);
		await Assert.That(constraints).IsEquivalentTo(["entities_pkey", "relations_pkey", "revision_entries_record_kind", "revision_entries_source_hash_length"]);
	}

	[Test]
	public async Task The_runtime_role_has_only_the_reviewed_table_access()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await using var runtime = database.Runtime();

		await using var restricted = runtime.CreateCommand(RuntimeRestrictionQuery);
		await Assert.That((bool)(await restricted.ExecuteScalarAsync())!).IsTrue();

		foreach (var statement in new[]
		{
			"ALTER TABLE entities DISABLE ROW LEVEL SECURITY",
			$"SET ROLE {PostgresFixture.Roles.Owner}",
			$"SET ROLE {PostgresFixture.Roles.Migration}",
			"CREATE ROLE logbook_forbidden_check",
			"SELECT 1 FROM schema_migrations",
			"INSERT INTO instruction_defaults DEFAULT VALUES",
		})
		{
			await using var command = runtime.CreateCommand(statement);
			var error = await Assert.ThrowsAsync<PostgresException>(async () => await command.ExecuteNonQueryAsync());
			await Assert.That(error!.SqlState).IsEqualTo("42501");
		}
	}

	[Test]
	public async Task The_runtime_role_sees_only_the_rows_of_its_tenant()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await using var runtime = database.Runtime();

		foreach (var tenant in new[] { "tenant-a", "tenant-b" })
		{
			await using var connection = await runtime.OpenConnectionAsync();
			await using var transaction = await connection.BeginTransactionAsync();
			await Execute(connection, $"SELECT set_config('app.tenant_id', '{tenant}', true)");
			await Execute(connection, $"INSERT INTO counters (tenant_id, kind, next_value) VALUES ('{tenant}', 'ISS', 1)");
			await transaction.CommitAsync();
		}

		await using var reader = await runtime.OpenConnectionAsync();
		await using var readTransaction = await reader.BeginTransactionAsync();
		await Execute(reader, "SELECT set_config('app.tenant_id', 'tenant-a', true)");
		await using var select = new NpgsqlCommand("SELECT tenant_id FROM counters", reader, readTransaction);
		await using var rows = await select.ExecuteReaderAsync();
		var seen = new List<string>();
		while (await rows.ReadAsync())
		{
			seen.Add(rows.GetString(0));
		}

		await Assert.That(seen).IsEquivalentTo(["tenant-a"]);

		static async Task Execute(NpgsqlConnection connection, string sql)
		{
			await using var command = new NpgsqlCommand(sql, connection);
			await command.ExecuteNonQueryAsync();
		}
	}

	[Test]
	public async Task The_migration_role_acts_as_the_owner_but_has_no_runtime_access()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();

		var owner = await database.ScalarAsync<string>("SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'entities'");
		await using var migration = database.Migration();
		await using var command = migration.CreateCommand("SELECT count(*) FROM entities");
		var error = await Assert.ThrowsAsync<PostgresException>(async () => await command.ExecuteScalarAsync());

		await Assert.That(owner).IsEqualTo(PostgresFixture.Roles.Owner);
		await Assert.That(error!.SqlState).IsEqualTo("42501");
	}

	[Test]
	public async Task A_schema_with_unknown_objects_fails_clearly_and_is_left_unchanged()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.ExecuteAsync("CREATE TABLE widgets (id int)");
		await database.ExecuteAsync("ALTER TABLE widgets OWNER TO " + PostgresFixture.Roles.Owner);
		var before = await database.ColumnAsync(TableList);

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync());

		await Assert.That(error!.Message).Contains("does not adopt");
		await Assert.That(await database.ColumnAsync(TableList)).IsEquivalentTo(before);
		await Assert.That(await database.ColumnAsync(TableList)).IsEquivalentTo(["widgets"]);
	}

	[Test]
	public async Task A_database_that_the_typescript_storage_made_is_rejected_and_not_adopted()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await database.ExecuteAsync(
			"""
			DELETE FROM schema_migrations;
			INSERT INTO schema_migrations (id) VALUES ('final-baseline'), ('adr-status-to-current'), ('user-directory'), ('record-provenance');
			""");
		var before = await database.ColumnAsync(TableList);

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync());

		await Assert.That(error!.Message).Contains("TypeScript");
		await Assert.That(await database.ColumnAsync(TableList)).IsEquivalentTo(before);
		await Assert.That(await database.LedgerAsync()).IsEquivalentTo(["adr-status-to-current", "final-baseline", "record-provenance", "user-directory"]);
	}

	[Test]
	public async Task A_schema_that_differs_from_the_final_schema_is_rejected_without_a_change()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await database.ExecuteAsync("DROP INDEX entities_search_idx");

		var error = await Assert.ThrowsAsync<UnrecognizedSchemaException>(async () => await database.InitializeAsync());

		await Assert.That(error!.Message).Contains("does not match");
		await Assert.That(await database.ScalarAsync<long>("SELECT count(*) FROM pg_indexes WHERE indexname = 'entities_search_idx'")).IsEqualTo(0L);
	}

	[Test]
	public async Task A_current_schema_with_another_owner_is_rejected_instead_of_silently_skipping_grants()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await database.InitializeAsync();
		await database.ExecuteAsync("ALTER TABLE entities OWNER TO " + PostgresFixture.Roles.Migration);

		var error = await Assert.ThrowsAsync<InvalidOperationException>(async () => await database.InitializeAsync());

		await Assert.That(error!.Message).Contains("not owned by");
	}

	[Test]
	public async Task A_failed_initialization_leaves_no_part_of_the_schema()
	{
		var database = await PostgresFixture.CreateDatabaseAsync();
		await using var migration = database.Migration();
		var wrongRoles = new PostgresSchemaRoles("agent_logbook_owner", "agent_logbook_runtime_missing", "agent_logbook_migration");

		await Assert.ThrowsAsync<PostgresException>(async () => await PostgresSchemaInitializer.InitializeAsync(migration, wrongRoles));

		await Assert.That(await database.ColumnAsync(TableList)).IsEmpty();
	}

	private const string RuntimeRestrictionQuery = """
		SELECT current_user = session_user
			AND NOT (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls OR role.rolinherit)
			AND role.rolcanlogin
			AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid)
			AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = role.oid)
			AND NOT has_database_privilege(current_database(), 'CREATE, TEMP')
			AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
				AND (nspowner = role.oid OR has_schema_privilege(oid, 'CREATE')))
			AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
				AND (relowner = role.oid OR (relkind IN ('r', 'p', 'v', 'm', 'f') AND (
					has_table_privilege(relation.oid, 'TRUNCATE, REFERENCES, TRIGGER')
					OR has_any_column_privilege(relation.oid, 'REFERENCES')
					OR CASE
						WHEN relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity AND relforcerowsecurity THEN false
						WHEN relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname IN ('instruction_bundles', 'instruction_defaults') THEN
							has_table_privilege(relation.oid, 'INSERT, UPDATE, DELETE') OR has_any_column_privilege(relation.oid, 'INSERT, UPDATE')
						ELSE has_table_privilege(relation.oid, 'SELECT, INSERT, UPDATE, DELETE') OR has_any_column_privilege(relation.oid, 'SELECT, INSERT, UPDATE') END)))) AS restricted
		FROM pg_roles role WHERE rolname = current_user
		""";
}
