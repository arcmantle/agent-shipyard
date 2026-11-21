using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using AgentLogbook.Cli.Tests.AutoStart;
using AgentLogbook.Cli.Tests.Serve;
using AgentLogbook.Core.LocalApi;

namespace AgentLogbook.Cli.Tests.Host;

/// <summary>
/// <c>agent-logbook host status|stop|restart</c> as real processes against a real PostgreSQL server. Each test owns one Shipyard data folder
/// and touches only the processes that it started itself.
/// </summary>
[NotInParallel]
public class HostCommandTests
{
	private static string NewWorkspace() => Directory.CreateTempSubdirectory("logbook-host-workspace-").FullName;

	private static Task<(int Exit, string Out, string Err)> HostAsync(string home, string? pg, params string[] args) =>
		CliProcess.RunAsync(NewWorkspace(), home, pg, ["host", .. args]);

	private static JsonElement Json(string text) => JsonElement.Parse(text);

	private static async Task<ServeProcess> StartHostAsync(string pg)
	{
		var process = ServeProcess.Start(ServeProcess.NewShipyardHome(), pg);
		await Assert.That(await process.WaitForDiscoveryAsync()).IsNotNull();
		return process;
	}

	private static void WriteDiscovery(string home, Uri url, int processId, DateTimeOffset startedAt)
	{
		var folder = CliProcess.Folder(home).EnsureExists();
		new LocalApiDiscovery(url.GetLeftPart(UriPartial.Authority), url.Port, processId, CliApp.Version, startedAt).Write(folder);
	}

	private static int FreePort()
	{
		using var listener = new TcpListener(IPAddress.Loopback, 0);
		listener.Start();
		return ((IPEndPoint)listener.LocalEndpoint).Port;
	}

	/// <summary>A process that is not a Local API host: a long sleep.</summary>
	private static Process StartUnrelatedProcess() =>
		Process.Start(new ProcessStartInfo("sleep", "300") { UseShellExecute = false })!;

	private static async Task WaitUntilGoneAsync(int processId)
	{
		var clock = Stopwatch.StartNew();
		while (clock.Elapsed < TimeSpan.FromSeconds(30))
		{
			try
			{
				using var process = Process.GetProcessById(processId);
				if (process.HasExited)
				{
					return;
				}
			}
			catch (ArgumentException)
			{
				return;
			}

			await Task.Delay(50);
		}

		throw new TimeoutException($"Process {processId} is still running.");
	}

