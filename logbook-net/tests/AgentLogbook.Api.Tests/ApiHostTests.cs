using System.Net;
using System.Text.Json;
using AgentLogbook.Api.Auth;
using Npgsql;

namespace AgentLogbook.Api.Tests;

public class ApiHostTests
{
	private static ApiHostOptions Options(IPAddress address, IAuthProvider? auth = null) => new()
	{
		AuthProvider = auth ?? LocalNoAuthProvider.Enable("tester"),
		// Nothing listens on port 1, so every database use fails. Creating the data source does not connect.
		DataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Username=u;Password=p;Database=d;Timeout=2;Pooling=false"),
		ToolVersion = "9.9.9",
		ListenAddress = address,
	};

	[Test]
	public async Task No_auth_cannot_listen_on_a_non_loopback_address()
	{
		await Assert.That(async () => await ApiHost.StartAsync(Options(IPAddress.Any)))
			.Throws<InvalidOperationException>();
		await Assert.That(async () => await ApiHost.StartAsync(Options(IPAddress.IPv6Any)))
			.Throws<InvalidOperationException>();
	}

	[Test]
	public async Task No_auth_provider_has_no_public_constructor_and_names_the_local_tenant()
	{
		var provider = LocalNoAuthProvider.Enable("alice");

		await Assert.That(typeof(LocalNoAuthProvider).GetConstructors()).IsEmpty();
		await Assert.That(provider.Identity.TenantId).IsEqualTo("local-alice");
		await Assert.That(() => LocalNoAuthProvider.Enable(" ")).Throws<ArgumentException>();
	}

	[Test]
	public async Task Live_and_discovery_answer_without_the_database_and_ready_reports_not_ready_when_it_is_down()
	{
		await using var host = await ApiHost.StartAsync(Options(IPAddress.Loopback));
		using var client = new HttpClient { BaseAddress = host.Url };

		var live = await client.GetAsync("/health/live");
		var service = await client.GetAsync("/.well-known/agent-logbook");
		var ready = await client.GetAsync("/health/ready");

		await Assert.That(live.StatusCode).IsEqualTo(HttpStatusCode.OK);
		using var serviceBody = JsonDocument.Parse(await service.Content.ReadAsStringAsync());
		await Assert.That(serviceBody.RootElement.GetProperty("auth").GetProperty("tenant").GetString()).IsEqualTo("local-tester");
		await Assert.That(serviceBody.RootElement.GetProperty("version").GetString()).IsEqualTo("9.9.9");
		await Assert.That(ready.StatusCode).IsEqualTo(HttpStatusCode.ServiceUnavailable);
		await Assert.That(await ready.Content.ReadAsStringAsync()).IsEqualTo("""{"status":"not-ready"}""");
		await Assert.That(ready.Headers.CacheControl?.NoStore).IsTrue();
	}

	[Test]
	public async Task Only_get_is_allowed_on_the_health_and_discovery_routes()
	{
		await using var host = await ApiHost.StartAsync(Options(IPAddress.Loopback));
		using var client = new HttpClient { BaseAddress = host.Url };

		var post = await client.PostAsync("/.well-known/agent-logbook", content: null);

		await Assert.That(post.StatusCode).IsEqualTo(HttpStatusCode.MethodNotAllowed);
	}
}
