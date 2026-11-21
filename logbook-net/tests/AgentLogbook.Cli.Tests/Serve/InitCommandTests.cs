using System.Text.Json;
using AgentLogbook.Client;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.ShipyardData;
using AgentLogbook.Core.Workspaces;

namespace AgentLogbook.Cli.Tests.Serve;

[NotInParallel]
public class InitCommandTests
{
	private static Func<string, string?> Environment(string shipyardHome, params (string Name, string Value)[] extra) =>
		name => name == ShipyardLogbookFolder.HomeVariable
			? shipyardHome
			: extra.FirstOrDefault(item => item.Name == name).Value;

	private static string NewWorkspace(string name)
	{
		var root = Path.Combine(Directory.CreateTempSubdirectory("logbook-cli-init-").FullName, name);
		Directory.CreateDirectory(root);
		File.WriteAllText(Path.Combine(root, "pnpm-workspace.yaml"), "");
		return root;
	}

	private static (int Exit, string Out, string Err) Run(string workspace, Func<string, string?> environment, params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(args, stdout, stderr, workspace, environment);
		return (exit, stdout.ToString(), stderr.ToString());
	}

	private static async Task<(ServeProcess Process, string Url)> StartHostAsync()
	{
		var process = ServeProcess.Start(ServeProcess.NewShipyardHome(), await LocalPostgresServer.CreateDatabaseUrlAsync());
		var discovery = await process.WaitForDiscoveryAsync();
		await Assert.That(discovery).IsNotNull();
		return (process, discovery!.Url);
	}

