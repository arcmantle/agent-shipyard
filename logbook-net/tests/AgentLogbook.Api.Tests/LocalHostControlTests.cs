using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AgentLogbook.Api.Auth;
using Microsoft.AspNetCore.Http;
using Npgsql;

namespace AgentLogbook.Api.Tests;

public class LocalHostControlTests
{
	private sealed class DeploymentAuthProvider : IAuthProvider
	{
		public object Metadata => new { provider = "entra" };

		public bool RequiresLoopback => false;

		public ValueTask<ApiIdentity?> AuthenticateAsync(HttpContext context) => ValueTask.FromResult<ApiIdentity?>(new ApiIdentity("tenant", "admin"));
	}

	private static Task<RunningApiHost> StartAsync(IAuthProvider auth, Action? onStopRequested) =>
		ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = auth,
			// Nothing listens on port 1. The control path does not use the database.
			DataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Username=u;Password=p;Database=d;Timeout=2;Pooling=false"),
			ToolVersion = "9.9.9",
			ListenAddress = IPAddress.Loopback,
			OnStopRequested = onStopRequested,
		});

	[Test]
	public async Task The_local_host_reports_its_process_and_a_stop_request_is_answered_before_it_runs()
	{
		var stopRequested = new TaskCompletionSource();
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"), () => stopRequested.TrySetResult());
		using var client = new HttpClient { BaseAddress = host.Url };

		var identity = await client.GetFromJsonAsync<JsonElement>("/local/host");
		await Assert.That(stopRequested.Task.IsCompleted).IsFalse();
		var stop = await client.PostAsJsonAsync("/local/host/stop", new { });
		await stopRequested.Task.WaitAsync(TimeSpan.FromSeconds(10));

		await Assert.That(identity.GetProperty("processId").GetInt32()).IsEqualTo(Environment.ProcessId);
		await Assert.That(identity.GetProperty("toolVersion").GetString()).IsEqualTo("9.9.9");
		await Assert.That(stop.StatusCode).IsEqualTo(HttpStatusCode.Accepted);
	}

	[Test]
	public async Task A_stop_request_needs_a_json_content_type_and_a_loopback_host_name()
	{
		var stopRequests = 0;
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"), () => stopRequests++);
		using var client = new HttpClient { BaseAddress = host.Url };
		using var plain = new StringContent("{}", Encoding.UTF8, "text/plain");
		using var rebound = new HttpRequestMessage(HttpMethod.Post, "/local/host/stop") { Content = JsonContent.Create(new { }) };
		rebound.Headers.Host = "attacker.example";

		var plainAnswer = await client.PostAsync("/local/host/stop", plain);
		var reboundAnswer = await client.SendAsync(rebound);
		var getStop = await client.GetAsync("/local/host/stop");

		await Assert.That(plainAnswer.StatusCode).IsEqualTo(HttpStatusCode.UnsupportedMediaType);
		await Assert.That(reboundAnswer.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
		await Assert.That(getStop.StatusCode).IsEqualTo(HttpStatusCode.MethodNotAllowed);
		await Assert.That(stopRequests).IsEqualTo(0);
	}

	[Test]
	public async Task A_deployment_and_a_host_without_a_stop_handler_have_no_control_routes()
	{
		var stopRequests = 0;
		await using var deployment = await StartAsync(new DeploymentAuthProvider(), () => stopRequests++);
		await using var withoutHandler = await StartAsync(LocalNoAuthProvider.Enable("tester"), onStopRequested: null);

		foreach (var host in new[] { deployment, withoutHandler })
		{
			using var client = new HttpClient { BaseAddress = host.Url };
			var identity = await client.GetAsync("/local/host");
			var stop = await client.PostAsJsonAsync("/local/host/stop", new { });

			await Assert.That(identity.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
			await Assert.That(stop.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
		}

		await Assert.That(stopRequests).IsEqualTo(0);
	}
}
