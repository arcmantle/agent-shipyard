using System.Net;
using System.Net.Sockets;
using AgentLogbook.Api;
using AgentLogbook.Api.Auth;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;
using Npgsql;

namespace AgentLogbook.Client.Tests;

public class BackendRouterTests
{
	private static ShipyardLogbookFolder NewFolder()
	{
		var home = Directory.CreateTempSubdirectory("router-").FullName;
		return ShipyardLogbookFolder.Resolve(name => name == ShipyardLogbookFolder.HomeVariable ? home : null, home).EnsureExists();
	}

	private static LocalApiDiscovery Discovery(Uri url, int processId) =>
		new(url.GetLeftPart(UriPartial.Authority), url.Port, processId, "1.0.0", DateTimeOffset.UtcNow);

	/// <summary>Every file of the folder with its content and write time: the saved state that a route must not change.</summary>
	private static string[] Snapshot(string folder) =>
		[.. Directory.EnumerateFileSystemEntries(folder, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
			.Select(path => File.Exists(path)
				? $"{path}|{File.GetLastWriteTimeUtc(path).Ticks}|{File.ReadAllText(path)}"
				: $"{path}|dir")];

	private static int FreePort()
	{
		using var listener = new TcpListener(IPAddress.Loopback, 0);
		listener.Start();
		return ((IPEndPoint)listener.LocalEndpoint).Port;
	}

	[Test]
	public async Task The_override_wins_without_a_token_and_leaves_discovery_and_saved_state_alone()
	{
		var folder = NewFolder();
		var other = Discovery(new Uri("http://127.0.0.1:5999"), Environment.ProcessId);
		other.Write(folder);
		File.WriteAllText(Path.Combine(folder.Path, "saved-login.json"), """{"active":"local"}""");
		var before = Snapshot(folder.Path);

		var route = await BackendRouter.ResolveAsync(
			name => name == BackendRouter.ApiUrlVariable ? " http://127.0.0.1:6000 " : null, folder);

		await Assert.That(route).IsEqualTo(new BackendRoute(new Uri("http://127.0.0.1:6000"), null, BackendRouteSource.ProcessOverride));
		await Assert.That(Snapshot(folder.Path)).IsEquivalentTo(before);
		await Assert.That(LocalApiDiscovery.Read(folder)).IsEqualTo(other);
	}

	[Test]
	public async Task The_override_does_not_need_a_discovery_file_or_a_host_that_answers()
	{
		var folder = NewFolder();

		var route = await BackendRouter.ResolveAsync(
			name => name == BackendRouter.ApiUrlVariable ? "https://logbook.example.com" : null, folder);

		await Assert.That(route.Source).IsEqualTo(BackendRouteSource.ProcessOverride);
		await Assert.That(Directory.GetFileSystemEntries(folder.Path)).IsEmpty();
	}

	[Test]
	[Arguments("not a url")]
	[Arguments("/relative")]
	[Arguments("ftp://example.com")]
	public async Task An_override_that_is_not_an_http_url_is_rejected_and_does_not_fall_back_to_local(string value)
	{
		await Assert.That(async () => await BackendRouter.ResolveAsync(
				name => name == BackendRouter.ApiUrlVariable ? value : null, NewFolder()))
			.Throws<InvalidBackendRouteException>();
	}

	[Test]
	public async Task A_blank_override_is_the_same_as_none()
	{
		await Assert.That(async () => await BackendRouter.ResolveAsync(
				name => name == BackendRouter.ApiUrlVariable ? "  " : null, NewFolder()))
			.Throws<LocalApiUnavailableException>();
	}

	[Test]
	public async Task The_default_local_login_uses_the_host_of_the_discovery_file_when_it_answers_its_live_check()
	{
		var folder = NewFolder();
		await using var host = await ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = LocalNoAuthProvider.Enable("tester"),
			DataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Username=u;Password=p;Database=d;Timeout=2;Pooling=false"),
			ToolVersion = "1.0.0",
			ListenAddress = IPAddress.Loopback,
		});
		Discovery(host.Url, Environment.ProcessId).Write(folder);
		var before = Snapshot(folder.Path);

		var route = await BackendRouter.ResolveAsync(_ => null, folder);

		await Assert.That(route.Source).IsEqualTo(BackendRouteSource.LocalLogin);
		await Assert.That(route.BearerToken).IsNull();
		await Assert.That(route.BaseUrl).IsEqualTo(new Uri(host.Url.GetLeftPart(UriPartial.Authority)));
		await Assert.That(Snapshot(folder.Path)).IsEquivalentTo(before);
	}

	[Test]
	public async Task The_local_login_routes_requests_to_the_foreground_host_without_credentials()
	{
		var folder = NewFolder();
		await using var server = await RpcTestServer.StartAsync();
		Discovery(server.Url, Environment.ProcessId).Write(folder);

		var route = await BackendRouter.ResolveAsync(_ => null, folder);
		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = route.BaseUrl, BearerToken = route.BearerToken });
		await store.CallAsync("getEntityDetails");

		await Assert.That(server.Requests.Single().Headers.ContainsKey("authorization")).IsFalse();
	}

	[Test]
	public async Task A_missing_discovery_file_says_that_no_host_runs_and_how_to_start_one()
	{
		var exception = await Assert.That(async () => await BackendRouter.ResolveAsync(_ => null, NewFolder()))
			.Throws<LocalApiUnavailableException>();

		await Assert.That(exception!.Message).Contains("No Local API host is running").And.Contains("agent-logbook serve");
	}

	[Test]
	public async Task A_discovery_file_of_a_dead_process_is_not_a_host_and_is_left_in_place()
	{
		var folder = NewFolder();
		var stale = Discovery(new Uri("http://127.0.0.1:5999"), int.MaxValue);
		stale.Write(folder);

		await Assert.That(async () => await BackendRouter.ResolveAsync(_ => null, folder)).Throws<LocalApiUnavailableException>();

		await Assert.That(LocalApiDiscovery.Read(folder)).IsEqualTo(stale);
	}

	[Test]
	public async Task A_live_process_whose_host_does_not_answer_is_an_explicit_failure()
	{
		var folder = NewFolder();
		Discovery(new Uri($"http://127.0.0.1:{FreePort()}"), Environment.ProcessId).Write(folder);

		var exception = await Assert.That(async () => await BackendRouter.ResolveAsync(_ => null, folder))
			.Throws<LocalApiUnavailableException>();

		await Assert.That(exception!.Message).Contains("does not answer");
	}

	[Test]
	public async Task A_host_that_answers_its_live_check_with_an_error_is_an_explicit_failure()
	{
		var folder = NewFolder();
		using var listener = new HttpListener();
		var port = FreePort();
		listener.Prefixes.Add($"http://127.0.0.1:{port}/");
		listener.Start();
		var serving = Task.Run(async () =>
		{
			var context = await listener.GetContextAsync();
			context.Response.StatusCode = 503;
			context.Response.Close();
		});
		Discovery(new Uri($"http://127.0.0.1:{port}"), Environment.ProcessId).Write(folder);

		var exception = await Assert.That(async () => await BackendRouter.ResolveAsync(_ => null, folder))
			.Throws<LocalApiUnavailableException>();
		await serving;

		await Assert.That(exception!.Message).Contains("HTTP 503");
	}
}
