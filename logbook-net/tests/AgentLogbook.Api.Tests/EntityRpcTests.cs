using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentLogbook.Api.Auth;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Storage.Postgres;
using Npgsql;

namespace AgentLogbook.Api.Tests;

/// <summary>The JSON-RPC wire of the entity methods, through real HTTP requests against a real API host and real PostgreSQL.</summary>
public class EntityRpcTests
{
	private static readonly string[] DraftOrActive = ["draft", "active"];

	private static readonly int[] ArrayParameters = [1, 2];

	private static int databaseCounter;

	private static async Task<(RunningApiHost Host, NpgsqlDataSource DataSource)> StartAsync(string user)
	{
		var container = await ApiPostgresServer.Container();
		var name = $"entity_rpc_{Interlocked.Increment(ref databaseCounter)}";
		await using (var admin = new NpgsqlConnection(container.GetConnectionString()))
		{
			await admin.OpenAsync();
			await using var create = new NpgsqlCommand($"CREATE DATABASE {name}", admin);
			await create.ExecuteNonQueryAsync();
		}

		var dataSource = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(container.GetConnectionString()) { Database = name });
		await PostgresSchemaInitializer.InitializeAsync(dataSource);
		var host = await ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = LocalNoAuthProvider.Enable(user),
			DataSource = dataSource,
			ToolVersion = "9.9.9",
			ListenAddress = IPAddress.Loopback,
		});
		return (host, dataSource);
	}

	private static async Task<JsonElement> CallAsync(RunningApiHost host, string method, object? parameters = null, string? projectIdentity = null)
	{
		using var client = new HttpClient { BaseAddress = host.Url };
		using var request = new HttpRequestMessage(HttpMethod.Post, RpcWire.Path)
		{
			Content = JsonContent.Create(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = method, ["params"] = parameters }),
		};
		if (projectIdentity is not null)
		{
			request.Headers.Add(RpcWire.ProjectIdentityHeader, projectIdentity);
		}

		using var response = await client.SendAsync(request);
		return JsonElement.Parse(await response.Content.ReadAsStringAsync());
	}

	private static async Task<JsonElement> ResultAsync(RunningApiHost host, string method, object? parameters = null, string? projectIdentity = null)
	{
		var answer = await CallAsync(host, method, parameters, projectIdentity);
		await Assert.That(answer.TryGetProperty("error", out var error) ? error.ToString() : null).IsNull();
		return answer.GetProperty("result");
	}

	[Test]
	public async Task A_created_entity_has_the_summary_fields_with_json_nulls_and_no_body()
	{
		var (host, dataSource) = await StartAsync("wire-user-1");
		await using var apiHost = host;
		await using var source = dataSource;

		var created = await ResultAsync(host, EntityRpc.CreateMethod, new { kind = "initiative", title = "Wire initiative" });

		await Assert.That(created.EnumerateObject().Select(property => property.Name)).IsEquivalentTo(
			["id", "reference", "shortReference", "createdBy", "updatedBy", "kind", "title", "status", "category", "priority", "type", "revision", "contentHash", "createdAt", "updatedAt"]);
		await Assert.That(created.GetProperty("category").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(created.GetProperty("priority").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(created.GetProperty("type").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(created.GetProperty("revision").GetInt32()).IsEqualTo(1);
		await Assert.That(created.GetProperty("status").GetString()).IsEqualTo("draft");
	}

	[Test]
	public async Task Details_carry_comments_for_an_issue_only_and_keep_the_nulls_of_the_focus()
	{
		var (host, dataSource) = await StartAsync("wire-user-2");
		await using var apiHost = host;
		await using var source = dataSource;
		var initiative = await ResultAsync(host, EntityRpc.CreateMethod, new { kind = "initiative", title = "Initiative" });
		var issue = await ResultAsync(host, EntityRpc.CreateMethod, new { kind = "issue", title = "Issue", parentId = initiative.GetProperty("id").GetString() });

		var issueDetails = await ResultAsync(host, EntityRpc.GetDetailsMethod, new { entityId = issue.GetProperty("reference").GetString() });
		var initiativeDetails = await ResultAsync(host, EntityRpc.GetDetailsMethod, new { entityId = initiative.GetProperty("id").GetString() });

		await Assert.That(issueDetails.GetProperty("comments").GetRawText()).IsEqualTo("""{"comments":[],"users":[],"total":0,"nextBefore":null}""");
		await Assert.That(issueDetails.GetProperty("entity").GetProperty("body").GetString()).IsEqualTo(string.Empty);
		await Assert.That(issueDetails.GetProperty("entity").GetProperty("bodySource").GetString()).IsEqualTo("authored");
		await Assert.That(issueDetails.GetProperty("entity").GetProperty("category").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(issueDetails.GetProperty("currentCompletionObservation").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(issueDetails.GetProperty("planEntries").GetRawText()).IsEqualTo("[]");
		await Assert.That(issueDetails.GetProperty("versionCoverage").GetRawText()).IsEqualTo("[]");
		await Assert.That(issueDetails.GetProperty("incoming")[0].GetProperty("relationType").GetString()).IsEqualTo("tracks");
		await Assert.That(initiativeDetails.TryGetProperty("comments", out _)).IsFalse();
		await Assert.That(initiativeDetails.GetProperty("entity").GetProperty("status").GetString()).IsEqualTo("draft");
	}

	[Test]
	public async Task A_query_has_open_blockers_for_issues_only_and_a_list_is_a_plain_array()
	{
		var (host, dataSource) = await StartAsync("wire-user-3");
		await using var apiHost = host;
		await using var source = dataSource;
		var initiative = await ResultAsync(host, EntityRpc.CreateMethod, new { kind = "initiative", title = "Initiative" });
		await ResultAsync(host, EntityRpc.CreateMethod, new { kind = "issue", title = "Issue", parentId = initiative.GetProperty("id").GetString() });

		var issues = await ResultAsync(host, EntityRpc.QueryMethod, new { kind = "issue" });
		var initiatives = await ResultAsync(host, EntityRpc.QueryMethod, new { kind = "initiative", statuses = DraftOrActive });
		var list = await ResultAsync(host, EntityRpc.ListMethod, new { kind = "issue" });

		await Assert.That(issues.GetProperty("total").GetInt32()).IsEqualTo(1);
		await Assert.That(issues.GetProperty("openBlockers").EnumerateObject().Count()).IsEqualTo(1);
		await Assert.That(initiatives.TryGetProperty("openBlockers", out _)).IsFalse();
		await Assert.That(initiatives.TryGetProperty("parentGroups", out _)).IsFalse();
		await Assert.That(list.ValueKind).IsEqualTo(JsonValueKind.Array);
		await Assert.That(list.GetArrayLength()).IsEqualTo(1);
	}

	[Test]
	public async Task A_workflow_failure_is_a_server_error_with_its_message_and_a_bad_params_value_is_refused()
	{
		var (host, dataSource) = await StartAsync("wire-user-4");
		await using var apiHost = host;
		await using var source = dataSource;

		var unknownKind = await CallAsync(host, EntityRpc.CreateMethod, new { kind = "bogus", title = "x" });
		var missing = await CallAsync(host, EntityRpc.GetDetailsMethod, new { entityId = "missing" });
		var noParams = await CallAsync(host, EntityRpc.ListMethod);
		var arrayParams = await CallAsync(host, EntityRpc.CreateMethod, ArrayParameters);
		var wrongType = await CallAsync(host, EntityRpc.CreateMethod, new { kind = 5, title = "x" });

		await Assert.That(unknownKind.GetProperty("error").GetProperty("code").GetInt32()).IsEqualTo(RpcWire.ServerErrorCode);
		await Assert.That(unknownKind.GetProperty("error").GetProperty("message").GetString()).IsEqualTo("Unknown entity kind: bogus");
		await Assert.That(missing.GetProperty("error").GetProperty("message").GetString()).IsEqualTo("Entity not found: missing");
		await Assert.That(noParams.GetProperty("error").GetProperty("message").GetString()).IsEqualTo("Unknown entity kind: undefined");
		await Assert.That(arrayParams.GetProperty("error").GetProperty("message").GetString()).IsEqualTo("Invalid parameters for createEntity.");
		await Assert.That(wrongType.GetProperty("error").GetProperty("message").GetString()).IsEqualTo("Invalid parameters for createEntity.");
	}

	[Test]
	public async Task The_tenant_comes_from_the_login_and_the_project_from_the_header()
	{
		var (hostA, dataSource) = await StartAsync("wire-tenant-a");
		await using var apiHostA = hostA;
		await using var source = dataSource;
		await using var hostB = await ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = LocalNoAuthProvider.Enable("wire-tenant-b"),
			DataSource = dataSource,
			ToolVersion = "9.9.9",
			ListenAddress = IPAddress.Loopback,
		});
		var inA = await ResultAsync(hostA, EntityRpc.CreateMethod, new { kind = "initiative", title = "A initiative" }, projectIdentity: "repo-one");

		var listedByA = await ResultAsync(hostA, EntityRpc.ListMethod, new { kind = "initiative" }, projectIdentity: "repo-one");
		var listedByAOtherProject = await ResultAsync(hostA, EntityRpc.ListMethod, new { kind = "initiative" }, projectIdentity: "repo-two");
		var listedByB = await ResultAsync(hostB, EntityRpc.ListMethod, new { kind = "initiative" }, projectIdentity: "repo-one");

		await Assert.That(listedByA.EnumerateArray().Select(entity => entity.GetProperty("id").GetString())).IsEquivalentTo([inA.GetProperty("id").GetString()]);
		await Assert.That(listedByAOtherProject.GetArrayLength()).IsEqualTo(0);
		await Assert.That(listedByB.GetArrayLength()).IsEqualTo(0);
	}
}
