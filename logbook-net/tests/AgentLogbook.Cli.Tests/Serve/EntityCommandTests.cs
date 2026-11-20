using System.Text.Json;
using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.Serve;

/// <summary>The <c>create</c>, <c>show</c> and <c>list</c> commands against the real Local API host and real PostgreSQL.</summary>
[NotInParallel]
public class EntityCommandTests
{
	private static Func<string, string?> Environment(string shipyardHome) =>
		name => name == ShipyardLogbookFolder.HomeVariable ? shipyardHome : null;

	private static string NewWorkspace(string name)
	{
		var root = Path.Combine(Directory.CreateTempSubdirectory("logbook-cli-entities-").FullName, name);
		Directory.CreateDirectory(root);
		File.WriteAllText(Path.Combine(root, "pnpm-workspace.yaml"), "");
		return root;
	}

	private static (int Exit, string Out, string Err) Run(string workspace, ServeProcess host, params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(args, stdout, stderr, workspace, Environment(host.ShipyardHome));
		return (exit, stdout.ToString(), stderr.ToString());
	}

	private static async Task<ServeProcess> StartHostAsync()
	{
		var process = ServeProcess.Start(ServeProcess.NewShipyardHome(), await LocalPostgresServer.CreateDatabaseUrlAsync());
		await Assert.That(await process.WaitForDiscoveryAsync()).IsNotNull();
		return process;
	}

	private static JsonElement Json(string text) => JsonElement.Parse(text);

	/// <summary>The JSON that a command printed. A command that failed fails the test with its stderr.</summary>
	private static JsonElement Printed((int Exit, string Out, string Err) run) =>
		run.Exit == 0 ? Json(run.Out) : throw new InvalidOperationException($"The command exited with {run.Exit}: {run.Err}");

	[Test]
	public async Task Create_show_and_list_round_trip_with_json_output()
	{
		await using var host = await StartHostAsync();
		var workspace = NewWorkspace("round-trip");
		var bodyFile = Path.Combine(workspace, "body.md");
		File.WriteAllText(bodyFile, "First line\n\nSecond line\n");

		var initiative = Printed(Run(workspace, host, "create", "initiative", "--title", "Round trip", "--json"));
		var issue = Printed(Run(workspace, host, "create", "issue", "--title", "The issue", "--parent", initiative.GetProperty("reference").GetString()!,
			"--status", "in-progress", "--priority", "high", "--category", "technical", "--body-file", bodyFile, "--json"));
		var shown = Printed(Run(workspace, host, "show", issue.GetProperty("reference").GetString()!, "--json"));
		var listed = Printed(Run(workspace, host, "list", "issue", "--json"));

		await Assert.That(initiative.GetProperty("operation").GetString()).IsEqualTo("create");
		await Assert.That(initiative.GetProperty("status").GetString()).IsEqualTo("draft");
		await Assert.That(initiative.GetProperty("revision").GetInt32()).IsEqualTo(1);
		await Assert.That(issue.GetProperty("status").GetString()).IsEqualTo("in-progress");
		var entity = shown.GetProperty("entity");
		await Assert.That(entity.GetProperty("title").GetString()).IsEqualTo("The issue");
		await Assert.That(entity.GetProperty("body").GetString()).IsEqualTo("First line\n\nSecond line\n");
		await Assert.That(entity.GetProperty("contentHash").GetString()).IsEqualTo(ContentHash.ForEntity("The issue", "First line\n\nSecond line\n"));
		await Assert.That(entity.GetProperty("priority").GetString()).IsEqualTo("high");
		await Assert.That(entity.GetProperty("type").ValueKind).IsEqualTo(JsonValueKind.Null);
		await Assert.That(shown.GetProperty("incoming")[0].GetProperty("entity").GetProperty("reference").GetString()).IsEqualTo(initiative.GetProperty("reference").GetString());
		await Assert.That(shown.GetProperty("comments").GetProperty("total").GetInt32()).IsEqualTo(0);
		await Assert.That(listed.GetProperty("total").GetInt32()).IsEqualTo(1);
		await Assert.That(listed.GetProperty("items")[0].EnumerateObject().Select(property => property.Name)).IsEquivalentTo(["id", "reference", "kind", "status", "title"]);
		await Assert.That(listed.GetProperty("openBlockers").EnumerateObject().Single().Name).IsEqualTo(issue.GetProperty("reference").GetString());
	}

