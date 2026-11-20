using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using AgentLogbook.Api.Auth;
using Microsoft.AspNetCore.Http;
using Npgsql;
using Testcontainers.PostgreSql;

namespace AgentLogbook.Api.Tests;

/// <summary>The mode boundary of the direct query endpoint, through real API requests against real PostgreSQL.</summary>
public class DirectQueryTests
{
	/// <summary>A deployment provider: it authenticates a user with the admin role and never runs without a login.</summary>
	private sealed class DeploymentAuthProvider : IAuthProvider
	{
		public object Metadata => new { provider = "entra" };

		public bool RequiresLoopback => false;

		public ValueTask<ApiIdentity?> AuthenticateAsync(HttpContext context) => ValueTask.FromResult<ApiIdentity?>(new ApiIdentity("tenant", "admin"));
	}

	private static async Task<RunningApiHost> StartAsync(IAuthProvider auth) =>
		await ApiHost.StartAsync(new ApiHostOptions
		{
			AuthProvider = auth,
			DataSource = NpgsqlDataSource.Create((await ApiPostgresServer.Container()).GetConnectionString()),
			ToolVersion = "9.9.9",
			ListenAddress = IPAddress.Loopback,
		});

	private static async Task<HttpResponseMessage> QueryAsync(RunningApiHost host, string statement)
	{
		using var client = new HttpClient { BaseAddress = host.Url };
		return await client.PostAsJsonAsync("/direct-query", new { statement });
	}

