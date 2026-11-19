using System.Text.RegularExpressions;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;
using Npgsql;
using Testcontainers.PostgreSql;

namespace AgentLogbook.Storage.Postgres.Tests;

public partial class LocalPostgresComposeTests
{
	private static readonly string ComposeText = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "docker", "compose.yaml"));

	private static string Setting(string name) =>
		Regex.Match(ComposeText, $@"^\s*{name}:\s*(\S+)\s*$", RegexOptions.Multiline).Groups[1].Value;

	[GeneratedRegex(@"^\s*-\s*""([\d.]+):(\d+):5432""\s*$", RegexOptions.Multiline)]
	private static partial Regex PortMapping();

	[Test]
	public async Task Built_in_default_matches_the_compose_service()
	{
		var port = PortMapping().Match(ComposeText);
		var fromDefault = LocalPostgresConnection.Parse(LocalPostgresSelection.DefaultUrl);

		await Assert.That(fromDefault.Username).IsEqualTo(Setting("POSTGRES_USER"));
		await Assert.That(fromDefault.Password).IsEqualTo(Setting("POSTGRES_PASSWORD"));
		await Assert.That(fromDefault.Database).IsEqualTo(Setting("POSTGRES_DB"));
		await Assert.That(fromDefault.Host).IsEqualTo(port.Groups[1].Value);
		await Assert.That(fromDefault.Port).IsEqualTo(int.Parse(port.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture));
	}

	[Test]
	public async Task Shared_startup_schema_setup_runs_on_a_postgres_started_like_the_compose_service()
	{
		var image = Regex.Match(ComposeText, @"image:\s*(\S+)").Groups[1].Value;
		var container = new PostgreSqlBuilder(image)
			.WithUsername(Setting("POSTGRES_USER"))
			.WithPassword(Setting("POSTGRES_PASSWORD"))
			.WithDatabase(Setting("POSTGRES_DB"))
			.Build();
		await container.StartAsync();
		await using var _ = container;

		var url = $"postgres://{Setting("POSTGRES_USER")}:{Setting("POSTGRES_PASSWORD")}@{container.Hostname}:{container.GetMappedPublicPort(5432)}/{Setting("POSTGRES_DB")}";
		var folder = ShipyardLogbookFolder.Resolve(_ => null, Path.GetTempPath());
		var selection = LocalPostgresSelection.Select(
			name => name == LocalPostgresSelection.UrlVariable ? url : null,
			folder);

		await using var dataSource = LocalPostgresDataSource.Create(selection.Connection);
		var first = await PostgresSchemaInitializer.InitializeAsync(dataSource);
		var second = await PostgresSchemaInitializer.InitializeAsync(dataSource);

		await Assert.That(first).IsEqualTo(PostgresSchemaInitialization.Created);
		await Assert.That(second).IsEqualTo(PostgresSchemaInitialization.AlreadyCurrent);
	}

	[Test]
	public async Task Unavailable_postgres_fails_explicitly_and_does_not_use_another_database()
	{
		var folder = ShipyardLogbookFolder.Resolve(_ => null, Path.GetTempPath());
		var selection = LocalPostgresSelection.Select(
			name => name == LocalPostgresSelection.UrlVariable ? "postgres://u:p@127.0.0.1:1/unreachable" : null,
			folder);

		await using var dataSource = LocalPostgresDataSource.Create(selection.Connection);

		await Assert.That(async () => await PostgresSchemaInitializer.InitializeAsync(dataSource)).Throws<NpgsqlException>();
	}
}
