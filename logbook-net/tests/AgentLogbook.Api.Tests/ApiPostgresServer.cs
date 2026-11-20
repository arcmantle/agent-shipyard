using Testcontainers.PostgreSql;

namespace AgentLogbook.Api.Tests;

/// <summary>One real PostgreSQL server for the test run.</summary>
internal static class ApiPostgresServer
{
	private static readonly Lazy<Task<PostgreSqlContainer>> Server = new(async () =>
	{
		var container = new PostgreSqlBuilder("postgres:16-alpine").Build();
		await container.StartAsync();
		return container;
	});

	internal static Task<PostgreSqlContainer> Container() => Server.Value;

	[After(TestSession)]
	public static async Task StopAsync()
	{
		if (Server.IsValueCreated)
		{
			await (await Server.Value).DisposeAsync();
		}
	}
}
