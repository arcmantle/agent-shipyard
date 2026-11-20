using System.Text.Json.Nodes;
using AgentLogbook.Cli.Tests.Serve;
using AgentLogbook.Core.ShipyardData;
using AgentLogbook.Mcp;

namespace AgentLogbook.Cli.Tests.Mcp;

/// <summary>The installed <c>agent-logbook --mcp</c> command as an MCP host runs it: a real process on standard input and output.</summary>
[NotInParallel]
public class McpServerTests
{
	private static string NewWorkspace(string name)
	{
		var root = Path.Combine(Directory.CreateTempSubdirectory("logbook-mcp-").FullName, name);
		Directory.CreateDirectory(root);
		return root;
	}

	/// <summary>A path without the macOS <c>/private</c> prefix that a process working directory reports for a temporary folder.</summary>
	private static string SamePath(string path) => Path.GetFullPath(path).Replace("/private/var/", "/var/", StringComparison.Ordinal);

	private static JsonNode Text(JsonNode result) => JsonNode.Parse(result["content"]![0]!["text"]!.GetValue<string>())!;

	[Test]
	public async Task The_server_reports_its_info_and_lists_only_the_implemented_tools()
	{
		await using var mcp = McpProcess.Start(NewWorkspace("info"), null, []);

		var initialized = await mcp.InitializeAsync();
		var tools = (await mcp.RequestAsync("tools/list", new JsonObject()))["result"]!["tools"]!.AsArray();

		await Assert.That(initialized["serverInfo"]!["name"]!.GetValue<string>()).IsEqualTo("agent-logbook");
		await Assert.That(initialized["serverInfo"]!["version"]!.GetValue<string>()).IsEqualTo(CliApp.Version);
		await Assert.That(tools.Select(tool => tool!["name"]!.GetValue<string>()).ToArray()).IsEquivalentTo(["project_identity", "resource_show"]);
		await Assert.That(tools.Single(tool => tool!["name"]!.GetValue<string>() == "resource_show")!["annotations"]!["readOnlyHint"]!.GetValue<bool>()).IsTrue();
		await Assert.That(tools.Single(tool => tool!["name"]!.GetValue<string>() == "project_identity")!["inputSchema"]!["properties"]!.AsObject().Count).IsEqualTo(0);
		await Assert.That(mcp.Error).IsEqualTo(string.Empty);
	}

	[Test]
	public async Task Project_identity_uses_the_folder_of_the_process_when_the_host_offers_no_root()
	{
		var workspace = NewWorkspace("fallback-folder");
		await using var mcp = McpProcess.Start(workspace, null, []);
		await mcp.InitializeAsync();

		var result = await mcp.CallToolAsync("project_identity", new JsonObject());

		var identity = Text(result);
		await Assert.That(identity["projectIdentity"]!.GetValue<string>()).IsEqualTo("fallback-folder");
		await Assert.That(SamePath(identity["workspaceRoot"]!.GetValue<string>())).IsEqualTo(SamePath(workspace));
		await Assert.That(result["structuredContent"]!.ToJsonString()).IsEqualTo(identity.ToJsonString());
	}

	[Test]
	public async Task Project_identity_follows_the_first_file_root_of_the_host()
	{
		var other = NewWorkspace("from-the-root");
		await using var mcp = McpProcess.Start(
			NewWorkspace("process-folder"),
			null,
			[],
			method => method == "roots/list"
				? new JsonObject { ["roots"] = new JsonArray(
					new JsonObject { ["uri"] = "https://example.com/not-a-file" },
					new JsonObject { ["uri"] = new Uri(other).AbsoluteUri }) }
				: null);
		await mcp.InitializeAsync(withRoots: true);

		var identity = Text(await mcp.CallToolAsync("project_identity", new JsonObject()));

		await Assert.That(identity["projectIdentity"]!.GetValue<string>()).IsEqualTo("from-the-root");
		await Assert.That(SamePath(identity["workspaceRoot"]!.GetValue<string>())).IsEqualTo(SamePath(other));
	}

	[Test]
	public async Task The_project_identity_argument_replaces_the_identity_of_the_workspace()
	{
		await using var mcp = McpProcess.Start(NewWorkspace("ignored-name"), null, ["--project-identity", "Chosen Identity"]);
		await mcp.InitializeAsync();

		var identity = Text(await mcp.CallToolAsync("project_identity", new JsonObject()));

		await Assert.That(identity["projectIdentity"]!.GetValue<string>()).IsEqualTo("Chosen Identity");
	}

