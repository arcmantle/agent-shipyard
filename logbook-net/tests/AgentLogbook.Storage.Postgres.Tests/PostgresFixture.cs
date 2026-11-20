using AgentLogbook.Storage.Postgres;
using Npgsql;
using Testcontainers.PostgreSql;

namespace AgentLogbook.Storage.Postgres.Tests;

/// <summary>
/// One real PostgreSQL server for the whole test run, with the three roles of the production database
/// contract. Each test gets its own empty database that the owner role owns.
/// </summary>
internal static class PostgresFixture
{
	internal const string Password = "test-only";

	internal static readonly PostgresSchemaRoles Roles = new("agent_logbook_owner", "agent_logbook_runtime", "agent_logbook_migration");

	private static readonly Lazy<Task<PostgreSqlContainer>> Server = new(StartAsync);

	private static int databaseCounter;

	private static async Task<PostgreSqlContainer> StartAsync()
	{
		var container = new PostgreSqlBuilder("postgres:16-alpine")
			// The data lives in memory: the tests need no persistence, and a full Docker disk cannot break them.
			.WithTmpfsMount("/var/lib/postgresql/data")
			.Build();
		await container.StartAsync();

		await using var admin = new NpgsqlConnection(container.GetConnectionString());
		await admin.OpenAsync();
		foreach (var sql in new[]
		{
			$"CREATE ROLE {Roles.Owner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
			$"CREATE ROLE {Roles.Runtime} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{Password}'",
			$"CREATE ROLE {Roles.Migration} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{Password}'",
			$"GRANT {Roles.Owner} TO {Roles.Migration} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
		})
		{
			await using var command = new NpgsqlCommand(sql, admin);
			await command.ExecuteNonQueryAsync();
		}

		return container;
	}

	[After(TestSession)]
	public static async Task StopAsync()
	{
		if (Server.IsValueCreated)
		{
			await (await Server.Value).DisposeAsync();
		}
	}

	/// <summary>Creates an empty database that the owner role owns.</summary>
	internal static async Task<TestDatabase> CreateDatabaseAsync()
	{
		var container = await Server.Value;
		var name = $"logbook_test_{Interlocked.Increment(ref databaseCounter)}";

		await using (var admin = new NpgsqlConnection(container.GetConnectionString()))
		{
			await admin.OpenAsync();
			foreach (var sql in new[]
			{
				$"CREATE DATABASE {name} OWNER {Roles.Owner}",
				$"REVOKE ALL ON DATABASE {name} FROM PUBLIC",
				$"GRANT CONNECT ON DATABASE {name} TO {Roles.Runtime}, {Roles.Migration}",
			})
			{
				await using var command = new NpgsqlCommand(sql, admin);
				await command.ExecuteNonQueryAsync();
			}
		}

		var baseConnection = new NpgsqlConnectionStringBuilder(container.GetConnectionString()) { Database = name };
		return new TestDatabase(baseConnection);
	}
}

internal sealed class TestDatabase(NpgsqlConnectionStringBuilder superuser)
{
	/// <summary>A connection that bypasses every restriction. Tests use it only to prepare and inspect.</summary>
	internal NpgsqlDataSource Admin() => NpgsqlDataSource.Create(superuser);

	internal NpgsqlDataSource Login(string role, string? schema = null) =>
		NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(superuser.ConnectionString)
		{
			Username = role,
			Password = PostgresFixture.Password,
			Pooling = false,
			SearchPath = schema,
		});

	internal NpgsqlDataSource Migration(string? schema = null) => Login(PostgresFixture.Roles.Migration, schema);

	internal NpgsqlDataSource Runtime() => Login(PostgresFixture.Roles.Runtime);

	internal async Task<PostgresSchemaInitialization> InitializeAsync()
	{
		await using var migration = Migration();
		return await PostgresSchemaInitializer.InitializeAsync(migration, PostgresFixture.Roles);
	}

	internal async Task<PostgresSchemaInitialization> InitializeAsync(PostgresMigrationChain chain, string? schema = null)
	{
		await using var migration = Migration(schema);
		return await PostgresSchemaInitializer.InitializeAsync(migration, chain, PostgresFixture.Roles);
	}

	/// <summary>The schema signature of the current database schema, read as the superuser.</summary>
	internal async Task<string> SignatureAsync(string? schema = null)
	{
		await using var admin = Admin();
		await using var connection = await admin.OpenConnectionAsync();
		if (schema is not null)
		{
			await using var path = connection.CreateCommand();
			path.CommandText = $"SET search_path TO {schema}";
			await path.ExecuteNonQueryAsync();
		}

		return await PostgresSchemaCatalog.ComputeSignatureAsync(connection);
	}

	internal async Task<T> ScalarAsync<T>(string sql)
	{
		await using var admin = Admin();
		await using var command = admin.CreateCommand(sql);
		return (T)(await command.ExecuteScalarAsync())!;
	}

	internal async Task<IReadOnlyList<string>> ColumnAsync(string sql)
	{
		await using var admin = Admin();
		await using var command = admin.CreateCommand(sql);
		await using var reader = await command.ExecuteReaderAsync();
		var values = new List<string>();
		while (await reader.ReadAsync())
		{
			values.Add(reader.GetString(0));
		}

		return values;
	}

	internal async Task ExecuteAsync(string sql)
	{
		await using var admin = Admin();
		await using var command = admin.CreateCommand(sql);
		await command.ExecuteNonQueryAsync();
	}

	internal Task<IReadOnlyList<string>> LedgerAsync() =>
		ColumnAsync("SELECT id FROM schema_migrations ORDER BY applied_at, id");
}
