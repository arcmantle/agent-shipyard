using System.Text.Json;
using AgentLogbook.Cli.Commands;

namespace AgentLogbook.Cli.Tests;

public class CommandModelTests
{
	private static readonly string[] GlobalOptionNames = ["--json", "--pretty", "--help", "--version"];

	private static JsonElement LoadInventory()
	{
		for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
		{
			var file = Path.Combine(directory.FullName, "contract", "inventory.json");
			if (File.Exists(file))
			{
				return JsonElement.Parse(File.ReadAllText(file));
			}
		}

		throw new FileNotFoundException("contract/inventory.json was not found above the test output folder.");
	}

	private static Dictionary<string, JsonElement> InventoryCommands() =>
		LoadInventory().GetProperty("cli").GetProperty("commands").EnumerateArray()
			.ToDictionary(command => command.GetProperty("id").GetString()!);

	/// <summary>Commands that only the .NET tool has. The TypeScript inventory cannot list them, and they have no golden case.</summary>
	private static readonly string[] NewCommands = ["cli:host"];

	[Test]
	public async Task The_tree_has_the_root_and_one_node_for_each_registered_command()
	{
		var model = CommandModel.Walk(CliApp.Catalog.Root);

		await Assert.That(model.Select(command => command.Id)).IsEquivalentTo(
			["cli:(default)", "cli:project-identity", "cli:init", "cli:create", "cli:show", "cli:list", "cli:host", "cli:help", "cli:schema", "cli:capabilities"]);
		await Assert.That(model.Select(command => command.Id).Skip(1))
			.IsEquivalentTo(CliApp.Catalog.Specs.Select(spec => $"cli:{spec.Name}"));
	}

	[Test]
	public async Task Every_command_declares_the_json_pretty_and_help_options()
	{
		foreach (var command in CommandModel.Walk(CliApp.Catalog.Root))
		{
			var names = command.Options.SelectMany(option => option.Names).ToList();
			await Assert.That(names).Contains("--json").And.Contains("--pretty").And.Contains("--help").And.Contains("-h");
		}
	}

	[Test]
	public async Task The_help_command_declares_its_optional_command_argument()
	{
		var help = CommandModel.Walk(CliApp.Catalog.Root).Single(command => command.Id == "cli:help");
		var argument = help.Arguments.Single();

		await Assert.That(argument.Names).IsEquivalentTo(["command"]);
		await Assert.That(argument.MinimumValues).IsEqualTo(0);
		await Assert.That(argument.Required).IsFalse();
	}

	[Test]
	public async Task Every_implemented_command_exists_in_the_contract_inventory_with_known_options()
	{
		var inventory = InventoryCommands();

		foreach (var command in CommandModel.Walk(CliApp.Catalog.Root).Where(command => command.Path.Count > 0 && !NewCommands.Contains(command.Id)))
		{
			await Assert.That(inventory.ContainsKey(command.Id)).IsTrue();
			var legacyOptions = inventory[command.Id].GetProperty("options").EnumerateArray()
				.SelectMany(option => option.GetProperty("names").EnumerateArray().Select(name => name.GetString()!))
				.ToHashSet();
			var declared = command.Options.SelectMany(option => option.Names).Where(name => name.StartsWith("--", StringComparison.Ordinal));
			foreach (var name in declared.Where(name => !GlobalOptionNames.Contains(name)))
			{
				await Assert.That(legacyOptions).Contains(name);
			}
		}
	}

	[Test]
	public async Task The_metadata_commands_are_in_the_capabilities_inventory()
	{
		var inventory = InventoryCommands();

		foreach (var id in new[] { "cli:help", "cli:schema", "cli:capabilities" })
		{
			await Assert.That(inventory[id].GetProperty("inCapabilities").GetBoolean()).IsTrue();
		}
	}

	[Test]
	public async Task The_unported_inventory_commands_are_exactly_the_ones_without_a_registered_command()
	{
		var implemented = CliApp.Catalog.Specs.Select(spec => $"cli:{spec.Name}").ToHashSet();
		var unported = InventoryCommands().Keys.Where(id => id != "cli:(default)" && !implemented.Contains(id)).ToList();

		await Assert.That(unported).Contains("cli:edit").And.Contains("cli:daemon");
		await Assert.That(unported.Intersect(implemented)).IsEmpty();
		await Assert.That(InventoryCommands().Keys.Intersect(NewCommands)).IsEmpty();
	}
}
