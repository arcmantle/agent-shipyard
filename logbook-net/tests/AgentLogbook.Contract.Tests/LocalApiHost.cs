using System.Diagnostics;
using System.Text.RegularExpressions;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;
using Npgsql;
using Testcontainers.PostgreSql;

namespace AgentLogbook.Contract.Tests;

/// <summary>
/// One real Local API host (<c>agent-logbook serve</c> from the build output) on one real PostgreSQL server for the test run.
/// The parity tool compares the candidate CLI and the host with the golden files.
/// </summary>
internal static partial class LocalApiHost
{
	private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(60);

	private const string HostRole = "logbook_contract";
	private const string HostPassword = "contract";
	private const string HostDatabase = "contract";

	private static readonly Lazy<Task<Running>> Instance = new(StartAsync);

	internal static string CliDll { get; } = Path.Combine(AppContext.BaseDirectory, "AgentLogbook.Cli.dll");

	internal static string DotnetHost { get; } = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";

	internal static async Task<string> UrlAsync() => (await Instance.Value).Url;

	/// <summary>Empties every table except the migration ledger. The host has one tenant, so each case starts on empty tables.</summary>
	internal static async Task EmptyTablesAsync()
	{
		var running = await Instance.Value;
		await using var connection = new NpgsqlConnection(running.AdminConnectionString);
		await connection.OpenAsync();
		await using var list = new NpgsqlCommand("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'", connection);
		var tables = new List<string>();
		await using (var reader = await list.ExecuteReaderAsync())
		{
			while (await reader.ReadAsync())
			{
				tables.Add($"\"{reader.GetString(0)}\"");
			}
		}

		if (tables.Count > 0)
		{
			await using var truncate = new NpgsqlCommand($"TRUNCATE {string.Join(", ", tables)} RESTART IDENTITY CASCADE", connection);
			await truncate.ExecuteNonQueryAsync();
		}
	}

	[After(TestSession)]
	public static async Task StopAsync()
	{
		if (!Instance.IsValueCreated)
		{
			return;
		}

		var running = await Instance.Value;
		if (!running.Host.HasExited)
		{
			running.Host.Kill(entireProcessTree: true);
			await running.Host.WaitForExitAsync();
		}

		running.Host.Dispose();
		await running.Container.DisposeAsync();
		try
		{
			Directory.Delete(running.ShipyardHome, recursive: true);
		}
		catch (IOException)
		{
			// A temporary folder that stays is not a test failure.
		}
	}

	private static async Task<Running> StartAsync()
	{
		var container = new PostgreSqlBuilder("postgres:16-alpine")
			// The data lives in memory: the tests need no persistence.
			.WithTmpfsMount("/var/lib/postgresql/data")
			.Build();
		await container.StartAsync();
		try
		{
			return await StartHostAsync(container);
		}
		catch
		{
			// A failed start must not leave the container running until the test session ends.
			await container.DisposeAsync();
			throw;
		}
	}

	private static async Task<Running> StartHostAsync(PostgreSqlContainer container)
	{
		// A superuser skips row-level security, so the host runs as the owner of its own database, without that right.
		var adminConnectionString = container.GetConnectionString();
		await using (var admin = new NpgsqlConnection(adminConnectionString))
		{
			await admin.OpenAsync();
			foreach (var statement in new[] { $"CREATE ROLE {HostRole} LOGIN PASSWORD '{HostPassword}'", $"CREATE DATABASE {HostDatabase} OWNER {HostRole}" })
			{
				await using var command = new NpgsqlCommand(statement, admin);
				await command.ExecuteNonQueryAsync();
			}
		}

		var shipyardHome = Directory.CreateTempSubdirectory("contract-shipyard-").FullName;
		var postgresUrl = $"postgres://{HostRole}:{HostPassword}@{container.Hostname}:{container.GetMappedPublicPort(5432)}/{HostDatabase}";
		var info = new ProcessStartInfo(DotnetHost)
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		info.ArgumentList.Add(CliDll);
		info.ArgumentList.Add("serve");
		info.Environment[ShipyardLogbookFolder.HomeVariable] = shipyardHome;
		info.Environment[LocalPostgresSelection.UrlVariable] = postgresUrl;

		var host = Process.Start(info) ?? throw new InvalidOperationException("The Local API host did not start.");
		var output = new System.Text.StringBuilder();
		var url = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
		host.OutputDataReceived += (_, e) =>
		{
			if (e.Data is null)
			{
				return;
			}

			lock (output)
			{
				output.AppendLine(e.Data);
			}

			var found = ListeningUrl().Match(e.Data);
			if (found.Success)
			{
				url.TrySetResult(found.Groups[1].Value);
			}
		};
		host.ErrorDataReceived += (_, e) =>
		{
			if (e.Data is not null)
			{
				lock (output)
				{
					output.AppendLine(e.Data);
				}
			}
		};
		host.BeginOutputReadLine();
		host.BeginErrorReadLine();

		using var timeout = new CancellationTokenSource(StartTimeout);
		var exited = host.WaitForExitAsync(timeout.Token);
		var ready = await Task.WhenAny(url.Task, exited);
		if (ready != url.Task)
		{
			host.Kill(entireProcessTree: true);
			lock (output)
			{
				throw new InvalidOperationException($"The Local API host was not ready within {StartTimeout}.{Environment.NewLine}{output}");
			}
		}

		return new Running(container, host, shipyardHome, await url.Task, new NpgsqlConnectionStringBuilder(adminConnectionString) { Database = HostDatabase, Username = HostRole, Password = HostPassword }.ConnectionString);
	}

	[GeneratedRegex(@"listening on (http://\S+) ")]
	private static partial Regex ListeningUrl();

	private sealed record Running(PostgreSqlContainer Container, Process Host, string ShipyardHome, string Url, string AdminConnectionString);
}
