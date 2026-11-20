using System.Text.Json;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Client.Tests;

public class EntityMethodTests
{
	private const string SummaryJson =
		"""{"id":"11111111-1111-4111-8111-111111111111","reference":"ISS_1","shortReference":"ISS_A","createdBy":"u","updatedBy":"u","kind":"issue","title":"T","status":"todo","category":null,"priority":null,"type":null,"revision":1,"contentHash":"h","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}""";

	private static HttpStore Store(RpcTestServer server) => new(new HttpStoreOptions { BaseUrl = server.Url });

	private static string Reply(string result) => $$"""{"jsonrpc":"2.0","id":"x","result":{{result}}}""";

	private static async Task<JsonElement> ParamsOfAsync(RpcTestServer server)
	{
		using var body = JsonDocument.Parse(server.Requests.Single().Body);
		return body.RootElement.GetProperty("params").Clone();
	}

	[Test]
	public async Task Create_sends_only_the_fields_that_are_set_and_reads_the_summary()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, Reply(SummaryJson));
		using var store = Store(server);

		var created = await store.CreateEntityAsync(new CreateEntityRequest { Kind = "issue", Title = "T", ParentId = "INIT_1" });

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo("""{"kind":"issue","title":"T","parentId":"INIT_1"}""");
		await Assert.That(created.Reference).IsEqualTo("ISS_1");
		await Assert.That(created.Category).IsNull();
		await Assert.That(created.Revision).IsEqualTo(1);
	}

	[Test]
	public async Task Create_with_every_field_sends_each_in_camel_case()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, Reply(SummaryJson));
		using var store = Store(server);

		await store.CreateEntityAsync(new CreateEntityRequest
		{
			Kind = "debt", Title = "T", ParentId = "P", Status = "open", Body = "B", Category = "technical", Priority = "high", Type = "pioneer-map",
		});

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo(
			"""{"kind":"debt","title":"T","parentId":"P","status":"open","body":"B","category":"technical","priority":"high","type":"pioneer-map"}""");
	}

	[Test]
	public async Task Details_send_the_entity_id_and_read_comments_only_when_the_host_sends_them()
	{
		await using var server = await RpcTestServer.StartAsync();
		var entity = SummaryJson[..^1] + ",\"body\":\"B\",\"bodySource\":\"authored\"}";
		var link = "{\"relationType\":\"tracks\",\"entity\":" + SummaryJson + "}";
		const string comments = "{\"comments\":[],\"users\":[],\"total\":0,\"nextBefore\":null}";
		server.Answer = _ => (200, Reply(
			"{\"entity\":" + entity + ",\"incoming\":[" + link + "],\"outgoing\":[],\"planEntries\":[],\"completionObservations\":[],\"currentCompletionObservation\":null,\"versionCoverage\":[],\"comments\":" + comments + "}"));
		using var store = Store(server);

		var details = await store.GetEntityDetailsAsync("ISS_1");

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo("""{"entityId":"ISS_1"}""");
		await Assert.That(details.Entity.Body).IsEqualTo("B");
		await Assert.That(details.Incoming.Single().RelationType).IsEqualTo("tracks");
		await Assert.That(details.Comments!.Total).IsEqualTo(0);
		await Assert.That(details.CurrentCompletionObservation).IsNull();
	}

	[Test]
	public async Task Details_without_comments_have_no_comment_page()
	{
		await using var server = await RpcTestServer.StartAsync();
		var entity = SummaryJson[..^1] + ",\"body\":\"\",\"bodySource\":\"authored\"}";
		server.Answer = _ => (200, Reply(
			"{\"entity\":" + entity + ",\"incoming\":[],\"outgoing\":[],\"planEntries\":[],\"completionObservations\":[],\"currentCompletionObservation\":null,\"versionCoverage\":[]}"));
		using var store = Store(server);

		var details = await store.GetEntityDetailsAsync("ISS_1");

		await Assert.That(details.Comments).IsNull();
	}

	[Test]
	public async Task List_sends_the_kind_and_reads_an_array()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, Reply($"[{SummaryJson}]"));
		using var store = Store(server);

		var entities = await store.ListEntitiesAsync("issue");

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo("""{"kind":"issue"}""");
		await Assert.That(entities.Select(entity => entity.Id)).IsEquivalentTo(["11111111-1111-4111-8111-111111111111"]);
	}

	[Test]
	public async Task Query_sends_the_filters_that_are_set_and_reads_open_blockers()
	{
		await using var server = await RpcTestServer.StartAsync();
		server.Answer = _ => (200, Reply("{\"entities\":[" + SummaryJson + "],\"total\":3,\"openBlockers\":{\"ISS_1\":[\"ISS_2\"]}}"));
		using var store = Store(server);

		var result = await store.QueryEntitiesAsync(new QueryEntitiesRequest { Kind = "issue", Statuses = ["todo"], Limit = 5 });

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo("""{"kind":"issue","statuses":["todo"],"limit":5}""");
		await Assert.That(result.Total).IsEqualTo(3);
		await Assert.That(result.OpenBlockers!["ISS_1"]).IsEquivalentTo(["ISS_2"]);
	}

	[Test]
	public async Task A_null_result_is_a_protocol_failure_and_an_error_response_is_an_rpc_exception()
	{
		await using var server = await RpcTestServer.StartAsync();
		using var store = Store(server);

		await Assert.That(async () => await store.ListEntitiesAsync("issue")).Throws<HttpStoreProtocolException>();

		server.Answer = _ => (200, """{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"Unknown entity kind: bogus"}}""");
		var failure = await Assert.ThrowsAsync<RpcServerException>(async () => await store.ListEntitiesAsync("bogus"));

		await Assert.That(failure!.Message).IsEqualTo("Unknown entity kind: bogus");
	}

	[Test]
	public async Task The_initiative_bundle_sends_the_initiative_id_and_reads_the_links()
	{
		await using var server = await RpcTestServer.StartAsync();
		var record = SummaryJson[..^1] + ",\"body\":\"\",\"bodySource\":\"authored\"}";
		server.Answer = _ => (200, Reply(
			"{\"initiative\":" + record + ",\"entities\":[" + record + "],\"prds\":[],\"userStories\":[],\"adrs\":[],\"issues\":[" + record
			+ "],\"fixLinks\":[],\"subIssueLinks\":[{\"parent\":" + record + ",\"issue\":" + record + "}],\"blockerLinks\":[],\"constrainsLinks\":[],\"versionCoverage\":[]}"));
		using var store = Store(server);

		var bundle = await store.GetInitiativeBundleAsync("INIT_1");

		await Assert.That((await ParamsOfAsync(server)).GetRawText()).IsEqualTo("""{"initiativeId":"INIT_1"}""");
		await Assert.That(bundle.Issues).HasSingleItem();
		await Assert.That(bundle.SubIssueLinks.Single().Parent.Reference).IsEqualTo("ISS_1");
		await Assert.That(bundle.FixLinks).IsEmpty();
	}
}