	[Test]
	public async Task Status_of_a_stopped_host_starts_nothing()
	{
		var home = ServeProcess.NewShipyardHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();

			var human = await HostAsync(home, pg, "status");
			var json = await HostAsync(home, pg, "status", "--json");

			await Assert.That(human).IsEqualTo((0, "No Local API host is running.\n", string.Empty));
			await Assert.That(json.Exit).IsEqualTo(0);
			await Assert.That(json.Out).IsEqualTo("{\"command\":\"host\",\"action\":\"status\",\"state\":\"stopped\"}\n");
			await Assert.That(LocalApiDiscovery.Read(CliProcess.Folder(home))).IsNull();
			await Assert.That(File.Exists(CliProcess.Folder(home).LogFile)).IsFalse();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task Status_of_a_running_host_reports_the_facts_of_the_discovery_file()
	{
		await using var host = await StartHostAsync(await LocalPostgresServer.CreateDatabaseUrlAsync());
		var discovery = LocalApiDiscovery.Read(host.Folder)!;

		var human = await HostAsync(host.ShipyardHome, null, "status");
		var json = await HostAsync(host.ShipyardHome, null, "status", "--json");

		await Assert.That(human.Exit).IsEqualTo(0).Because(human.Err);
		await Assert.That(human.Out).StartsWith($"Local API host running at {discovery.Url} (process {discovery.ProcessId}, version {CliApp.Version}, started ");
		var status = Json(json.Out);
		await Assert.That(status.GetProperty("state").GetString()).IsEqualTo("running");
		await Assert.That(status.GetProperty("url").GetString()).IsEqualTo(discovery.Url);
		await Assert.That(status.GetProperty("port").GetInt32()).IsEqualTo(discovery.Port);
		await Assert.That(status.GetProperty("processId").GetInt32()).IsEqualTo(discovery.ProcessId);
		await Assert.That(status.GetProperty("toolVersion").GetString()).IsEqualTo(CliApp.Version);
		await Assert.That(DateTimeOffset.Parse(status.GetProperty("startedAt").GetString()!, System.Globalization.CultureInfo.InvariantCulture)).IsEqualTo(discovery.StartedAt);
		await Assert.That(LocalApiDiscovery.Read(host.Folder)).IsEqualTo(discovery);
	}

	[Test]
	public async Task Stop_lets_an_active_request_finish_then_ends_the_host_and_a_repeated_stop_changes_nothing()
	{
		var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await using var host = await StartHostAsync(pg);
		var discovery = LocalApiDiscovery.Read(host.Folder)!;

		using var client = new HttpClient();
		using var query = new StringContent("{\"statement\":\"SELECT pg_sleep(4), 1 AS one\"}", Encoding.UTF8, "application/json");
		var inFlight = client.PostAsync(new Uri(new Uri(discovery.Url), "/direct-query"), query);
		await Task.Delay(1000);

		var stopClock = Stopwatch.StartNew();
		var stop = await HostAsync(host.ShipyardHome, null, "stop");
		stopClock.Stop();
		var answer = await inFlight;
		var body = await answer.Content.ReadAsStringAsync();

		await Assert.That(stop).IsEqualTo((0, $"Stopped the Local API host (process {discovery.ProcessId}).\n", string.Empty));
		await Assert.That(stopClock.Elapsed).IsLessThan(TimeSpan.FromSeconds(20));
		await Assert.That((int)answer.StatusCode).IsEqualTo(200).Because(body);
		await Assert.That(Json(body).GetProperty("rows")[0].GetProperty("one").GetInt32()).IsEqualTo(1);
		await Assert.That(await host.WaitForExitAsync()).IsEqualTo(0);
		await Assert.That(LocalApiDiscovery.Read(host.Folder)).IsNull();

		var again = await HostAsync(host.ShipyardHome, null, "stop", "--json");
		var status = await HostAsync(host.ShipyardHome, null, "status");

		await Assert.That(again.Exit).IsEqualTo(0).Because(again.Err);
		await Assert.That(again.Out).IsEqualTo("{\"command\":\"host\",\"action\":\"stop\",\"state\":\"stopped\"}\n");
		await Assert.That(status.Out).IsEqualTo("No Local API host is running.\n");
	}

	[Test]
	public async Task While_a_stopped_host_drains_status_says_stopping_and_a_repeated_stop_waits_for_the_same_end()
	{
		var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await using var host = await StartHostAsync(pg);
		var discovery = LocalApiDiscovery.Read(host.Folder)!;

		using var client = new HttpClient();
		using var query = new StringContent("{\"statement\":\"SELECT pg_sleep(6), 1 AS one\"}", Encoding.UTF8, "application/json");
		var inFlight = client.PostAsync(new Uri(new Uri(discovery.Url), "/direct-query"), query);
		await Task.Delay(1000);

		var firstStop = HostAsync(host.ShipyardHome, null, "stop");
		var clock = Stopwatch.StartNew();
		while (LocalApiDiscovery.Read(host.Folder) is not { Stopping: true } && clock.Elapsed < TimeSpan.FromSeconds(10))
		{
			await Task.Delay(50);
		}

		var status = await HostAsync(host.ShipyardHome, null, "status", "--json");
		var secondStop = await HostAsync(host.ShipyardHome, null, "stop");
		var restart = await HostAsync(host.ShipyardHome, pg, "restart");
		var first = await firstStop;
		using var answer = await inFlight;

		await Assert.That(status.Exit).IsEqualTo(0).Because(status.Err);
		await Assert.That(Json(status.Out).GetProperty("state").GetString()).IsEqualTo("stopping");
		await Assert.That(secondStop.Exit).IsEqualTo(0).Because(secondStop.Err);
		await Assert.That(secondStop.Out).IsEqualTo($"Stopped the Local API host (process {discovery.ProcessId}).\n");
		await Assert.That(first.Exit).IsEqualTo(0).Because(first.Err);
		await Assert.That((int)answer.StatusCode).IsEqualTo(200);

		// The restart ran after the drain ended, so it started exactly one replacement.
		await Assert.That(restart.Exit).IsEqualTo(0).Because(restart.Err);
		var replacement = LocalApiDiscovery.Read(host.Folder);
		await Assert.That(replacement).IsNotNull();
		await Assert.That(replacement!.ProcessId).IsNotEqualTo(discovery.ProcessId);
		await HostAsync(host.ShipyardHome, null, "stop");
	}

	[Test]
	public async Task Stopping_an_idle_host_returns_promptly()
	{
		await using var host = await StartHostAsync(await LocalPostgresServer.CreateDatabaseUrlAsync());
		var clock = Stopwatch.StartNew();

		var stop = await HostAsync(host.ShipyardHome, null, "stop");

		await Assert.That(stop.Exit).IsEqualTo(0).Because(stop.Err);
		await Assert.That(clock.Elapsed).IsLessThan(TimeSpan.FromSeconds(15));
	}

	[Test]
	public async Task Restart_replaces_the_host_each_time_and_starts_one_when_none_runs()
	{
		var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await using var first = await StartHostAsync(pg);
		var home = first.ShipyardHome;
		var firstId = LocalApiDiscovery.Read(first.Folder)!.ProcessId;
		try
		{
			var one = await HostAsync(home, pg, "restart", "--json");
			var second = LocalApiDiscovery.Read(first.Folder)!;
			var two = await HostAsync(home, pg, "restart", "--json");
			var third = LocalApiDiscovery.Read(first.Folder)!;

			await Assert.That(one.Exit).IsEqualTo(0).Because(one.Err);
			await Assert.That(Json(one.Out).GetProperty("state").GetString()).IsEqualTo("running");
			await Assert.That(Json(one.Out).GetProperty("stoppedProcessId").GetInt32()).IsEqualTo(firstId);
			await Assert.That(Json(one.Out).GetProperty("processId").GetInt32()).IsEqualTo(second.ProcessId);
			await Assert.That(second.ProcessId).IsNotEqualTo(firstId);
			await Assert.That(first.HasExited).IsTrue();
			await Assert.That(two.Exit).IsEqualTo(0).Because(two.Err);
			await Assert.That(Json(two.Out).GetProperty("stoppedProcessId").GetInt32()).IsEqualTo(second.ProcessId);
			await Assert.That(third.ProcessId).IsNotEqualTo(second.ProcessId);
			await Assert.That(third.IsProcessAlive()).IsTrue();
			await WaitUntilGoneAsync(second.ProcessId);

			var stopped = await HostAsync(home, pg, "stop");
			var fresh = await HostAsync(home, pg, "restart");

			await Assert.That(stopped.Exit).IsEqualTo(0).Because(stopped.Err);
			await Assert.That(fresh.Exit).IsEqualTo(0).Because(fresh.Err);
			await Assert.That(fresh.Out).StartsWith("No Local API host was running. Local API host running at ");
			await Assert.That(LocalApiDiscovery.Read(first.Folder)!.IsProcessAlive()).IsTrue();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task The_stale_file_of_an_ended_host_is_reported_and_stop_and_restart_deal_with_it()
	{
		var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await using var host = await StartHostAsync(pg);
		var home = host.ShipyardHome;
		var discovery = LocalApiDiscovery.Read(host.Folder)!;
		using (var kill = Process.Start("kill", ["-KILL", discovery.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)])!)
		{
			await kill.WaitForExitAsync();
		}

		await host.WaitForExitAsync();
		try
		{
			var status = await HostAsync(home, pg, "status", "--json");
			var stop = await HostAsync(home, pg, "stop");

			await Assert.That(status.Exit).IsEqualTo(1);
			await Assert.That(Json(status.Out).GetProperty("state").GetString()).IsEqualTo("stale");
			await Assert.That(Json(status.Out).GetProperty("processId").GetInt32()).IsEqualTo(discovery.ProcessId);
			await Assert.That(Json(status.Out).GetProperty("reason").GetString()).Contains("which is not running");
			await Assert.That(stop.Exit).IsEqualTo(0).Because(stop.Err);
			await Assert.That(stop.Out).StartsWith("No Local API host is running. The discovery file names process");
			await Assert.That(LocalApiDiscovery.Read(host.Folder)).IsEqualTo(discovery);

			var restart = await HostAsync(home, pg, "restart", "--json");

			await Assert.That(restart.Exit).IsEqualTo(0).Because(restart.Err);
			await Assert.That(LocalApiDiscovery.Read(host.Folder)!.ProcessId).IsNotEqualTo(discovery.ProcessId);
			await Assert.That((await HostAsync(home, pg, "status")).Exit).IsEqualTo(0);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task An_unrelated_process_that_holds_the_discovery_file_is_neither_stopped_nor_adopted()
	{
		var home = ServeProcess.NewShipyardHome();
		using var unrelated = StartUnrelatedProcess();
		try
		{
			// The process runs, and nothing answers at the URL of the file.
			WriteDiscovery(home, new Uri($"http://127.0.0.1:{FreePort()}"), unrelated.Id, DateTimeOffset.UtcNow);
			var before = File.ReadAllBytes(CliProcess.Folder(home).DiscoveryFile);

			var status = await HostAsync(home, null, "status", "--json");
			var stop = await HostAsync(home, null, "stop", "--json");
			var restart = await HostAsync(home, null, "restart", "--json");

			await Assert.That(status.Exit).IsEqualTo(1);
			await Assert.That(Json(status.Out).GetProperty("state").GetString()).IsEqualTo("stale");
			await Assert.That(Json(status.Out).GetProperty("reason").GetString()).Contains("nothing at").And.Contains("answers as that Local API host");
			foreach (var failed in new[] { stop, restart })
			{
				await Assert.That(failed.Exit).IsEqualTo(1);
				await Assert.That(failed.Out).IsEmpty();
				await Assert.That(Json(failed.Err).GetProperty("error").GetString()).Contains($"Process {unrelated.Id} is running").And.Contains("is not touched");
			}

			await Assert.That(unrelated.HasExited).IsFalse();
			await Assert.That(File.ReadAllBytes(CliProcess.Folder(home).DiscoveryFile)).IsEquivalentTo(before);
		}
		finally
		{
			unrelated.Kill();
			await unrelated.WaitForExitAsync();
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task A_service_that_answers_as_another_process_is_not_the_host()
	{
		var home = ServeProcess.NewShipyardHome();
		using var unrelated = StartUnrelatedProcess();
		var port = FreePort();
		using var listener = new HttpListener();
		listener.Prefixes.Add($"http://127.0.0.1:{port}/");
		listener.Start();
		var stopRequests = 0;
		var serving = ServeAsync(listener, unrelated.Id + 1, () => stopRequests++);
		try
		{
			WriteDiscovery(home, new Uri($"http://127.0.0.1:{port}"), unrelated.Id, DateTimeOffset.UtcNow);

			var status = await HostAsync(home, null, "status", "--json");
			var stop = await HostAsync(home, null, "stop");

			await Assert.That(Json(status.Out).GetProperty("state").GetString()).IsEqualTo("stale");
			await Assert.That(stop.Exit).IsEqualTo(1);
			await Assert.That(stop.Err).StartsWith("agent-logbook host: Process").And.Contains("is not touched");
			await Assert.That(stopRequests).IsEqualTo(0);
			await Assert.That(unrelated.HasExited).IsFalse();
		}
		finally
		{
			listener.Close();
			await serving;
			unrelated.Kill();
			await unrelated.WaitForExitAsync();
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task A_host_that_refuses_the_stop_request_is_reported_and_its_process_keeps_running()
	{
		var home = ServeProcess.NewShipyardHome();
		using var unrelated = StartUnrelatedProcess();
		var port = FreePort();
		using var listener = new HttpListener();
		listener.Prefixes.Add($"http://127.0.0.1:{port}/");
		listener.Start();
		var stopRequests = 0;
		var serving = ServeAsync(listener, unrelated.Id, () => stopRequests++);
		try
		{
			WriteDiscovery(home, new Uri($"http://127.0.0.1:{port}"), unrelated.Id, DateTimeOffset.UtcNow);

			var status = await HostAsync(home, null, "status", "--json");
			var stop = await HostAsync(home, null, "stop");
			var restart = await HostAsync(home, null, "restart");

			await Assert.That(Json(status.Out).GetProperty("state").GetString()).IsEqualTo("running");
			foreach (var failed in new[] { stop, restart })
			{
				await Assert.That(failed.Exit).IsEqualTo(1);
				await Assert.That(failed.Out).IsEmpty();
				await Assert.That(failed.Err).StartsWith("agent-logbook host: The Local API host at").And.Contains($"(process {unrelated.Id}) refused the stop request with HTTP 500");
			}

			await Assert.That(stopRequests).IsEqualTo(2);
			await Assert.That(unrelated.HasExited).IsFalse();
		}
		finally
		{
			listener.Close();
			await serving;
			unrelated.Kill();
			await unrelated.WaitForExitAsync();
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task The_command_rejects_a_missing_or_unknown_action_and_describes_itself_in_help()
	{
		var home = ServeProcess.NewShipyardHome();
		try
		{
			var missing = await HostAsync(home, null);
			var unknown = await HostAsync(home, null, "pause", "--json");
			var extra = await HostAsync(home, null, "status", "now");
			var help = await HostAsync(home, null, "--help");

			foreach (var rejected in new[] { missing, extra })
			{
				await Assert.That(rejected.Exit).IsEqualTo(1);
				await Assert.That(rejected.Out).IsEmpty();
				await Assert.That(rejected.Err).IsEqualTo("agent-logbook host: Missing or unknown action. Usage: host <status|stop|restart>\n");
			}

			await Assert.That(unknown.Exit).IsEqualTo(1);
			await Assert.That(Json(unknown.Err).GetProperty("error").GetString()).IsEqualTo("Missing or unknown action. Usage: host <status|stop|restart>");
			await Assert.That(help.Exit).IsEqualTo(0);
			await Assert.That(help.Out).Contains("agent-logbook host <status|stop|restart>").And.Contains("allowed: status, stop, restart");
			await Assert.That(LocalApiDiscovery.Read(CliProcess.Folder(home))).IsNull();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	/// <summary>A host that answers the identity path as <paramref name="reportedProcessId"/> and refuses every stop request with HTTP 500.</summary>
	private static async Task ServeAsync(HttpListener listener, int reportedProcessId, Action onStopRequest)
	{
		while (listener.IsListening)
		{
			HttpListenerContext context;
			try
			{
				context = await listener.GetContextAsync();
			}
			catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException or InvalidOperationException)
			{
				return;
			}

			if (context.Request.HttpMethod == "POST")
			{
				onStopRequest();
				context.Response.StatusCode = 500;
			}
			else
			{
				var bytes = Encoding.UTF8.GetBytes($"{{\"processId\":{reportedProcessId},\"toolVersion\":\"x\"}}");
				context.Response.ContentType = "application/json";
				await context.Response.OutputStream.WriteAsync(bytes);
			}

			context.Response.Close();
		}
	}
}
