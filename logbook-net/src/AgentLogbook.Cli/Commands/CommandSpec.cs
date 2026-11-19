namespace AgentLogbook.Cli.Commands;

/// <summary>An option of a command, as help and capabilities describe it.</summary>
public sealed record OptionSpec(
	string Name,
	string Description,
	bool? Required = null,
	IReadOnlyList<string>? AllowedValues = null);

/// <summary>A positional argument of a command, as help and capabilities describe it.</summary>
public sealed record PositionalSpec(
	string Name,
	string Description,
	bool? Required = null,
	IReadOnlyList<string>? AllowedValues = null);

/// <summary>What a command prints. The lists are the lines that help shows.</summary>
public sealed record OutputSpec(IReadOnlyList<string>? Human = null, IReadOnlyList<string>? Json = null);

/// <summary>
/// One command path of the command model. Help, the command tree, and capabilities all derive from it.
/// The member order is the JSON key order.
/// </summary>
public sealed record CommandSpec(
	string Name,
	string Summary,
	IReadOnlyList<string> Usage,
	IReadOnlyList<PositionalSpec>? Positionals = null,
	IReadOnlyList<OptionSpec>? Options = null,
	IReadOnlyList<string>? Examples = null,
	IReadOnlyList<string>? Notes = null,
	OutputSpec? Output = null);
