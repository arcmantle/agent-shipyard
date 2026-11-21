using System.Diagnostics;
using System.Text.Json.Nodes;
using AgentLogbook.Cli.Tests.Mcp;
using AgentLogbook.Cli.Tests.Serve;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.AutoStart;

/// <summary>
/// The first local storage request of the CLI or the MCP server starts one Local API host in the background. Every test runs the real
/// command as a process against a real PostgreSQL server and stops only the host of its own data folder.
/// </summary>
[NotInParallel]
public class LocalApiAutoStartTests
{
	private static string NewWorkspace(string name)
	{
		var root = Path.Combine(Directory.CreateTempSubdirectory("logbook-autostart-").FullName, name);
		Directory.CreateDirectory(root);
		File.WriteAllText(Path.Combine(root, "pnpm-workspace.yaml"), "");
		return root;
	}

	private static string NewHome() => Directory.CreateTempSubdirectory("autostart-shipyard-").FullName;

	private static async Task<LocalApiDiscovery> RunningHostAsync(string home)
	{
		var discovery = LocalApiDiscovery.Read(CliProcess.Folder(home));
		await Assert.That(discovery).IsNotNull();
		await Assert.That(discovery!.IsProcessAlive()).IsTrue();
		return discovery;
	}

	[Test]
	public async Task The_first_storage_command_starts_the_host_and_later_commands_reuse_it()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var workspace = NewWorkspace("first-request");
			await Assert.That(LocalApiDiscovery.Read(CliProcess.Folder(home))).IsNull();

			var created = await CliProcess.RunAsync(workspace, home, pg, "create", "initiative", "--title", "Started on demand", "--json");
			var host = await RunningHostAsync(home);
			var listed = await CliProcess.RunAsync(workspace, home, pg, "list", "initiative", "--json");

			await Assert.That(created.Exit).IsEqualTo(0).Because(created.Err);
			await Assert.That(JsonNode.Parse(created.Out)!["operation"]!.GetValue<string>()).IsEqualTo("create");
			await Assert.That(listed.Exit).IsEqualTo(0).Because(listed.Err);
			await Assert.That(JsonNode.Parse(listed.Out)!["total"]!.GetValue<int>()).IsEqualTo(1);
			await Assert.That((await RunningHostAsync(home)).ProcessId).IsEqualTo(host.ProcessId);
			await Assert.That(File.ReadAllText(CliProcess.Folder(home).LogFile)).Contains(host.Url);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task The_started_host_outlives_the_command_and_has_no_idle_shutdown()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var run = await CliProcess.RunAsync(NewWorkspace("idle"), home, pg, "list", "initiative");
			var host = await RunningHostAsync(home);

			await Task.Delay(TimeSpan.FromSeconds(4));

			await Assert.That(run.Exit).IsEqualTo(0).Because(run.Err);
			await Assert.That((await RunningHostAsync(home)).ProcessId).IsEqualTo(host.ProcessId);
			using var client = new HttpClient();
			using var live = await client.GetAsync(new Uri(new Uri(host.Url), "/health/live"));
			await Assert.That(live.IsSuccessStatusCode).IsTrue();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task Concurrent_commands_start_only_one_host()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var workspace = NewWorkspace("concurrent");
			var processes = Enumerable.Range(0, 5)
				.Select(_ => CliProcess.Start(workspace, home, pg, "list", "initiative", "--json"))
				.ToArray();

			var results = await Task.WhenAll(processes.Select(CliProcess.WaitAsync));

			foreach (var result in results)
			{
				await Assert.That(result.Exit).IsEqualTo(0).Because(result.Err);
			}