	[Test]
	public async Task The_human_output_is_one_line_for_create_and_list_and_a_relation_summary_for_show()
	{
		await using var host = await StartHostAsync();
		var workspace = NewWorkspace("human");
		var created = Run(workspace, host, "create", "initiative", "--title", "Human initiative");
		var reference = created.Out.Split(' ')[0];

		var issue = Run(workspace, host, "create", "issue", "--title", "Human issue", "--parent", reference);
		var issueReference = issue.Out.Split(' ')[0];
		var list = Run(workspace, host, "list", "issue");
		var show = Run(workspace, host, "show", issueReference);
		var none = Run(workspace, host, "list", "prd");

		await Assert.That(created).IsEqualTo((0, $"{reference} initiative draft Human initiative\n", string.Empty));
		await Assert.That(issue.Out).IsEqualTo($"{issueReference} issue todo Human issue\n");
		await Assert.That(list.Out).IsEqualTo($"{issueReference} todo Human issue\n");
		await Assert.That(show.Out).IsEqualTo(
			$"{issueReference} issue todo Human issue\nIncoming:\n{reference} initiative --tracks--> {issueReference}\nOutgoing:\nnone\nRelated Plan entries:\nnone\n");
		await Assert.That(none.Out).IsEqualTo("No prd entities found.\n");
	}

	[Test]
	public async Task Pretty_json_is_indented_and_a_list_filters_by_status_parent_and_limit()
	{
		await using var host = await StartHostAsync();
		var workspace = NewWorkspace("filters");
		var initiative = Printed(Run(workspace, host, "create", "initiative", "--title", "Filters", "--json")).GetProperty("reference").GetString()!;
		Run(workspace, host, "create", "issue", "--title", "One", "--parent", initiative, "--status", "in-progress");
		Run(workspace, host, "create", "issue", "--title", "Two", "--parent", initiative);
		Run(workspace, host, "create", "issue", "--title", "Three", "--parent", initiative);

		var inProgress = Printed(Run(workspace, host, "list", "issue", "--status", "in-progress", "--json"));
		var limited = Printed(Run(workspace, host, "list", "issue", "--parent", initiative, "--status", "todo, in-progress", "--limit", "2", "--json"));
		var pretty = Run(workspace, host, "list", "initiative", "--json", "--pretty");

		await Assert.That(inProgress.GetProperty("total").GetInt32()).IsEqualTo(1);
		await Assert.That(inProgress.GetProperty("items")[0].GetProperty("title").GetString()).IsEqualTo("One");
		await Assert.That(limited.GetProperty("total").GetInt32()).IsEqualTo(3);
		await Assert.That(limited.GetProperty("items").GetArrayLength()).IsEqualTo(2);
		await Assert.That(pretty.Out).StartsWith("{\n  \"items\": [\n    {\n      \"id\":");
		await Assert.That(pretty.Out).EndsWith("\n}\n");
	}

	[Test]
	public async Task Two_workspaces_do_not_see_each_others_entities()
	{
		await using var host = await StartHostAsync();
		var first = NewWorkspace("first-repo");
		var second = NewWorkspace("second-repo");
		var created = Printed(Run(first, host, "create", "initiative", "--title", "In the first repo", "--json")).GetProperty("reference").GetString()!;

		var listedInSecond = Run(second, host, "list", "initiative", "--json");
		var shownInSecond = Run(second, host, "show", created, "--json");
		var listedInFirst = Run(first, host, "list", "initiative", "--json");

		await Assert.That(Json(listedInSecond.Out).GetProperty("total").GetInt32()).IsEqualTo(0);
		await Assert.That(shownInSecond.Exit).IsEqualTo(1);
		await Assert.That(Json(shownInSecond.Err).GetProperty("error").GetString()).IsEqualTo($"Entity not found: {created}");
		await Assert.That(Json(listedInFirst.Out).GetProperty("total").GetInt32()).IsEqualTo(1);
	}