	[Test]
	public async Task Init_opens_the_workspace_of_the_folder_and_prints_the_api_url_as_json()
	{
		var (process, url) = await StartHostAsync();
		await using var _ = process;
		var workspace = NewWorkspace("My Init Repo");

		var (exit, output, error) = Run(workspace, Environment(process.ShipyardHome), "init", "--json");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(output).IsEqualTo($"{{\"command\":\"init\",\"dbPath\":\"{url}\",\"status\":\"ok\"}}\n");
		await Assert.That(error).IsEmpty();

		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri(url), ProjectIdentity = "my-init-repo" });
		var workspaceAfter = await store.InitializeWorkspaceAsync();
		await Assert.That(workspaceAfter.Created).IsFalse();
		await Assert.That(workspaceAfter.Project.Title).IsEqualTo("my-init-repo");
		await Assert.That(workspaceAfter.TenantId).IsEqualTo($"local-{System.Environment.UserName}");
		await Assert.That(workspaceAfter.DefaultProject.Id).IsEqualTo(DefaultWorkspace.Project.StableId);
		await Assert.That(workspaceAfter.DefaultEpic.Id).IsEqualTo(DefaultWorkspace.Epic.StableId);
	}

	[Test]
	public async Task Init_prints_a_sentence_for_humans_and_a_repeat_run_prints_the_same()
	{
		var (process, url) = await StartHostAsync();
		await using var _ = process;
		var workspace = NewWorkspace("repeat-repo");
		var environment = Environment(process.ShipyardHome);

		var first = Run(workspace, environment, "init");
		var second = Run(workspace, environment, "init");
		var pretty = Run(workspace, environment, "init", "--json", "--pretty");

		await Assert.That(first).IsEqualTo((0, $"Initialized data store at {url}\n", string.Empty));
		await Assert.That(second).IsEqualTo(first);
		await Assert.That(pretty.Out).IsEqualTo($"{{\n  \"command\": \"init\",\n  \"dbPath\": \"{url}\",\n  \"status\": \"ok\"\n}}\n");

		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri(url), ProjectIdentity = "repeat-repo" });
		await Assert.That((await store.InitializeWorkspaceAsync()).Created).IsFalse();
	}

	[Test]
	public async Task Init_uses_the_project_identity_of_the_resolver_not_only_the_folder_name()
	{
		var (process, url) = await StartHostAsync();
		await using var _ = process;
		var workspace = NewWorkspace("folder-name");
		File.WriteAllText(Path.Combine(workspace, ".agent-shipyard.json"), """{"projectIdentity":"From The File"}""");

		var (exit, _, _) = Run(workspace, Environment(process.ShipyardHome), "init");

		await Assert.That(exit).IsEqualTo(0);
		using var store = new HttpStore(new HttpStoreOptions { BaseUrl = new Uri(url), ProjectIdentity = "from-the-file" });
		var opened = await store.InitializeWorkspaceAsync();
		await Assert.That(opened.Created).IsFalse();
		await Assert.That(opened.Project.Title).IsEqualTo("from-the-file");
	}

	[Test]
	public async Task Init_through_the_api_url_override_reaches_that_host()
	{
		var (process, url) = await StartHostAsync();
		await using var _ = process;
		var workspace = NewWorkspace("override-repo");
		var emptyHome = ServeProcess.NewShipyardHome();

		var (exit, output, _) = Run(workspace, Environment(emptyHome, (BackendRouter.ApiUrlVariable, url)), "init", "--json");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(output).IsEqualTo($"{{\"command\":\"init\",\"dbPath\":\"{url}\",\"status\":\"ok\"}}\n");
	}

	[Test]
	public async Task Init_that_cannot_start_a_host_fails_with_the_reason_and_writes_nothing_to_stdout()
	{
		var workspace = NewWorkspace("no-host");
		var emptyHome = ServeProcess.NewShipyardHome();
		var environment = Environment(emptyHome, (LocalPostgresSelection.UrlVariable, LocalPostgresServer.UnreachableUrl));

		var human = Run(workspace, environment, "init");
		var json = Run(workspace, environment, "init", "--json");

		await Assert.That(human.Exit).IsEqualTo(1);
		await Assert.That(human.Out).IsEmpty();
		await Assert.That(human.Err).StartsWith("agent-logbook init: The Local API host did not start.");
		await Assert.That(json.Exit).IsEqualTo(1);
		await Assert.That(json.Out).IsEmpty();
		using var error = JsonDocument.Parse(json.Err);
		await Assert.That(error.RootElement.GetProperty("error").GetString()).StartsWith("The Local API host did not start.");
		await Assert.That(File.Exists(Path.Combine(emptyHome, "logbook", ShipyardLogbookFolder.DiscoveryFileName))).IsFalse();
	}

	[Test]
	public async Task Init_reports_an_unusable_override_and_an_unreachable_host()
	{
		var workspace = NewWorkspace("bad-route");
		var home = ServeProcess.NewShipyardHome();

		var bad = Run(workspace, Environment(home, (BackendRouter.ApiUrlVariable, "not a url")), "init");
		var unreachable = Run(workspace, Environment(home, (BackendRouter.ApiUrlVariable, "http://127.0.0.1:1")), "init");

		await Assert.That(bad.Exit).IsEqualTo(1);
		await Assert.That(bad.Err).Contains("AGENT_LOGBOOK_API_URL must be an absolute http or https URL");
		await Assert.That(unreachable.Exit).IsEqualTo(1);
		await Assert.That(unreachable.Out).IsEmpty();
		await Assert.That(unreachable.Err).Contains("could not reach");
	}

	[Test]
	public async Task Init_rejects_an_unknown_option_and_an_extra_argument_without_calling_a_host()
	{
		var workspace = NewWorkspace("bad-args");
		var home = ServeProcess.NewShipyardHome();

		var option = Run(workspace, Environment(home), "init", "--bogus");
		var argument = Run(workspace, Environment(home), "init", "extra");

		await Assert.That(option).IsEqualTo((1, string.Empty, "agent-logbook: unknown option '--bogus' for init. Use agent-logbook init --help.\n"));
		await Assert.That(argument.Exit).IsEqualTo(1);
		await Assert.That(argument.Out).IsEmpty();
	}

	[Test]
	public async Task Init_help_describes_the_command_and_names_the_output_fields()
	{
		var workspace = NewWorkspace("help");
		var home = ServeProcess.NewShipyardHome();

		var help = Run(workspace, Environment(home), "init", "--help");
		var viaHelp = Run(workspace, Environment(home), "help", "init");

		await Assert.That(help.Exit).IsEqualTo(0);
		await Assert.That(help.Out).Contains("Initialize the local data store.");
		await Assert.That(help.Out).Contains("Initialized data store at <dbPath>");
		await Assert.That(help.Out).Contains("    dbPath");
		await Assert.That(viaHelp).IsEqualTo(help);
	}
}