			var host = await RunningHostAsync(home);
			// Every host that reaches readiness prints exactly one line to the log.
			await Task.Delay(TimeSpan.FromSeconds(2));
			var listening = File.ReadAllLines(CliProcess.Folder(home).LogFile).Count(line => line.StartsWith("Local API host ", StringComparison.Ordinal));
			await Assert.That(listening).IsEqualTo(1);
			await Assert.That(host.ProcessId).IsNotEqualTo(Environment.ProcessId);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task Stale_discovery_and_start_lock_files_of_a_dead_host_are_replaced()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home).EnsureExists();
			var stale = new LocalApiDiscovery("http://127.0.0.1:1", 1, int.MaxValue, "0.0.1", DateTimeOffset.UtcNow.AddHours(-1));
			stale.Write(folder);
			File.WriteAllText(folder.StartLockFile, "left over");

			var run = await CliProcess.RunAsync(NewWorkspace("stale"), home, pg, "list", "initiative");

			await Assert.That(run.Exit).IsEqualTo(0).Because(run.Err);
			var host = await RunningHostAsync(home);
			await Assert.That(host.ProcessId).IsNotEqualTo(stale.ProcessId);
			await Assert.That(host.Url).IsNotEqualTo(stale.Url);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task A_discovery_file_of_a_live_unrelated_process_is_not_used_and_the_failure_is_reported()
	{
		var home = NewHome();
		using var unrelated = Process.Start(new ProcessStartInfo("sleep", "120") { UseShellExecute = false })!;
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home).EnsureExists();
			var stale = new LocalApiDiscovery("http://127.0.0.1:1", 1, unrelated.Id, "0.0.1", DateTimeOffset.UtcNow);
			stale.Write(folder);

			var run = await CliProcess.RunAsync(NewWorkspace("unrelated"), home, pg, "list", "initiative");

			await Assert.That(run.Exit).IsEqualTo(1);
			await Assert.That(run.Out).IsEmpty();
			await Assert.That(run.Err).StartsWith("agent-logbook list: The Local API host at http://127.0.0.1:1");
		}
		finally
		{
			unrelated.Kill();
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task An_unreachable_postgres_fails_fast_with_the_reason_and_leaves_no_host()
	{
		var home = NewHome();
		try
		{
			var clock = Stopwatch.StartNew();
			var run = await CliProcess.RunAsync(NewWorkspace("no-postgres"), home, LocalPostgresServer.UnreachableUrl, "list", "initiative");
			clock.Stop();

			await Assert.That(run.Exit).IsEqualTo(1);
			await Assert.That(run.Out).IsEmpty();
			await Assert.That(run.Err).StartsWith("agent-logbook list: The Local API host did not start. The process ended with exit code 1. It wrote: agent-logbook serve: the Local API host did not start.");
			await Assert.That(run.Err.Length).IsLessThan(4500);
			await Assert.That(run.Err.Trim().Split('\n').Length).IsEqualTo(1);
			await Assert.That(clock.Elapsed).IsLessThan(TimeSpan.FromSeconds(45));
			await Assert.That(LocalApiDiscovery.Read(CliProcess.Folder(home))).IsNull();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task The_log_stays_bounded_across_starts()
	{
		var home = NewHome();
		try
		{
			var folder = CliProcess.Folder(home).EnsureExists();
			File.WriteAllText(folder.LogFile, new string('x', 300 * 1024));

			var run = await CliProcess.RunAsync(NewWorkspace("log-bound"), home, LocalPostgresServer.UnreachableUrl, "list", "initiative");

			await Assert.That(run.Exit).IsEqualTo(1);
			await Assert.That(new FileInfo(folder.LogFile).Length).IsLessThan(64 * 1024);
			await Assert.That(run.Err).DoesNotContain("xxxxxxxx");
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task Metadata_and_project_identity_commands_start_neither_postgres_nor_the_host()
	{
		var home = NewHome();
		try
		{
			var workspace = NewWorkspace("pure");
			var identity = await CliProcess.RunAsync(workspace, home, LocalPostgresServer.UnreachableUrl, "project-identity", "--json");
			var capabilities = await CliProcess.RunAsync(workspace, home, LocalPostgresServer.UnreachableUrl, "capabilities", "--json");
			var schema = await CliProcess.RunAsync(workspace, home, LocalPostgresServer.UnreachableUrl, "schema", "--json");

			await Assert.That(identity.Exit).IsEqualTo(0).Because(identity.Err);
			await Assert.That(capabilities.Exit).IsEqualTo(0).Because(capabilities.Err);
			await Assert.That(schema.Exit).IsEqualTo(0).Because(schema.Err);
			await Assert.That(Directory.GetFileSystemEntries(home)).IsEmpty();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	[Arguments("INT")]
	[Arguments("HUP")]
	public async Task The_started_host_ignores_the_interrupt_and_hangup_signals_of_the_terminal_of_the_caller(string signal)
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			await CliProcess.RunAsync(NewWorkspace("signals"), home, pg, "list", "initiative");
			var host = await RunningHostAsync(home);

			using var kill = Process.Start("kill", [$"-{signal}", host.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)])!;
			await kill.WaitForExitAsync();
			await Task.Delay(TimeSpan.FromSeconds(2));

			await Assert.That((await RunningHostAsync(home)).ProcessId).IsEqualTo(host.ProcessId);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task The_mcp_server_starts_the_host_for_its_first_storage_tool_and_shares_it_with_the_cli()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var workspace = NewWorkspace("mcp-first");
			await using var mcp = McpProcess.Start(workspace, home, [], postgresUrl: pg);
			await mcp.InitializeAsync();
			await mcp.CallToolAsync("project_identity", new JsonObject());
			await Assert.That(LocalApiDiscovery.Read(CliProcess.Folder(home))).IsNull();

			var missing = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = "ISS_NOSUCHENTITY" } });
			var host = await RunningHostAsync(home);
			var created = await CliProcess.RunAsync(workspace, home, pg, "create", "initiative", "--title", "Shared host", "--json");
			var reference = JsonNode.Parse(created.Out)!["reference"]!.GetValue<string>();
			var shown = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = reference } });

			// The host answered the first tool: an unknown entity is a domain error, not a start error.
			await Assert.That(missing["content"]![0]!["text"]!.GetValue<string>()).IsEqualTo("Entity not found: ISS_NOSUCHENTITY");
			await Assert.That(created.Exit).IsEqualTo(0).Because(created.Err);
			await Assert.That((await RunningHostAsync(home)).ProcessId).IsEqualTo(host.ProcessId);
			await Assert.That(shown["isError"]?.GetValue<bool>() ?? false).IsFalse();
			await Assert.That(mcp.Error).IsEqualTo(string.Empty);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}
}
