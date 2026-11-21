using System.CommandLine;
using System.Text.Json;
using AgentLogbook.Cli.Commands;

namespace AgentLogbook.Cli.Tests;

public class MetadataCommandTests
{
	private static readonly string[] ImplementedCommands = ["project-identity", "init", "create", "show", "list", "host", "help", "schema", "capabilities"];

	private static (int Exit, string Out, string Err) Run(params string[] args) => Run(CliApp.Catalog, args);

	private static (int Exit, string Out, string Err) Run(CommandCatalog catalog, params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(catalog, args, stdout, stderr);
		return (exit, stdout.ToString(), stderr.ToString());
	}

	private static JsonDocument Json(string text) => JsonDocument.Parse(text);

	private sealed class ExtraCommand : ICliCommand
	{
		public CommandSpec Spec { get; } = new(
			"extra-path",
			"A path that a test adds.",
			["agent-logbook extra-path"],
			Options: [new OptionSpec("--limit <count>", "Return at most this many.")]);

		public int Run(CliInvocation invocation) => 0;
	}

	[Test]
	public async Task General_help_lists_only_the_implemented_commands_and_the_global_options()
	{
		var (exit, output, error) = Run("help");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(error).IsEmpty();
		await Assert.That(output).StartsWith("agent-logbook\n\nStructured workflow CLI");
		foreach (var name in ImplementedCommands)
		{
			await Assert.That(output).Contains($"\n  {name}");
		}

		await Assert.That(output).DoesNotContain("\n  edit ").And.DoesNotContain("\n  daemon").And.DoesNotContain("--db");
		await Assert.That(output).Contains("\n  --json").And.Contains("\n  --pretty").And.Contains("\n  --help, -h");
	}

	[Test]
	public async Task General_help_json_names_the_tool_its_commands_and_discovery()
	{
		var (exit, output, _) = Run("help", "--json");
		using var document = Json(output);
		var root = document.RootElement;

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(output).EndsWith("}\n");
		await Assert.That(root.GetProperty("name").GetString()).IsEqualTo("agent-logbook");
		await Assert.That(root.GetProperty("commands").EnumerateArray().Select(c => c.GetProperty("name").GetString()!))
			.IsEquivalentTo(ImplementedCommands);
		await Assert.That(root.TryGetProperty("command", out _)).IsFalse();
		await Assert.That(root.GetProperty("globalOptions").GetArrayLength()).IsEqualTo(3);
		await Assert.That(root.GetProperty("discovery").EnumerateArray().Select(d => d.GetString()))
			.All().Satisfy(line => line!.Contains("agent-logbook"));
	}

	[Test]
	[Arguments("project-identity")]
	[Arguments("create")]
	[Arguments("show")]
	[Arguments("list")]
	[Arguments("help")]
	[Arguments("schema")]
	[Arguments("capabilities")]
	public async Task Command_help_is_the_same_through_help_and_through_the_help_flag(string command)
	{
		var viaHelp = Run("help", command);
		var viaFlag = Run(command, "--help");
		var viaShortFlag = Run(command, "-h");

		await Assert.That(viaHelp.Exit).IsEqualTo(0);
		await Assert.That(viaHelp.Out).StartsWith($"{command}\n\n");
		await Assert.That(viaFlag.Out).IsEqualTo(viaHelp.Out);
		await Assert.That(viaShortFlag.Out).IsEqualTo(viaHelp.Out);
		await Assert.That(viaHelp.Err).IsEmpty();
	}

	[Test]
	public async Task Command_help_json_carries_the_command_description()
	{
		var (exit, output, _) = Run("help", "schema", "--json");
		using var document = Json(output);
		var command = document.RootElement.GetProperty("command");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(command.GetProperty("name").GetString()).IsEqualTo("schema");
		await Assert.That(command.GetProperty("usage").EnumerateArray().Select(u => u.GetString()!))
			.IsEquivalentTo(["agent-logbook schema", "agent-logbook schema --json"]);
	}

	[Test]
	public async Task Pretty_json_is_indented()
	{
		var (_, pretty, _) = Run("schema", "--json", "--pretty");
		var (_, compact, _) = Run("schema", "--json");

		await Assert.That(pretty).Contains("\n  \"entityKinds\"");
		await Assert.That(compact.TrimEnd('\n')).DoesNotContain("\n");
		await Assert.That(pretty).DoesNotContain("\r");
	}

	[Test]
	public async Task Schema_human_output_has_the_workflow_sections()
	{
		var (exit, output, error) = Run("schema");

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(error).IsEmpty();
		await Assert.That(output).StartsWith("Entity kinds:\n  project (PROJ) statuses=draft, active, paused, done initial=draft archive=done\n");
		await Assert.That(output).Contains("\nRelation types: blocks, constrains,");
		await Assert.That(output).Contains("\nStructural relation types: contains, owns, records, tracks, creates, decomposes\n");
		await Assert.That(output).Contains("\n  initiative --tracks--> issue\n");
		await Assert.That(output).Contains("\nContext:\n").And.Contains("\nIssue comments:\n").And.Contains("\nPlan entries:\n");
		await Assert.That(output).EndsWith("updatedAt\n");
	}

