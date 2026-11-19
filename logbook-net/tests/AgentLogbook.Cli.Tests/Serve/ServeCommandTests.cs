using System.Net;
using System.Net.NetworkInformation;

namespace AgentLogbook.Cli.Tests.Serve;

[NotInParallel]
public class ServeCommandTests
{
	private static async Task<(ServeProcess Process, AgentLogbook.Core.LocalApi.LocalApiDiscovery Discovery)> StartHostAsync(
		params (string Name, string Value)[] extraEnvironment)
	{
		var url = await LocalPostgresServer.CreateDatabaseUrlAsync();
		var process = ServeProcess.Start(ServeProcess.NewShipyardHome(), url, extraEnvironment);
		var discovery = await process.WaitForDiscoveryAsync();
		await Assert.That(discovery).IsNotNull();
		return (process, discovery!);
	}

	[Test]
	public async Task Serve_publishes_discovery_and_answers_health_and_discovery_on_the_loopback_url()
	{
		var (process, discovery) = await StartHostAsync();
		await using var _ = process;

		await Assert.That(discovery.Url).IsEqualTo($"http://127.0.0.1:{discovery.Port}");
		await Assert.That(discovery.Port).IsGreaterThan(0);
		await Assert.That(discovery.ProcessId).IsEqualTo(process.ProcessId);
		await Assert.That(discovery.ToolVersion).IsEqualTo(CliApp.Version);
		await Assert.That(DateTimeOffset.UtcNow - discovery.StartedAt).IsLessThan(TimeSpan.FromMinutes(2));

		var live = await ServeProcess.GetJsonAsync(discovery.Url + "/health/live", 200);
		var ready = await ServeProcess.GetJsonAsync(discovery.Url + "/health/ready", 200);
		var service = await ServeProcess.GetJsonAsync(discovery.Url + "/.well-known/agent-logbook", 200);

		await Assert.That(live.GetProperty("status").GetString()).IsEqualTo("live");
		await Assert.That(ready.GetProperty("status").GetString()).IsEqualTo("ready");
		await Assert.That(service.GetProperty("auth").GetProperty("provider").GetString()).IsEqualTo("none");
		await Assert.That(service.GetProperty("auth").GetProperty("tenant").GetString()).IsEqualTo($"local-{Environment.UserName}");
		await Assert.That(service.GetProperty("version").GetString()).IsEqualTo(CliApp.Version);
		await Assert.That(process.Output).Contains(discovery.Url);
	}

	[Test]
	public async Task Serve_listens_on_loopback_only_even_when_the_environment_asks_for_all_addresses()
	{
		var (process, discovery) = await StartHostAsync(("ASPNETCORE_URLS", "http://0.0.0.0:0"), ("Kestrel__Endpoints__Extra__Url", "http://0.0.0.0:0"));
		await using var _ = process;

		await Assert.That(await CanConnectAsync(IPAddress.Loopback, discovery.Port)).IsTrue();

		var otherAddresses = NetworkInterface.GetAllNetworkInterfaces()
			.Where(network => network.OperationalStatus == OperationalStatus.Up)
			.SelectMany(network => network.GetIPProperties().UnicastAddresses)
			.Select(address => address.Address)
			.Where(address => address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !IPAddress.IsLoopback(address))
			.ToArray();
		foreach (var address in otherAddresses)
		{
			await Assert.That(await CanConnectAsync(address, discovery.Port)).IsFalse();
		}
	}

	private static async Task<bool> CanConnectAsync(IPAddress address, int port)
	{
		using var client = new System.Net.Sockets.TcpClient();
		using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
		try
		{
			await client.ConnectAsync(address, port, timeout.Token);
			return true;
		}
		catch (Exception exception) when (exception is System.Net.Sockets.SocketException or OperationCanceledException)
		{
			return false;
		}
	}

	[Test]
	public async Task Serve_stays_available_while_idle()
	{
		var (process, discovery) = await StartHostAsync();
		await using var _ = process;

		await Task.Delay(TimeSpan.FromSeconds(3));
		var ready = await ServeProcess.GetJsonAsync(discovery.Url + "/health/ready", 200);

		await Assert.That(ready.GetProperty("status").GetString()).IsEqualTo("ready");
	}