	[Test]
	public async Task The_explicitly_enabled_local_host_runs_a_direct_query_and_returns_typed_rows()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, "SELECT 1 AS one, 'a' AS text, NULL::int AS nothing, true AS flag");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
		using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		var row = body.RootElement.GetProperty("rows")[0];
		await Assert.That(row.GetProperty("one").GetInt32()).IsEqualTo(1);
		await Assert.That(row.GetProperty("text").GetString()).IsEqualTo("a");
		await Assert.That(row.GetProperty("nothing").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(row.GetProperty("flag").GetBoolean()).IsTrue();
	}

	[Test]
	public async Task A_statement_without_rows_returns_an_empty_rows_array()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, "SELECT 1 WHERE false");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
		await Assert.That(await response.Content.ReadAsStringAsync()).IsEqualTo("""{"rows":[]}""");
	}

	[Test]
	public async Task A_deployment_host_has_no_direct_query_endpoint_even_for_an_authenticated_admin()
	{
		await using var host = await StartAsync(new DeploymentAuthProvider());

		var response = await QueryAsync(host, "SELECT 1");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.NotFound);
		await Assert.That(await response.Content.ReadAsStringAsync()).DoesNotContain("rows");
	}

	[Test]
	public async Task A_failing_query_returns_structured_failure_information()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, "SELECT * FROM table_that_does_not_exist");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
		using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		await Assert.That(body.RootElement.TryGetProperty("rows", out _)).IsFalse();
		var error = body.RootElement.GetProperty("error");
		await Assert.That(error.GetProperty("sqlState").GetString()).IsEqualTo("42P01");
		await Assert.That(error.GetProperty("message").GetString()).Contains("table_that_does_not_exist");
	}

	[Test]
	public async Task A_result_over_the_row_limit_is_a_structured_failure()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, $"SELECT generate_series(1, {DirectQuery.MaxRows + 1}) AS n");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
		using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		await Assert.That(body.RootElement.GetProperty("error").GetProperty("message").GetString()).Contains("LIMIT");
	}

	[Test]
	public async Task The_started_Local_API_host_serves_the_direct_query_on_loopback()
	{
		var container = await ApiPostgresServer.Container();
		var home = Directory.CreateTempSubdirectory("direct-query-shipyard-").FullName;
		var url = $"postgres://{PostgreSqlBuilder.DefaultUsername}:{PostgreSqlBuilder.DefaultPassword}@{container.Hostname}:{container.GetMappedPublicPort(5432)}/{PostgreSqlBuilder.DefaultDatabase}";
		string? Environment(string name) => name switch
		{
			"AGENT_SHIPYARD_HOME" => home,
			"AGENT_LOGBOOK_LOCAL_PG_URL" => url,
			_ => null,
		};

		try
		{
			await using var host = await LocalApiHost.StartAsync("9.9.9", Environment, "tester");
			using var client = new HttpClient { BaseAddress = new Uri(host.Discovery.Url) };

			var response = await client.PostAsJsonAsync("/direct-query", new { statement = "SELECT 1 AS one" });

			await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.OK);
			using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
			await Assert.That(body.RootElement.GetProperty("rows")[0].GetProperty("one").GetInt32()).IsEqualTo(1);
		}
		finally
		{
			Directory.Delete(home, recursive: true);
		}
	}

	[Test]
	public async Task A_cross_origin_style_request_is_refused()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));
		using var client = new HttpClient { BaseAddress = host.Url };

		var plainText = await client.PostAsync("/direct-query", new StringContent("""{"statement":"SELECT 1"}""", System.Text.Encoding.UTF8, "text/plain"));
		using var rebound = new HttpRequestMessage(HttpMethod.Post, "/direct-query")
		{
			Content = new StringContent("""{"statement":"SELECT 1"}""", System.Text.Encoding.UTF8, "application/json"),
		};
		rebound.Headers.Host = "evil.example";
		var rebindResponse = await client.SendAsync(rebound);

		await Assert.That(plainText.StatusCode).IsEqualTo(HttpStatusCode.UnsupportedMediaType);
		await Assert.That(rebindResponse.StatusCode).IsEqualTo(HttpStatusCode.Forbidden);
	}

	[Test]
	public async Task Duplicate_column_names_are_a_structured_failure()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, "SELECT 1 AS a, 2 AS a");

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
		using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		await Assert.That(body.RootElement.GetProperty("error").GetProperty("message").GetString()).Contains("duplicate");
	}

	[Test]
	public async Task A_value_type_that_cannot_be_returned_is_a_structured_failure_not_an_empty_error()
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, "SELECT '1.2.3.4'::inet AS address");

		var text = await response.Content.ReadAsStringAsync();
		using var body = JsonDocument.Parse(text);
		await Assert.That(body.RootElement.TryGetProperty(response.IsSuccessStatusCode ? "rows" : "error", out _)).IsTrue();
	}

	[Test]
	[Arguments("""{"other":1}""")]
	[Arguments("""{"statement":"  "}""")]
	[Arguments("not json")]
	public async Task A_request_without_a_statement_is_a_structured_failure(string requestBody)
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));
		using var client = new HttpClient { BaseAddress = host.Url };

		var response = await client.PostAsync("/direct-query", new StringContent(requestBody, System.Text.Encoding.UTF8, "application/json"));

		await Assert.That(response.StatusCode).IsEqualTo(HttpStatusCode.BadRequest);
		using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
		await Assert.That(body.RootElement.GetProperty("error").GetProperty("message").GetString()).IsNotNull();
	}

	[Test]
	[Arguments("CREATE TABLE direct_query_write (id int)")]
	[Arguments("COMMIT; CREATE TABLE direct_query_escape (id int)")]
	[Arguments("SELECT 1; CREATE TABLE direct_query_escape (id int)")]
	[Arguments("SET TRANSACTION READ WRITE; CREATE TABLE direct_query_escape (id int)")]
	public async Task A_direct_query_cannot_change_the_database(string statement)
	{
		await using var host = await StartAsync(LocalNoAuthProvider.Enable("tester"));

		var response = await QueryAsync(host, statement);

		await Assert.That(response.IsSuccessStatusCode).IsFalse();
		var check = await QueryAsync(host, "SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'direct_query_%'");
		using var body = JsonDocument.Parse(await check.Content.ReadAsStringAsync());
		await Assert.That(body.RootElement.GetProperty("rows")[0].GetProperty("n").GetInt32()).IsEqualTo(0);
	}
}