	[Test]
	public async Task Schema_json_has_the_documented_fields_with_camel_case_keys()
	{
		var (_, output, _) = Run("schema", "--json");
		using var document = Json(output);
		var root = document.RootElement;

		await Assert.That(root.EnumerateObject().Select(p => p.Name)).IsEquivalentTo(
		[
			"entityKinds", "entityCategories", "entityPriorities", "relationTypes", "allowedRelations",
			"structuralRelationTypes", "parentRules", "context", "issueComments", "planEntries",
		]);
		await Assert.That(root.GetProperty("entityKinds")[0].GetProperty("idPrefix").GetString()).IsEqualTo("PROJ");
		await Assert.That(root.GetProperty("allowedRelations")[0].GetProperty("fromKind").GetString()).IsEqualTo("project");
		await Assert.That(root.GetProperty("context").GetProperty("listCommand").GetString()).IsEqualTo("agent-logbook context list --json");
	}

	[Test]
	public async Task Capabilities_json_holds_the_help_and_the_schema()
	{
		var (exit, output, _) = Run("capabilities", "--json");
		var (_, helpOutput, _) = Run("help", "--json");
		var (_, schemaOutput, _) = Run("schema", "--json");
		using var document = Json(output);

		await Assert.That(exit).IsEqualTo(0);
		await Assert.That(document.RootElement.GetProperty("help").GetRawText()).IsEqualTo(helpOutput.TrimEnd('\n'));
		await Assert.That(document.RootElement.GetProperty("schema").GetRawText()).IsEqualTo(schemaOutput.TrimEnd('\n'));
	}

	[Test]
	public async Task Capabilities_human_output_is_the_help_then_the_schema()
	{
		var (_, output, _) = Run("capabilities");
		var (_, help, _) = Run("help");
		var (_, schema, _) = Run("schema");

		await Assert.That(output).IsEqualTo($"{help.TrimEnd('\n')}\n\n{schema}");
	}

	[Test]
	public async Task A_command_that_is_added_to_the_catalog_appears_in_every_metadata_path()
	{
		var catalog = new CommandCatalog([.. CliApp.Catalog.Commands, new ExtraCommand()]);

		var general = Run(catalog, "help");
		var commandHelp = Run(catalog, "help", "extra-path");
		var viaFlag = Run(catalog, "extra-path", "--help");
		var capabilities = Run(catalog, "capabilities", "--json");
		using var document = Json(capabilities.Out);
		var names = document.RootElement.GetProperty("help").GetProperty("commands").EnumerateArray()
			.Select(c => c.GetProperty("name").GetString()).ToList();

		await Assert.That(general.Out).Contains("\n  extra-path");
		await Assert.That(commandHelp.Out).StartsWith("extra-path\n\nA path that a test adds.");
		await Assert.That(commandHelp.Out).Contains("--limit <count> | Return at most this many.");
		await Assert.That(viaFlag.Out).IsEqualTo(commandHelp.Out);
		await Assert.That(names).Contains("extra-path");
		await Assert.That(CommandModel.Walk(catalog.Root).Select(c => c.Id)).Contains("cli:extra-path");
		await Assert.That(CliApp.Catalog.Specs.Select(s => s.Name)).DoesNotContain("extra-path");
	}

	[Test]
	[Arguments("schema", "--bogus", "unknown option '--bogus' for schema", "schema --help")]
	[Arguments("capabilities", "--bogus", "unknown option '--bogus' for capabilities", "capabilities --help")]
	[Arguments("help", "--bogus", "unknown option '--bogus' for help", "help --help")]
	[Arguments("schema", "extra", "unexpected argument 'extra' for schema", "schema --help")]
	[Arguments("capabilities", "extra", "unexpected argument 'extra' for capabilities", "capabilities --help")]
	public async Task Invalid_input_fails_on_stderr_without_output(string command, string argument, string message, string usage)
	{
		var (exit, output, error) = Run(command, "--json", argument);

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(output).IsEmpty();
		await Assert.That(error).IsEqualTo($"agent-logbook: {message}. Use agent-logbook {usage}.\n".ReplaceLineEndings());
	}

	[Test]
	[Arguments("nosuch")]
	[Arguments("edit")]
	[Arguments("daemon")]
	public async Task An_unknown_or_unported_command_fails_instead_of_succeeding_as_a_stub(string command)
	{
		var direct = Run(command);
		var viaHelp = Run("help", command);

		await Assert.That(direct.Exit).IsEqualTo(1);
		await Assert.That(direct.Out).IsEmpty();
		await Assert.That(direct.Err).Contains($"unknown command '{command}'");
		await Assert.That(viaHelp.Exit).IsEqualTo(1);
		await Assert.That(viaHelp.Out).IsEmpty();
		await Assert.That(viaHelp.Err).Contains($"unknown command '{command}'");
	}

	[Test]
	[Arguments("schema", "extra")]
	[Arguments("help", "schema")]
	public async Task Help_rejects_words_after_the_command_name(params string[] words)
	{
		var (exit, output, error) = Run(["help", .. words]);

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(output).IsEmpty();
		await Assert.That(error).Contains("unexpected argument").And.Contains("agent-logbook help --help");
	}

	[Test]
	public async Task The_root_rejects_an_unknown_option()
	{
		var (exit, output, error) = Run("--db", "x");

		await Assert.That(exit).IsEqualTo(1);
		await Assert.That(output).IsEmpty();
		await Assert.That(error).Contains("unknown option '--db'").And.Contains("agent-logbook help");
	}
}
