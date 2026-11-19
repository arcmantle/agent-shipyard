using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Client.Tests;

public class HttpStoreTests
{
	private static HttpStore Store(RpcTestServer server, Action<HttpStoreOptions>? configure = null) =>
		new(new HttpStoreOptions { BaseUrl = server.Url });

	private static JsonElement Json(string text) => JsonElement.Parse(text);

	[Test]
	public async Task The_request_is_one_json_rpc_post_that_keeps_json_nulls_in_params()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		await store.CallAsync("createEntity", Json("""{"kind":"issue","parentId":null,"title":"T"}"""));

		var request = server.Requests.Single();
		using var body = JsonDocument.Parse(request.Body);
		await Assert.That(request.Headers["content-type"]).IsEqualTo("application/json");
		await Assert.That(body.RootElement.GetProperty("jsonrpc").GetString()).IsEqualTo("2.0");
		await Assert.That(body.RootElement.GetProperty("method").GetString()).IsEqualTo("createEntity");
		await Assert.That(Guid.TryParse(body.RootElement.GetProperty("id").GetString(), out _)).IsTrue();
		await Assert.That(body.RootElement.GetProperty("params").GetProperty("parentId").ValueKind).IsEqualTo(JsonValueKind.Null);
	}

	[Test]
	public async Task Params_are_left_out_when_absent_and_sent_as_null_when_null()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		await store.CallAsync("listAllRelations");
		await store.CallAsync("listOrphans", Json("null"));

		using var absent = JsonDocument.Parse(server.Requests[0].Body);
		using var explicitNull = JsonDocument.Parse(server.Requests[1].Body);
		await Assert.That(absent.RootElement.TryGetProperty("params", out _)).IsFalse();
		await Assert.That(explicitNull.RootElement.GetProperty("params").ValueKind).IsEqualTo(JsonValueKind.Null);
	}

	[Test]
	public async Task Typed_parameters_keep_null_fields_and_use_camel_case()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		await store.CallAsync<object>("createEntity", new TypedParameters("issue", null, null));

		await Assert.That(server.Requests.Single().Body).Contains("\"params\":{\"kind\":\"issue\",\"parentId\":null,\"body\":null}");
	}

	[Test]
	public async Task Optional_headers_are_sent_only_when_set_and_the_local_login_sends_no_authorization()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var plain = Store(server);
		using var full = new HttpStore(new HttpStoreOptions
		{
			BaseUrl = server.Url,
			BearerToken = "secret",
			ProjectIdentity = "my-project",
			WorkspaceRoot = "/work/space",
			CorrelationId = "corr-1",
		});

		await plain.CallAsync("a");
		await full.CallAsync("b");

		var withoutHeaders = server.Requests[0].Headers;
		var withHeaders = server.Requests[1].Headers;
		await Assert.That(withoutHeaders.ContainsKey("authorization")).IsFalse();
		await Assert.That(withoutHeaders.Keys.Any(name => name.StartsWith("x-agent-", StringComparison.Ordinal))).IsFalse();
		await Assert.That(withHeaders["authorization"]).IsEqualTo("Bearer secret");
		await Assert.That(withHeaders[RpcWire.ProjectIdentityHeader]).IsEqualTo("my-project");
		await Assert.That(withHeaders[RpcWire.WorkspaceRootHeader]).IsEqualTo("/work/space");
		await Assert.That(withHeaders[RpcWire.CorrelationIdHeader]).IsEqualTo("corr-1");
		await Assert.That(withHeaders.Keys.Any(name => name.Contains("build-hash") || name.Contains("db-path"))).IsFalse();
	}

	[Test]
	public async Task A_trailing_slash_on_the_base_url_does_not_change_the_rpc_path()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri(server.Url, "/") });

		await store.CallAsync("a");

		await Assert.That(server.Requests.Count).IsEqualTo(1);
	}

	[Test]
	public async Task The_result_comes_back_with_its_null_fields()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x","result":{"id":"1","category":null,"revision":1}}""");
		using var store = Store(server);

		var raw = await store.CallAsync("getEntityDetails");
		var typed = await store.CallAsync<EntityResult>("getEntityDetails");

		await Assert.That(raw.GetProperty("category").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(typed).IsEqualTo(new EntityResult("1", null, 1));
	}

	[Test]
	public async Task A_null_result_stays_null_and_a_missing_result_is_undefined()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x","result":null}""");
		var nullResult = await store.CallAsync("a");
		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x"}""");
		var missing = await store.CallAsync("a");

		await Assert.That(nullResult.ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(missing.ValueKind).IsEqualTo(JsonValueKind.Undefined);
	}

	[Test]
	[Arguments("""{"entityId":"e1","currentRevision":3,"currentContentHash":"h"}""", typeof(EntityConflictException))]
	[Arguments("""{"commentId":"c1","currentRevision":3,"currentContentHash":"h"}""", typeof(IssueCommentConflictException))]
	[Arguments("""{"entryId":"p1","currentRevision":3,"currentContentHash":"h"}""", typeof(PlanEntryConflictException))]
	[Arguments("""{"contextKey":"k","currentRevision":3,"currentContentHash":"h"}""", typeof(ContextConflictException))]
	[Arguments("""{"contextKey":"k","term":"t","currentRevision":3,"currentContentHash":"h"}""", typeof(ContextTermConflictException))]
	[Arguments("""{"entityId":"e1","reason":"broken-chain","headRevision":2}""", typeof(EntityRevisionException))]
	[Arguments("""{"contextKey":"k","reason":"term-not-found","term":"t"}""", typeof(ContextRevisionException))]
	[Arguments("""{"observationId":"o1"}""", typeof(CompletionObservationConflictException))]
	[Arguments("""{"entityId":"e1","reason":"unknown-reason"}""", typeof(RpcServerException))]
	[Arguments("""{"other":true}""", typeof(RpcServerException))]
	[Arguments("""[1,2]""", typeof(RpcServerException))]
	[Arguments("null", typeof(RpcServerException))]
	public async Task An_error_response_becomes_the_exception_that_its_data_shape_names(string data, Type expected)
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, $$$"""{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"the message","data":{{{data}}}}}""");
		using var store = Store(server);

		var exception = await Assert.That(async () => await store.CallAsync("a")).Throws<RpcException>();

		await Assert.That(exception!.GetType()).IsEqualTo(expected);
		await Assert.That(exception.Message).IsEqualTo("the message");
		await Assert.That(exception.Code).IsEqualTo(-32000);
		await Assert.That(exception.ErrorData!.Value.GetRawText()).IsEqualTo(JsonElement.Parse(data).GetRawText());
	}

	[Test]
	public async Task Error_fields_are_carried_on_the_typed_exceptions()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"m","data":{"contextKey":"k","term":"t","currentRevision":3,"currentContentHash":"h"}}}""");
		using var store = Store(server);

		var exception = (ContextTermConflictException)(await Assert.That(async () => await store.CallAsync("a")).Throws<RpcException>())!;

		await Assert.That(exception.ContextKey).IsEqualTo("k");
		await Assert.That(exception.Term).IsEqualTo("t");
		await Assert.That(exception.CurrentRevision).IsEqualTo(3);
		await Assert.That(exception.CurrentContentHash).IsEqualTo("h");
	}

	[Test]
	public async Task An_error_without_data_keeps_the_code_and_has_no_data()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"Method not found"}}""");
		using var store = Store(server);

		var exception = await Assert.That(async () => await store.CallAsync("nope")).Throws<RpcServerException>();

		await Assert.That(exception!.Code).IsEqualTo(RpcWire.MethodNotFoundCode);
		await Assert.That(exception.ErrorData).IsNull();
	}

	[Test]
	public async Task A_failed_http_status_is_an_explicit_status_error_even_with_an_rpc_body()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (500, """{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"m"}}""");
		using var store = Store(server);

		var exception = await Assert.That(async () => await store.CallAsync("createEntity")).Throws<HttpStoreStatusException>();

		await Assert.That(exception!.StatusCode).IsEqualTo(500);
		await Assert.That(exception.Message).IsEqualTo("HttpStore request to createEntity failed with HTTP 500.");
	}

	[Test]
	public async Task A_body_that_is_not_a_json_rpc_response_is_a_protocol_error()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		server.Answer = _ => (200, "<html>");
		await Assert.That(async () => await store.CallAsync("a")).Throws<HttpStoreProtocolException>();
		server.Answer = _ => (200, "[]");
		await Assert.That(async () => await store.CallAsync("a")).Throws<HttpStoreProtocolException>();
	}

	[Test]
	public async Task A_host_that_refuses_the_connection_is_an_explicit_transport_error()
	{
		var closedPort = FreePort();
		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri($"http://127.0.0.1:{closedPort}") });

		var exception = await Assert.That(async () => await store.CallAsync("a")).Throws<HttpStoreTransportException>();

		await Assert.That(exception!.Message).Contains($"http://127.0.0.1:{closedPort}/rpc");
		await Assert.That(exception.Method).IsEqualTo("a");
	}

	[Test]
	public async Task A_connection_that_breaks_while_the_body_is_read_is_a_transport_error()
	{
		using var client = new HttpClient(new BrokenBodyHandler());
		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri("http://127.0.0.1:1"), HttpClient = client });

		await Assert.That(async () => await store.CallAsync("a")).Throws<HttpStoreTransportException>();
	}

	[Test]
	public async Task A_caller_cancel_is_not_reported_as_a_transport_error()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);
		using var cancelled = new CancellationTokenSource();
		await cancelled.CancelAsync();

		await Assert.That(async () => await store.CallAsync("a", null, cancelled.Token)).Throws<OperationCanceledException>();
	}

	[Test]
	public async Task A_closed_store_refuses_calls_and_does_not_dispose_a_supplied_client()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var client = new HttpClient();
		var store = new HttpStore(new HttpStoreOptions { BaseUrl = server.Url, HttpClient = client });

		await store.CallAsync("a");
		store.Dispose();

		await Assert.That(async () => await store.CallAsync("a")).Throws<InvalidOperationException>();
		await Assert.That((await client.GetAsync(new Uri(server.Url, "/health/live"))).StatusCode).IsEqualTo(HttpStatusCode.OK);
	}

	private static int FreePort()
	{
		using var listener = new TcpListener(IPAddress.Loopback, 0);
		listener.Start();
		return ((IPEndPoint)listener.LocalEndpoint).Port;
	}

	private sealed class BrokenBodyHandler : HttpMessageHandler
	{
		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
			Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new BrokenStream()) });
	}

	private sealed class BrokenStream : Stream
	{
		public override bool CanRead => true;
		public override bool CanSeek => false;
		public override bool CanWrite => false;
		public override long Length => throw new NotSupportedException();
		public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
		public override void Flush() { }
		public override int Read(byte[] buffer, int offset, int count) => throw new IOException("connection reset");
		public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => throw new IOException("connection reset");
		public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
		public override void SetLength(long value) => throw new NotSupportedException();
		public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
	}

	private sealed record TypedParameters(string Kind, string? ParentId, string? Body);

	private sealed record EntityResult(string Id, string? Category, int Revision);
}