	[Test]
	public async Task Resource_show_reads_a_real_postgres_backed_entity_through_http_store_without_its_body()
	{
		var shipyard = ServeProcess.NewShipyardHome();
		await using var host = ServeProcess.Start(shipyard, await LocalPostgresServer.CreateDatabaseUrlAsync());
		await Assert.That(await host.WaitForDiscoveryAsync()).IsNotNull();
		var workspace = NewWorkspace("mcp-shown");
		var created = RunCli(workspace, shipyard, "create", "initiative", "--title", "Shown over MCP", "--json");
		var reference = JsonNode.Parse(created)!["reference"]!.GetValue<string>();

		await using var mcp = McpProcess.Start(workspace, shipyard, []);
		await mcp.InitializeAsync();
		var result = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = reference } });

		await Assert.That(result["isError"]?.GetValue<bool>() ?? false).IsFalse();
		var shown = Text(result);
		var entity = shown["entity"]!.AsObject();
		await Assert.That(entity["reference"]!.GetValue<string>()).IsEqualTo(reference);
		await Assert.That(entity["title"]!.GetValue<string>()).IsEqualTo("Shown over MCP");
		await Assert.That(entity["kind"]!.GetValue<string>()).IsEqualTo("initiative");
		await Assert.That(entity["category"] is null).IsTrue();
		await Assert.That(entity.ContainsKey("body")).IsFalse();
		await Assert.That(entity.ContainsKey("bodySource")).IsFalse();
		await Assert.That(shown["reads"]!["details"]!.ToJsonString())
			.IsEqualTo($$"""{"command":"agent-logbook","arguments":["show","{{reference}}","--json"]}""");
		await Assert.That(shown["reads"]!["body"]!["tool"]!.GetValue<string>()).IsEqualTo("resource_body");
		await Assert.That(result["structuredContent"]!.ToJsonString()).IsEqualTo(shown.ToJsonString());
	}

	[Test]
	public async Task Resource_show_reports_a_missing_entity_as_a_tool_error()
	{
		var shipyard = ServeProcess.NewShipyardHome();
		await using var host = ServeProcess.Start(shipyard, await LocalPostgresServer.CreateDatabaseUrlAsync());
		await Assert.That(await host.WaitForDiscoveryAsync()).IsNotNull();
		await using var mcp = McpProcess.Start(NewWorkspace("mcp-missing"), shipyard, []);
		await mcp.InitializeAsync();

		var result = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = "ISS_NOSUCHENTITY" } });

		await Assert.That(result["isError"]!.GetValue<bool>()).IsTrue();
		await Assert.That(result["content"]![0]!["text"]!.GetValue<string>()).IsEqualTo("Entity not found: ISS_NOSUCHENTITY");
	}

	[Test]
	public async Task Resource_show_reports_an_unreachable_api_host_and_a_resource_that_is_not_ported()
	{
		await using var mcp = McpProcess.Start(NewWorkspace("mcp-no-host"), ServeProcess.NewShipyardHome(), []);
		await mcp.InitializeAsync();

		var noHost = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = "ISS_ANY" } });
		var notPorted = await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "context" } });

		await Assert.That(noHost["isError"]!.GetValue<bool>()).IsTrue();
		await Assert.That(noHost["content"]![0]!["text"]!.GetValue<string>()).StartsWith("No Local API host is running");
		await Assert.That(notPorted["isError"]!.GetValue<bool>()).IsTrue();
	}

	[Test]
	public async Task A_session_writes_only_protocol_messages_to_standard_output_and_ends_when_the_host_closes_the_input()
	{
		await using var mcp = McpProcess.Start(NewWorkspace("clean-stdout"), ServeProcess.NewShipyardHome(), []);
		await mcp.InitializeAsync();
		await mcp.CallToolAsync("project_identity", new JsonObject());
		await mcp.CallToolAsync("resource_show", new JsonObject { ["request"] = new JsonObject { ["resource"] = "entity", ["reference"] = "ISS_ANY" } });

		var exitCode = await mcp.CloseInputAndWaitAsync();
		var rest = await mcp.DrainOutputAsync();

		await Assert.That(exitCode).IsEqualTo(0);
		await Assert.That(rest).IsEmpty();
		await Assert.That(mcp.Error).IsEqualTo(string.Empty);
	}

	[Test]
	public async Task Invalid_arguments_after_mcp_print_the_usage_and_start_no_server()
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();

		var exit = await CliApp.RunAsync(["--mcp", "--bogus"], stdout, stderr, CancellationToken.None);
		var missingValue = await CliApp.RunAsync(["--mcp", "--project-identity"], new StringWriter(), new StringWriter(), CancellationToken.None);

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(stdout.ToString()).IsEqualTo(string.Empty);
		await Assert.That(stderr.ToString()).IsEqualTo("agent-logbook: Usage: --mcp [--project-identity <projectIdentity>]\n".ReplaceLineEndings());
		await Assert.That(missingValue).IsEqualTo(1);
	}

	[Test]
	public async Task The_mcp_flag_is_only_special_as_the_first_argument()
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();

		var exit = await CliApp.RunAsync(["schema", "--mcp"], stdout, stderr, CancellationToken.None);

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(stdout.ToString()).IsEqualTo(string.Empty);
		await Assert.That(stderr.ToString()).IsEqualTo("agent-logbook: unknown option '--mcp' for schema. Use agent-logbook schema --help.\n".ReplaceLineEndings());
	}

	[Test]
	public async Task Launch_arguments_accept_nothing_or_one_project_identity()
	{
		await Assert.That(McpLaunch.TryParse([], out var none, out _)).IsTrue();
		await Assert.That(none).IsNull();
		await Assert.That(McpLaunch.TryParse(["--project-identity", "x"], out var identity, out _)).IsTrue();
		await Assert.That(identity).IsEqualTo("x");
		await Assert.That(McpLaunch.TryParse(["--project-identity", ""], out _, out _)).IsFalse();
		await Assert.That(McpLaunch.TryParse(["x"], out _, out var usage)).IsFalse();
		await Assert.That(usage).IsEqualTo(McpLaunch.Usage);
	}

	private static string RunCli(string workspace, string shipyardHome, params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(args, stdout, stderr, workspace, name => name == ShipyardLogbookFolder.HomeVariable ? shipyardHome : null);
		return exit == 0 ? stdout.ToString() : throw new InvalidOperationException($"The command exited with {exit}: {stderr}");
	}
}