	[Test]
	public async Task A_refused_command_prints_one_line_on_stderr_and_nothing_on_stdout()
	{
		await using var host = await StartHostAsync();
		var workspace = NewWorkspace("errors");
		var missingFile = Path.Combine(workspace, "missing.md");

		var cases = new (string[] Args, string Message)[]
		{
			(["create", "bogus", "--title", "x"], "Unknown entity kind: bogus"),
			(["create", "initiative"], "--title is required for create."),
			(["create"], "Missing argument. Usage: create <kind>"),
			(["create", "initiative", "--title", "x", "--status", "todo"], "Invalid status for initiative: todo"),
			(["create", "debt", "--title", "x"], "Debt requires category and priority."),
			(["create", "issue", "--title", "x", "--parent", "missing"], "Entity not found: missing"),
			(["create", "initiative", "--title", "x", "--body-file", missingFile], $"Could not read --body-file {missingFile}: "),
			(["show"], "Missing argument. Usage: show <id>"),
			(["show", "missing"], "Entity not found: missing"),
			(["list"], "Missing argument. Usage: list <kind>"),
			(["list", "bogus"], "Unknown entity kind: bogus"),
			(["list", "issue", "--status", "done,bogus"], "Invalid issue status: bogus"),
			(["list", "issue", "--limit", "0"], "--limit must be a positive integer: 0"),
			(["list", "issue", "--limit", "many"], "--limit must be a positive integer: many"),
		};

		foreach (var (args, message) in cases)
		{
			var human = Run(workspace, host, args);
			var json = Run(workspace, host, [.. args, "--json"]);

			await Assert.That(human.Exit).IsEqualTo(1);
			await Assert.That(human.Out).IsEmpty();
			await Assert.That(human.Err).StartsWith($"agent-logbook {args[0]}: {message}");
			await Assert.That(human.Err.AsSpan().Count('\n')).IsEqualTo(1);
			await Assert.That(json.Exit).IsEqualTo(1);
			await Assert.That(json.Out).IsEmpty();
			await Assert.That(Json(json.Err).GetProperty("error").GetString()).StartsWith(message);
		}
	}

	[Test]
	public async Task Show_refuses_initiatives_and_plans_until_their_projections_are_ported()
	{
		await using var host = await StartHostAsync();
		var workspace = NewWorkspace("projections");
		var initiative = Printed(Run(workspace, host, "create", "initiative", "--title", "Initiative", "--json")).GetProperty("reference").GetString()!;
		var plan = Printed(Run(workspace, host, "create", "plan", "--title", "Plan", "--parent", initiative, "--json")).GetProperty("reference").GetString()!;

		var showInitiative = Run(workspace, host, "show", initiative);
		var showPlan = Run(workspace, host, "show", plan, "--json");

		await Assert.That(showInitiative.Exit).IsEqualTo(1);
		await Assert.That(showInitiative.Out).IsEmpty();
		await Assert.That(showInitiative.Err).IsEqualTo("agent-logbook show: Showing initiative entities is not available in this release.\n");
		await Assert.That(showPlan.Exit).IsEqualTo(1);
		await Assert.That(Json(showPlan.Err).GetProperty("error").GetString()).IsEqualTo("Showing plan entities is not available in this release.");
	}

	[Test]
	public async Task Without_a_running_host_the_commands_fail_with_the_start_hint()
	{
		var workspace = NewWorkspace("no-host");
		var emptyHome = ServeProcess.NewShipyardHome();

		foreach (var args in new[] { new[] { "create", "initiative", "--title", "x" }, ["show", "x"], ["list", "issue"] })
		{
			var stdout = new StringWriter();
			var stderr = new StringWriter();
			var exit = CliApp.Run(args, stdout, stderr, workspace, Environment(emptyHome));

			await Assert.That(exit).IsEqualTo(1);
			await Assert.That(stdout.ToString()).IsEmpty();
			await Assert.That(stderr.ToString()).StartsWith($"agent-logbook {args[0]}: No Local API host is running");
		}
	}

	[Test]
	public async Task The_help_of_the_commands_names_the_values_of_the_workflow()
	{
		var workspace = NewWorkspace("help");
		var home = ServeProcess.NewShipyardHome();
		var stdout = new StringWriter();

		var exit = CliApp.Run(["create", "--help"], stdout, new StringWriter(), workspace, Environment(home));

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(stdout.ToString()).Contains("kind | Entity kind to create. | required | allowed: project, epic, version, initiative, prd, userStory, adr, issue, debt, handoff, plan");
		await Assert.That(stdout.ToString()).Contains("--title <title> | Entity title. | required");
		await Assert.That(stdout.ToString()).Contains("allowed: active, approved, archived, blocked, current, deferred, done, draft, in-progress, open, paused, ready, resolved, superseded, todo");
		await Assert.That(stdout.ToString()).DoesNotContain("--link").And.DoesNotContain("--db");
	}
}