	[Test]
	public async Task A_termination_signal_stops_the_host_cleanly_and_removes_the_discovery_file()
	{
		var (process, discovery) = await StartHostAsync();
		await using var _ = process;

		process.Terminate();
		var exit = await process.WaitForExitAsync();

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(File.Exists(process.Folder.DiscoveryFile)).IsFalse();
		await Assert.That(await CanConnectAsync(IPAddress.Loopback, discovery.Port)).IsFalse();
	}

	[Test]
	public async Task An_unreachable_database_fails_visibly_without_discovery_and_without_the_password()
	{
		await using var process = ServeProcess.Start(
			ServeProcess.NewShipyardHome(),
			"postgres://someone:secret-password@127.0.0.1:1/missing");

		var discovery = await process.WaitForDiscoveryAsync();
		var exit = await process.WaitForExitAsync();

		await Assert.That(discovery).IsNull();
		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(process.Error).Contains("did not start");
		await Assert.That(process.Error + process.Output).DoesNotContain("secret-password");
		await Assert.That(File.Exists(process.Folder.DiscoveryFile)).IsFalse();
	}

	[Test]
	public async Task A_database_that_the_tool_did_not_create_fails_visibly_without_discovery()
	{
		var url = await LocalPostgresServer.CreateDatabaseUrlAsync();
		await LocalPostgresServer.ExecuteAsync(url, "CREATE TABLE foreign_table (id int)");
		await using var process = ServeProcess.Start(ServeProcess.NewShipyardHome(), url);

		var discovery = await process.WaitForDiscoveryAsync();
		var exit = await process.WaitForExitAsync();

		await Assert.That(discovery).IsNull();
		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(process.Error).Contains("did not start");
		await Assert.That(File.Exists(process.Folder.DiscoveryFile)).IsFalse();
	}

	[Test]
	public async Task A_failed_start_removes_the_stale_discovery_file_of_a_killed_host()
	{
		var home = ServeProcess.NewShipyardHome();
		await using var process = ServeProcess.Start(home, "postgres://someone:p@127.0.0.1:1/missing");
		await process.WaitForExitAsync();
		new AgentLogbook.Core.LocalApi.LocalApiDiscovery("http://127.0.0.1:9", 9, int.MaxValue, "0.0.1", DateTimeOffset.UtcNow.AddHours(-1))
			.Write(process.Folder);

		await using var second = ServeProcess.Start(home, "postgres://someone:p@127.0.0.1:1/missing");
		var exit = await second.WaitForExitAsync();

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(File.Exists(second.Folder.DiscoveryFile)).IsFalse();
	}

	[Test]
	public async Task A_second_serve_does_not_replace_the_discovery_of_a_running_host()
	{
		var (first, discovery) = await StartHostAsync();
		await using var _ = first;

		await using var second = ServeProcess.Start(first.ShipyardHome, await LocalPostgresServer.CreateDatabaseUrlAsync());
		var exit = await second.WaitForExitAsync();

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(second.Error).Contains("already running");
		await Assert.That(AgentLogbook.Core.LocalApi.LocalApiDiscovery.Read(first.Folder)).IsEqualTo(discovery);
	}

	[Test]
	public async Task Two_hosts_that_start_together_leave_exactly_one_host_with_its_own_discovery()
	{
		var home = ServeProcess.NewShipyardHome();
		await using var first = ServeProcess.Start(home, await LocalPostgresServer.CreateDatabaseUrlAsync());
		await using var second = ServeProcess.Start(home, await LocalPostgresServer.CreateDatabaseUrlAsync());

		await Task.WhenAny(first.WaitForExitAsync(), second.WaitForExitAsync());
		var (loser, winner) = first.HasExited ? (first, second) : (second, first);
		var discovery = await winner.WaitForDiscoveryAsync();

		await Assert.That(discovery).IsNotNull();
		await Assert.That(discovery!.ProcessId).IsEqualTo(winner.ProcessId);
		await Assert.That(loser.Error).Contains("already running");
		await Assert.That(winner.HasExited).IsFalse();
	}

	[Test]
	public async Task Serve_rejects_arguments()
	{
		var stderr = new StringWriter();
		var exit = await CliApp.RunAsync(["serve", "--port", "80"], new StringWriter(), stderr, CancellationToken.None);

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(stderr.ToString()).Contains("--port");
	}
}
