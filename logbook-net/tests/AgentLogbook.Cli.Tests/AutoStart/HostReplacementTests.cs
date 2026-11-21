using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using AgentLogbook.Cli.Tests.Serve;
using AgentLogbook.Client;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.AutoStart;

/// <summary>
/// A local storage request that finds a host of another tool version waits for the active requests of that host, stops it, and uses one
/// replacement. The old host is a process of another version that the test controls; the replacement is the real <c>serve</c> process.
/// </summary>
[NotInParallel]
public class HostReplacementTests
{
	private const string OldVersion = "0.0.1-old";

	private static string NewHome() => Directory.CreateTempSubdirectory("replace-shipyard-").FullName;

	private static LocalApiLaunch RealLaunch(string? version = null) => new(
		Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet",
		[Path.Combine(AppContext.BaseDirectory, "AgentLogbook.Cli.dll"), "serve"],
		version ?? CliApp.Version);

	private static Func<string, string?> LocalSettings(string pg) => name => name == LocalPostgresSelection.UrlVariable ? pg : null;

	private static Task<BackendRoute> ResolveAsync(ShipyardLogbookFolder folder, string pg, LocalApiLaunch launch) =>
		BackendRouter.ResolveAsync(LocalSettings(pg), folder, autoStart: launch);

	private static bool IsAlive(int processId)
	{
		try
		{
			using var process = Process.GetProcessById(processId);
			return !process.HasExited;
		}
		catch (ArgumentException)
		{
			return false;
		}
	}

	/// <summary>
	/// A host of another version: a real process that the discovery file names, with an HTTP listener that answers like the Local API host.
	/// A stop request is accepted only after every active <c>/slow</c> request has finished, like the drain of the real host.
	/// </summary>
	private sealed class OldHost : IAsyncDisposable
	{
		private readonly Process process = Process.Start(new ProcessStartInfo("sleep", "300") { UseShellExecute = false })!;
		private readonly HttpListener listener = new();
		private readonly HttpClient client = new();
		private readonly ShipyardLogbookFolder folder;
		private readonly TaskCompletionSource releaseSlow = new(TaskCreationOptions.RunContinuationsAsynchronously);
		private readonly TaskCompletionSource slowStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
		private readonly bool refuseStop;
		private int active;
		private int stopRequests;

		public OldHost(ShipyardLogbookFolder folder, bool refuseStop = false)
		{
			this.folder = folder.EnsureExists();
			this.refuseStop = refuseStop;
			using var socket = new TcpListener(IPAddress.Loopback, 0);
			socket.Start();
			var port = ((IPEndPoint)socket.LocalEndpoint).Port;
			socket.Stop();
			Url = $"http://127.0.0.1:{port}";
			listener.Prefixes.Add($"{Url}/");
			listener.Start();
			Discovery = new LocalApiDiscovery(Url, port, process.Id, OldVersion, DateTimeOffset.UtcNow);
			Discovery.Write(folder);
			_ = Task.Run(ServeAsync);
		}

		public string Url { get; }

		public LocalApiDiscovery Discovery { get; }

		public int ProcessId => process.Id;

		public int StopRequests => Volatile.Read(ref stopRequests);

		/// <summary>Starts one request and returns it after the host has accepted it. The request stays active until <see cref="ReleaseSlow"/>.</summary>
		public async Task<Task<HttpResponseMessage>> BeginSlowRequestAsync()
		{
			var request = client.GetAsync($"{Url}/slow");
			await slowStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
			return request;
		}

		public void ReleaseSlow() => releaseSlow.TrySetResult();

		private async Task ServeAsync()
		{
			while (listener.IsListening)
			{
				HttpListenerContext context;
				try
				{
					context = await listener.GetContextAsync();
				}
				catch (Exception exception) when (exception is HttpListenerException or ObjectDisposedException)
				{
					return;
				}

				_ = Task.Run(() => HandleAsync(context));
			}
		}

		private async Task HandleAsync(HttpListenerContext context)
		{
			var path = context.Request.Url!.AbsolutePath;
			if (path == "/slow")
			{
				Interlocked.Increment(ref active);
				slowStarted.TrySetResult();
				await releaseSlow.Task;
				await Reply(context, 200, "{\"finished\":true}");
				Interlocked.Decrement(ref active);
			}
			else if (path == "/health/live")
			{
				await Reply(context, 200, "{}");
			}
			else if (path == "/local/host" && context.Request.HttpMethod == "GET")
			{
				await Reply(context, 200, $"{{\"processId\":{process.Id},\"toolVersion\":\"{OldVersion}\"}}");
			}
			else if (path == "/local/host/stop")
			{
				Interlocked.Increment(ref stopRequests);
				if (refuseStop)
				{
					await Reply(context, 500, "{}");
					return;
				}

				await Reply(context, 202, "{}");
				Discovery.MarkStopping(folder);
				_ = Task.Run(DrainAndEndAsync);
			}
			else
			{
				await Reply(context, 404, "{}");
			}
		}

		private async Task DrainAndEndAsync()
		{
			while (Volatile.Read(ref active) > 0)
			{
				await Task.Delay(20);
			}

			EndProcess();
			Discovery.RemoveIfCurrent(folder);
		}

