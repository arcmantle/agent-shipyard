using System.Net;
using System.Text;
using System.Text.Json;
using AgentLogbook.Api.Auth;
using AgentLogbook.Api.Rpc;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using Microsoft.AspNetCore.Http;
using Npgsql;

namespace AgentLogbook.Api.Tests;

public class RpcEndpointTests
{
	private sealed class DeniedProvider : IAuthProvider
	{
		public object Metadata => new { provider = "test" };

		public bool RequiresLoopback => false;

		public ValueTask<ApiIdentity?> AuthenticateAsync(HttpContext context) => ValueTask.FromResult<ApiIdentity?>(null);
	}

	private static RpcMethodRegistry TestMethods() => new RpcMethodRegistry()
		.Add("echo", call => Task.FromResult<object?>(new
		{
			tenant = call.Identity.TenantId,
			project = call.ProjectIdentity,
			hasParams = call.Params is not null,
			parameters = call.Params,
		}))
		.Add("nothing", _ => Task.FromResult<object?>(null))
		.Add("domainFailure", _ => throw new WorkspaceException("Ambiguous project identity \"x\" in tenant t."))
		.Add("brokenFailure", _ => throw new InvalidOperationException("password=secret host=db.internal"));

	private static async Task<RunningApiHost> StartAsync(IAuthProvider? auth = null) =>
		await ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = auth ?? LocalNoAuthProvider.Enable("tester"),
			// Nothing listens on port 1; the methods of these tests never use the database.
			DataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Username=u;Password=p;Database=d;Timeout=2;Pooling=false"),
			ToolVersion = "9.9.9",
			ListenAddress = IPAddress.Loopback,
			Rpc = TestMethods(),
		});

	private static async Task<(HttpStatusCode Status, string Body)> PostAsync(RunningApiHost host, string body, params (string Name, string Value)[] headers)
	{
		using var client = new HttpClient { BaseAddress = host.Url };
		using var request = new HttpRequestMessage(HttpMethod.Post, RpcWire.Path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
		foreach (var (name, value) in headers)
		{
			request.Headers.TryAddWithoutValidation(name, value);
		}

		using var response = await client.SendAsync(request);
		return (response.StatusCode, await response.Content.ReadAsStringAsync());
	}

	[Test]
	public async Task A_result_answers_with_the_request_id_and_the_login_tenant_not_a_tenant_from_the_body()
	{
		await using var host = await StartAsync();

		var (status, body) = await PostAsync(
			host,
			"""{"jsonrpc":"2.0","id":"call-1","method":"echo","params":{"tenantId":"other","a":null}}""",
			(RpcWire.ProjectIdentityHeader, "my-repo"));

		await Assert.That(status).IsEqualTo(HttpStatusCode.OK);
		using var json = JsonDocument.Parse(body);
		var root = json.RootElement;
		await Assert.That(root.GetProperty("jsonrpc").GetString()).IsEqualTo("2.0");
		await Assert.That(root.GetProperty("id").GetString()).IsEqualTo("call-1");
		var result = root.GetProperty("result");
		await Assert.That(result.GetProperty("tenant").GetString()).IsEqualTo("local-tester");
		await Assert.That(result.GetProperty("project").GetString()).IsEqualTo("my-repo");
		await Assert.That(result.GetProperty("parameters").GetProperty("a").ValueKind).IsEqualTo(JsonValueKind.Null);
	}

	[Test]
	public async Task A_null_result_stays_a_json_null_and_a_numeric_id_stays_a_number()
	{
		await using var host = await StartAsync();

		var (_, body) = await PostAsync(host, """{"jsonrpc":"2.0","id":7,"method":"nothing"}""");

		await Assert.That(body).IsEqualTo("""{"jsonrpc":"2.0","id":7,"result":null}""");
	}

	[Test]
	public async Task A_request_without_params_gets_no_params()
	{
		await using var host = await StartAsync();

		var (_, body) = await PostAsync(host, """{"jsonrpc":"2.0","id":1,"method":"echo"}""");

		using var json = JsonDocument.Parse(body);
		await Assert.That(json.RootElement.GetProperty("result").GetProperty("hasParams").GetBoolean()).IsFalse();
	}

	[Test]
	public async Task An_unknown_method_is_a_method_not_found_error_with_http_200()
	{
		await using var host = await StartAsync();

		var (status, body) = await PostAsync(host, """{"jsonrpc":"2.0","id":3,"method":"noSuchMethod"}""");

		await Assert.That(status).IsEqualTo(HttpStatusCode.OK);
		await Assert.That(body).IsEqualTo("""{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found: noSuchMethod"}}""");
	}

	[Test]
	public async Task A_domain_failure_gives_its_message_and_any_other_failure_gives_a_fixed_text()
	{
		await using var host = await StartAsync();

		var (domainStatus, domain) = await PostAsync(host, """{"jsonrpc":"2.0","id":1,"method":"domainFailure"}""");
		var (brokenStatus, broken) = await PostAsync(host, """{"jsonrpc":"2.0","id":2,"method":"brokenFailure"}""");

		await Assert.That(domainStatus).IsEqualTo(HttpStatusCode.OK);
		await Assert.That(domain).IsEqualTo("""{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Ambiguous project identity \"x\" in tenant t."}}""");
		await Assert.That(brokenStatus).IsEqualTo(HttpStatusCode.OK);
		await Assert.That(broken).IsEqualTo("""{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Internal error."}}""");
	}

	[Test]
	[Arguments("""{"jsonrpc":"1.0","id":1,"method":"echo"}""")]
	[Arguments("""{"id":1,"method":"echo"}""")]
	[Arguments("""{"jsonrpc":"2.0","id":1}""")]
	[Arguments("""{"jsonrpc":"2.0","id":1,"method":5}""")]
	[Arguments("""[{"jsonrpc":"2.0","id":1,"method":"echo"}]""")]
	[Arguments("not json")]
	[Arguments("")]
	public async Task A_body_that_is_not_a_json_rpc_request_is_http_400(string body)
	{
		await using var host = await StartAsync();

		var (status, answer) = await PostAsync(host, body);

		await Assert.That(status).IsEqualTo(HttpStatusCode.BadRequest);
		await Assert.That(answer).IsEqualTo("""{"error":"Malformed JSON-RPC request: expected { jsonrpc: \"2.0\", method, id }."}""");
	}

	[Test]
	public async Task A_request_that_the_auth_provider_denies_is_http_401_before_the_body_is_read()
	{
		await using var host = await StartAsync(new DeniedProvider());

		var (status, body) = await PostAsync(host, "not json");

		await Assert.That(status).IsEqualTo(HttpStatusCode.Unauthorized);
		await Assert.That(body).IsEqualTo("""{"error":"Invalid or expired bearer token."}""");
	}

	[Test]
	public async Task The_rpc_route_accepts_post_only()
	{
		await using var host = await StartAsync();
		using var client = new HttpClient { BaseAddress = host.Url };

		var response = await client.GetAsync(RpcWire.Path);

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.MethodNotAllowed);
	}

	[Test]
	public async Task The_default_registry_serves_initialize_workspace_and_nothing_else_yet()
	{
		var registry = RpcMethodRegistry.CreateDefault();

		await Assert.That(registry.TryGet(WorkspaceRpc.InitializeMethod, out _)).IsTrue();
		await Assert.That(registry.TryGet("createEntity", out _)).IsFalse();
	}
}
