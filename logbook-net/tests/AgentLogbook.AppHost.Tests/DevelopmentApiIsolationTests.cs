using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using AgentLogbook.Client;
using AgentLogbook.Core.ShipyardData;
using AgentLogbook.Hosting;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;

namespace AgentLogbook.AppHost.Tests;

/// <summary>
/// Real check: the standalone AppHost starts Aspire PostgreSQL and the Development API host in a container and a process.
/// A CLI-side route made from <c>AGENT_LOGBOOK_API_URL</c> reaches that host, and the installed user state does not change.
/// The test needs a running container engine and skips without one. The application stops its own resources at the end of the test.
/// </summary>
public class DevelopmentApiIsolationTests
{
	private static readonly TimeSpan StartTimeout = TimeSpan.FromMinutes(3);

	[Test]
	[Timeout(300_000)]
	public async Task A_routed_cli_request_reaches_the_development_api_and_the_user_state_does_not_change(CancellationToken cancellationToken)
	{
		if (!await ContainerEngineAnswersAsync())
		{
			Skip.Test("No container engine answers 'docker info'.");
		}

		var userFolder = ShipyardLogbookFolder.Resolve();
		var before = Snapshot(userFolder.Path);

		var builder = await DistributedApplicationTestingBuilder.CreateAsync<Program>(cancellationToken);
		await using var app = await builder.BuildAsync(cancellationToken);
		await app.StartAsync(cancellationToken);
		await app.ResourceNotifications.WaitForResourceHealthyAsync(AgentLogbookHosting.ApiName, cancellationToken)
			.WaitAsync(StartTimeout, cancellationToken);

		var apiUrl = app.GetEndpoint(AgentLogbookHosting.ApiName, AgentLogbookHosting.ApiEndpointName);
		var devFolder = ShipyardLogbookFolder.Resolve(
			name => name == ShipyardLogbookFolder.HomeVariable ? Path.Combine(FindLogbookNetRoot(), ".agent-shipyard") : null,
			Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

		// What the development CLI process sees: only the explicit variable selects the Development API host.
		var route = await BackendRouter.ResolveAsync(
			name => name == BackendRouter.ApiUrlVariable ? apiUrl.ToString() : null,
			ShipyardLogbookFolder.Resolve(_ => Path.Combine(Path.GetTempPath(), "agent-logbook-isolation-" + Guid.NewGuid().ToString("N")), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)),
			cancellationToken: cancellationToken);

		using var client = new HttpClient { BaseAddress = route.BaseUrl };
		var ready = await client.GetAsync("/health/ready", cancellationToken);
		using var discovery = JsonDocument.Parse(await client.GetStringAsync("/.well-known/agent-logbook", cancellationToken));

		await Assert.That(route.Source).IsEqualTo(BackendRouteSource.ProcessOverride);
		await Assert.That((int)ready.StatusCode).IsEqualTo(200);
		await Assert.That(discovery.RootElement.GetProperty("auth").GetProperty("provider").GetString()).IsEqualTo("none");

		// The Development API host keeps its files in the repository-local folder and never writes a discovery file.
		await Assert.That(Directory.Exists(devFolder.Path)).IsTrue();
		await Assert.That(File.Exists(devFolder.DiscoveryFile)).IsFalse();

		// The installed user state is exactly as it was.
		await Assert.That(Snapshot(userFolder.Path)).IsEquivalentTo(before);
	}

