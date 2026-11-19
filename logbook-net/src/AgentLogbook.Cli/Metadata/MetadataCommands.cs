using AgentLogbook.Cli.Commands;
using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Cli.Metadata;

/// <summary>The <c>help</c> command.</summary>
public sealed class HelpCommand : ICliCommand
{
	public const string Name = "help";

	public CommandSpec Spec { get; } = new(
		Name,
		"Show general or command-specific help.",
		["agent-logbook help [command]", "agent-logbook <command> --help"],
		Positionals: [new PositionalSpec("command", "Optional command name.")],
		Examples: ["agent-logbook help", "agent-logbook help schema --json", "agent-logbook schema --help"]);

	public int Run(CliInvocation invocation)
	{
		var catalog = invocation.Catalog;
		var option = invocation.Positionals.FirstOrDefault(word => word.StartsWith('-'));
		if (option is not null)
		{
			// The tree accepts any word as the command name, so an unknown option arrives here as a word.
			invocation.Runtime.Stderr.WriteLine($"{CliApp.CommandName}: unknown option '{option}' for {Name}. Use {CliApp.CommandName} {Name} --help.");
			return 1;
		}

		CommandSpec? command = null;
		if (invocation.Positionals.Count > 0)
		{
			var name = catalog.ResolveName(invocation.Positionals)!;
			if (!catalog.TryGetCommand(name, out var found))
			{
				invocation.Runtime.Stderr.WriteLine($"{CliApp.CommandName}: unknown command '{name}'. Use {CliApp.CommandName} help.");
				return 1;
			}

			var used = name.Count(character => character == ' ') + 1;
			if (invocation.Positionals.Count > used)
			{
				invocation.Runtime.Stderr.WriteLine(
					$"{CliApp.CommandName}: unexpected argument '{invocation.Positionals[used]}' for {Name}. Use {CliApp.CommandName} {Name} --help.");
				return 1;
			}

			command = found.Spec;
		}

		CliOutput.Write(invocation, MetadataPayloads.Help(catalog, command), MetadataRenderer.RenderHelp);
		return 0;
	}
}

/// <summary>The <c>schema</c> command.</summary>
public sealed class SchemaCommand : ICliCommand
{
	public const string Name = "schema";

	public CommandSpec Spec { get; } = new(
		Name,
		"Show machine-discoverable workflow schema and relation rules.",
		["agent-logbook schema", "agent-logbook schema --json"],
		Examples: ["agent-logbook schema", "agent-logbook schema --json"],
		Notes: ["Use this command to discover entity kinds, status flows, allowed relations, structural relations, and archive mappings."],
		Output: new OutputSpec(
			Human:
			[
				"Entity kinds section",
				"Relation types line",
				"Structural relation types line",
				"Allowed relations section",
				"Structural parent rules section",
			],
			Json: ["entityKinds", "relationTypes", "allowedRelations", "structuralRelationTypes", "parentRules"]));

	public int Run(CliInvocation invocation)
	{
		CliOutput.Write(invocation, WorkflowSchema.Current, MetadataRenderer.RenderSchema);
		return 0;
	}
}

/// <summary>The <c>capabilities</c> command.</summary>
public sealed class CapabilitiesCommand : ICliCommand
{
	public const string Name = "capabilities";

	public CommandSpec Spec { get; } = new(
		Name,
		"Show combined help and schema data in one discovery payload.",
		["agent-logbook capabilities", "agent-logbook capabilities --json"],
		Examples: ["agent-logbook capabilities", "agent-logbook capabilities --json"],
		Notes: ["Use this command when an agent wants the command catalog and workflow schema in one round trip."],
		Output: new OutputSpec(
			Human: ["General help text followed by the workflow schema summary"],
			Json: ["help", "schema"]));

	public int Run(CliInvocation invocation)
	{
		CliOutput.Write(invocation, MetadataPayloads.Capabilities(invocation.Catalog), MetadataRenderer.RenderCapabilities);
		return 0;
	}
}

/// <summary>Prints a payload as JSON or as its human-readable text, followed by one newline.</summary>
internal static class CliOutput
{
	public static void Write<T>(CliInvocation invocation, T payload, Func<T, string> render) =>
		invocation.Runtime.Stdout.Write((invocation.Json ? CliJson.Serialize(payload, invocation.Pretty) : render(payload)) + "\n");
}
