using System.CommandLine;

namespace AgentLogbook.Cli.Commands;

/// <summary>An option or argument of a command, as the tree declares it.</summary>
public sealed record ModelSymbol(IReadOnlyList<string> Names, int MinimumValues, int MaximumValues, bool Required);

/// <summary>One command path of the tree.</summary>
public sealed record ModelCommand(
	IReadOnlyList<string> Path,
	IReadOnlyList<ModelSymbol> Options,
	IReadOnlyList<ModelSymbol> Arguments)
{
	/// <summary>The id that the contract inventory uses for this path.</summary>
	public string Id => $"cli:{(Path.Count == 0 ? "(default)" : string.Join(' ', Path))}";
}

/// <summary>Walks the command tree and lists every command with its options and arguments.</summary>
public static class CommandModel
{
	public static IReadOnlyList<ModelCommand> Walk(Command root)
	{
		var commands = new List<ModelCommand>();
		Visit(root, [], commands);
		return commands;
	}

	private static void Visit(Command command, string[] path, List<ModelCommand> commands)
	{
		commands.Add(new ModelCommand(
			path,
			[.. command.Options.Select(option => new ModelSymbol(
				[option.Name, .. option.Aliases],
				option.Arity.MinimumNumberOfValues,
				option.Arity.MaximumNumberOfValues,
				option.Required))],
			[.. command.Arguments.Select(argument => new ModelSymbol(
				[argument.Name],
				argument.Arity.MinimumNumberOfValues,
				argument.Arity.MaximumNumberOfValues,
				argument.Arity.MinimumNumberOfValues > 0))]));

		foreach (var subcommand in command.Subcommands)
		{
			Visit(subcommand, [.. path, subcommand.Name], commands);
		}
	}
}