		private static async Task Reply(HttpListenerContext context, int status, string body)
		{
			var bytes = Encoding.UTF8.GetBytes(body);
			context.Response.StatusCode = status;
			context.Response.ContentType = "application/json";
			await context.Response.OutputStream.WriteAsync(bytes);
			context.Response.Close();
		}

		private void EndProcess()
		{
			try
			{
				process.Kill();
				process.WaitForExit();
			}
			catch (InvalidOperationException)
			{
				// It ended already.
			}
		}

		public ValueTask DisposeAsync()
		{
			releaseSlow.TrySetResult();
			listener.Close();
			client.Dispose();
			EndProcess();
			process.Dispose();
			return ValueTask.CompletedTask;
		}
	}

	[Test]
	public async Task A_request_waits_for_the_active_request_of_a_host_of_another_version_then_uses_one_replacement()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home);
			await using var old = new OldHost(folder);
			var inFlight = await old.BeginSlowRequestAsync();

			var resolving = ResolveAsync(folder, pg, RealLaunch());
			var waiting = Stopwatch.StartNew();
			while (old.StopRequests == 0 && waiting.Elapsed < TimeSpan.FromSeconds(30))
			{
				await Task.Delay(20);
			}

			await Task.Delay(TimeSpan.FromSeconds(1));

			await Assert.That(resolving.IsCompleted).IsFalse();
			await Assert.That(IsAlive(old.ProcessId)).IsTrue();
			await Assert.That(old.StopRequests).IsEqualTo(1);

			old.ReleaseSlow();
			var route = await resolving.WaitAsync(TimeSpan.FromSeconds(90));
			using var answer = await inFlight;

			await Assert.That((int)answer.StatusCode).IsEqualTo(200);
			await Assert.That(await answer.Content.ReadAsStringAsync()).IsEqualTo("{\"finished\":true}");
			var replacement = LocalApiDiscovery.Read(folder)!;
			await Assert.That(replacement.ToolVersion).IsEqualTo(CliApp.Version);
			await Assert.That(replacement.ProcessId).IsNotEqualTo(old.ProcessId);
			await Assert.That(IsAlive(old.ProcessId)).IsFalse();
			await Assert.That(route.BaseUrl).IsEqualTo(new Uri(replacement.Url));
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task Concurrent_requests_stop_the_old_host_once_and_start_one_replacement()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home);
			await using var old = new OldHost(folder);

			var routes = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => ResolveAsync(folder, pg, RealLaunch())));

			var replacement = LocalApiDiscovery.Read(folder)!;
			await Assert.That(routes.Select(route => route.BaseUrl).Distinct().Count()).IsEqualTo(1);
			await Assert.That(routes[0].BaseUrl).IsEqualTo(new Uri(replacement.Url));
			await Assert.That(replacement.ToolVersion).IsEqualTo(CliApp.Version);
			await Assert.That(old.StopRequests).IsEqualTo(1);
			await Task.Delay(TimeSpan.FromSeconds(2));
			var started = File.ReadAllLines(folder.LogFile).Count(line => line.StartsWith("Local API host ", StringComparison.Ordinal));
			await Assert.That(started).IsEqualTo(1);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task A_host_of_the_same_version_keeps_running_and_is_used()
	{
		var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await using var host = ServeProcess.Start(ServeProcess.NewShipyardHome(), pg);
		var before = await host.WaitForDiscoveryAsync();
		await Assert.That(before).IsNotNull();

		// A launch that cannot start anything proves that the request does not start a host.
		var route = await ResolveAsync(host.Folder, pg, new LocalApiLaunch("/bin/false", [], CliApp.Version));

		await Assert.That(route.BaseUrl).IsEqualTo(new Uri(before!.Url));
		await Assert.That(LocalApiDiscovery.Read(host.Folder)).IsEqualTo(before);
		await Assert.That(host.HasExited).IsFalse();
	}

	[Test]
	public async Task A_host_that_refuses_to_stop_is_reported_and_is_not_used()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home);
			await using var old = new OldHost(folder, refuseStop: true);

			var exception = await Assert.That(async () => await ResolveAsync(folder, pg, RealLaunch())).Throws<LocalApiUnavailableException>();

			await Assert.That(exception!.Message).Contains($"version {OldVersion}").And.Contains($"version {CliApp.Version}").And.Contains("was not replaced");
			await Assert.That(IsAlive(old.ProcessId)).IsTrue();
			await Assert.That(LocalApiDiscovery.Read(folder)).IsEqualTo(old.Discovery);
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}

	[Test]
	public async Task A_replacement_that_does_not_start_is_reported_and_the_old_host_is_not_used()
	{
		var home = NewHome();
		try
		{
			var pg = await LocalPostgresServer.CreateDatabaseUrlAsync();
			var folder = CliProcess.Folder(home);
			await using var old = new OldHost(folder);
			var failing = new LocalApiLaunch("/bin/sh", ["-c", "echo 'no replacement' >&2; exit 3"], CliApp.Version);

			var exception = await Assert.That(async () => await ResolveAsync(folder, pg, failing)).Throws<LocalApiUnavailableException>();

			await Assert.That(exception!.Message).StartsWith("The Local API host did not start.").And.Contains("no replacement");
			await Assert.That(IsAlive(old.ProcessId)).IsFalse();
			await Assert.That(LocalApiDiscovery.Read(folder)).IsNull();
		}
		finally
		{
			await CliProcess.StopHostAndCleanAsync(home);
		}
	}
}
