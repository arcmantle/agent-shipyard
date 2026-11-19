using AgentLogbook.Cli.Commands;
using AgentLogbook.Core.WorkflowSchema;

namespace AgentLogbook.Cli.Metadata;

/// <summary>One command in the general help catalog.</summary>
public sealed record CommandSummary(string Name, string Summary, IReadOnlyList<string> Usage);

/// <summary>The <c>help</c> payload. The member order is the JSON key order.</summary>
public sealed record HelpPayload(
	string Name,
	string Summary,
	IReadOnlyList<OptionSpec> GlobalOptions,
	IReadOnlyList<CommandSummary> Commands,
	IReadOnlyList<string> Discovery,
	CommandSpec? Command);

/// <summary>The <c>capabilities</c> payload: help and schema in one call.</summary>
public sealed record CapabilitiesPayload(HelpPayload Help, WorkflowSchema Schema);

/// <summary>Builds the metadata payloads from the registered commands.</summary>
public static class MetadataPayloads
{
	private static readonly string[] Discovery =
	[
		"Use `agent-logbook help <command> --json` for command-specific guidance.",
		"Use `agent-logbook schema --json` for entity kinds, statuses, and relation rules.",
		"Use `agent-logbook capabilities --json` to fetch help and schema data in one call.",
	];

	public static HelpPayload Help(CommandCatalog catalog, CommandSpec? command = null) => new(
		CliApp.CommandName,
		CommandCatalog.Summary,
		CommandCatalog.GlobalOptions,
		[.. catalog.Specs.Select(spec => new CommandSummary(spec.Name, spec.Summary, spec.Usage))],
		Discovery,
		command);

	public static CapabilitiesPayload Capabilities(CommandCatalog catalog) => new(Help(catalog), WorkflowSchema.Current);
}