	private static async Task<bool> ContainerEngineAnswersAsync()
	{
		try
		{
			using var process = Process.Start(new ProcessStartInfo("docker", "info") { RedirectStandardOutput = true, RedirectStandardError = true });
			if (process is null)
			{
				return false;
			}

			using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
			await process.WaitForExitAsync(timeout.Token);
			return process.ExitCode == 0;
		}
		catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or OperationCanceledException)
		{
			return false;
		}
	}

	private static string FindLogbookNetRoot()
	{
		var directory = new DirectoryInfo(AppContext.BaseDirectory);
		while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AgentLogbook.slnx")))
		{
			directory = directory.Parent;
		}

		return directory?.FullName ?? throw new InvalidOperationException("Cannot find logbook-net from the test folder.");
	}

	/// <summary>Every file of the folder with the hash of its content, so any change, addition, or removal shows.</summary>
	private static string[] Snapshot(string folder) =>
		!Directory.Exists(folder)
			? []
			: [.. Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
				.Where(file => !file.EndsWith(".write-probe", StringComparison.Ordinal) && !Path.GetFileName(file).StartsWith(".write-probe-", StringComparison.Ordinal))
				.Order(StringComparer.Ordinal)
				.Select(file => $"{file}:{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))}")];

	/// <summary>
	/// Real check: the shared composition also starts the copied site and Kanban Vite clients with pnpm. Each client proxies the paths of
	/// the Development API host to that host. The Website contract routes are not built yet, so the API answers 404 for them; a 404 that is
	/// not the HTML of the Vite page shows that the proxy reached the API. The two clients have different origins.
	/// </summary>
	[Test]
	[Timeout(600_000)]
	public async Task The_vite_clients_start_and_proxy_to_the_development_api(CancellationToken cancellationToken)
	{
		if (!await ContainerEngineAnswersAsync())
		{
			Skip.Test("No container engine answers 'docker info'.");
		}

		var builder = await DistributedApplicationTestingBuilder.CreateAsync<Program>(cancellationToken);
		await using var app = await builder.BuildAsync(cancellationToken);
		await app.StartAsync(cancellationToken);
		await app.ResourceNotifications.WaitForResourceHealthyAsync(AgentLogbookHosting.ApiName, cancellationToken)
			.WaitAsync(StartTimeout, cancellationToken);
		await app.ResourceNotifications.WaitForResourceAsync(AgentLogbookHosting.SiteName, KnownResourceStates.Running, cancellationToken)
			.WaitAsync(TimeSpan.FromMinutes(5), cancellationToken);
		await app.ResourceNotifications.WaitForResourceAsync(AgentLogbookHosting.KanbanName, KnownResourceStates.Running, cancellationToken)
			.WaitAsync(TimeSpan.FromMinutes(5), cancellationToken);

		var site = app.GetEndpoint(AgentLogbookHosting.SiteName);
		var kanban = app.GetEndpoint(AgentLogbookHosting.KanbanName);
		using var http = new HttpClient();

		await Assert.That(site.Authority).IsNotEqualTo(kanban.Authority);
		foreach (var client in new[] { site, kanban })
		{
			var page = await GetWhenServedAsync(http, new Uri(client, "/"), cancellationToken);
			await Assert.That(page).Contains("<div id=\"app\">");

			// Implemented API behavior, reached through the client origin.
			var ready = await http.GetAsync(new Uri(client, "/health/ready"), cancellationToken);
			using var discovery = JsonDocument.Parse(await http.GetStringAsync(new Uri(client, "/.well-known/agent-logbook"), cancellationToken));
			await Assert.That((int)ready.StatusCode).IsEqualTo(200);
			await Assert.That(discovery.RootElement.GetProperty("auth").GetProperty("provider").GetString()).IsEqualTo("none");

			// A route that the API does not have yet: the API says 404. An unproxied path would give the 200 page of Vite.
			var missing = await http.GetAsync(new Uri(client, "/api/not-built-yet"), cancellationToken);
			await Assert.That((int)missing.StatusCode).IsEqualTo(404);
			await Assert.That(await missing.Content.ReadAsStringAsync(cancellationToken)).DoesNotContain("<div id=\"app\">");
		}
	}

	private static async Task<string> GetWhenServedAsync(HttpClient http, Uri uri, CancellationToken cancellationToken)
	{
		// "Running" means the process started. Vite binds its port a moment later.
		for (var attempt = 0; ; attempt++)
		{
			try
			{
				return await http.GetStringAsync(uri, cancellationToken);
			}
			catch (HttpRequestException) when (attempt < 60)
			{
				await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
			}
		}
	}
}
