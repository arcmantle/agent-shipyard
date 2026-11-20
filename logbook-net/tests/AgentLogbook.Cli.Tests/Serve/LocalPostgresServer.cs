using Npgsql;
using Testcontainers.PostgreSql;

namespace AgentLogbook.Cli.Tests.Serve;

/// <summary>One real PostgreSQL server for the test run. Each test gets its own empty database.</summary>
internal static class LocalPostgresServer
{
	private static readonly Lazy<Task<PostgreSqlContainer>> Server = new(StartAsync);

	private static int databaseCounter;

	private static async Task<PostgreSqlContainer> StartAsync()
	{
		var container = new PostgreSqlBuilder("postgres:16-alpine")
			// The data lives in memory: the tests need no persistence, and a full Docker disk cannot break them.
			.WithTmpfsMount("/var/lib/postgresql/data")
			.Build();
		await container.StartAsync();
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

	/// <summary>Creates an empty database and returns the <c>postgres://</c> URL that the Local API host reads.</summary>
	internal static async Task<string> CreateDatabaseUrlAsync()
	{
		var container = await Server.Value;
		var name = $"serve_test_{Interlocked.Increment(ref databaseCounter)}";

		await using var admin = new NpgsqlConnection(container.GetConnectionString());
		await admin.OpenAsync();
		await using var create = new NpgsqlCommand($"CREATE DATABASE {name}", admin);
		await create.ExecuteNonQueryAsync();

		return $"postgres://{PostgreSqlBuilder.DefaultUsername}:{PostgreSqlBuilder.DefaultPassword}@{container.Hostname}:{container.GetMappedPublicPort(5432)}/{name}";
	}

	internal static async Task ExecuteAsync(string url, string sql)
	{
		var uri = new Uri(url);
		var builder = new NpgsqlConnectionStringBuilder
		{
			Host = uri.Host,
			Port = uri.Port,
			Database = uri.AbsolutePath.Trim('/'),
			Username = PostgreSqlBuilder.DefaultUsername,
			Password = PostgreSqlBuilder.DefaultPassword,
		};
		await using var connection = new NpgsqlConnection(builder.ConnectionString);
		await connection.OpenAsync();
		await using var command = new NpgsqlCommand(sql, connection);
		await command.ExecuteNonQueryAsync();
	}
}
