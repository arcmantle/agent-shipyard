using System.CommandLine;

namespace AgentLogbook.Cli.Commands;

/// <summary>
/// The implemented commands of the tool. It owns the System.CommandLine tree that parsing and the contract extractor walk.
/// A command that is not registered here does not exist: there are no placeholder commands.
/// </summary>
public sealed class CommandCatalog
{
	public const string Summary = "Structured workflow CLI for shared context, initiatives, PRDs, user stories, ADRs, and issues.";

	public const string JsonOption = "--json";
	public const string PrettyOption = "--pretty";
	public const string HelpOption = "--help";
	public const string VersionOption = "--version";

	public static IReadOnlyList<OptionSpec> GlobalOptions { get; } =
	[
		new(JsonOption, "Print machine-readable JSON. Entity mutations return acknowledgements; list and relation reads return summaries."),
		new(PrettyOption, "Pretty-print JSON when used with --json."),
		new("--help, -h", "Show help for the whole CLI or the selected command."),
	];

	private readonly Dictionary<string, ICliCommand> _byName;

	public CommandCatalog(IEnumerable<ICliCommand> commands)
	{
		var list = commands.ToList();
		_byName = [];
		foreach (var command in list)
		{
			if (!_byName.TryAdd(command.Spec.Name, command))
			{
				throw new ArgumentException($"The command '{command.Spec.Name}' is registered twice.", nameof(commands));
			}
		}

		Commands = list;
		Root = BuildRoot(list);
	}

	/// <summary>The implemented commands in registration order.</summary>
	public IReadOnlyList<ICliCommand> Commands { get; }

	public IEnumerable<CommandSpec> Specs => Commands.Select(command => command.Spec);

	/// <summary>The root of the command tree.</summary>
	public Command Root { get; }

	public bool TryGetCommand(string name, out ICliCommand command) => _byName.TryGetValue(name, out command!);

	/// <summary>Finds the longest registered command name that the words start with. Else it returns the first word.</summary>
	public string? ResolveName(IReadOnlyList<string> words)
	{
		for (var length = words.Count; length > 0; length--)
		{
			var candidate = string.Join(' ', words.Take(length));
			if (_byName.ContainsKey(candidate))
			{
				return candidate;
			}
		}

		return words.Count > 0 ? words[0] : null;
	}

	private static Command BuildRoot(IReadOnlyList<ICliCommand> commands)
	{
		var root = new Command(CliApp.CommandName, Summary);
		root.Options.Add(new Option<bool>(VersionOption) { Description = "Print the tool version.", Arity = ArgumentArity.Zero });
		AddGlobalOptions(root);

		// Without an action, parsing demands a subcommand. The root itself prints the general help; CliApp runs it, not the tree.
		root.SetAction(_ => 0);

		foreach (var command in commands)
		{
			var spec = command.Spec;
			var node = new Command(spec.Name, spec.Summary);
			AddGlobalOptions(node);
			foreach (var option in spec.Options ?? [])
			{
				node.Options.Add(BuildOption(option));
			}

			foreach (var positional in spec.Positionals ?? [])
			{
				node.Arguments.Add(new Argument<string[]>(positional.Name)
				{
					Description = positional.Description,
					Arity = positional.Required == true ? ArgumentArity.OneOrMore : ArgumentArity.ZeroOrMore,
				});
			}

			root.Subcommands.Add(node);
		}

		return root;
	}

	private static void AddGlobalOptions(Command command)
	{
		command.Options.Add(new Option<bool>(JsonOption) { Description = GlobalOptions[0].Description, Arity = ArgumentArity.Zero });
		command.Options.Add(new Option<bool>(PrettyOption) { Description = GlobalOptions[1].Description, Arity = ArgumentArity.Zero });
		command.Options.Add(new Option<bool>(HelpOption, "-h") { Description = GlobalOptions[2].Description, Arity = ArgumentArity.Zero });
	}

	/// <summary>An option spec name is its long name and aliases, then an optional value in angle brackets: <c>--limit &lt;count&gt;</c>.</summary>
	private static Option BuildOption(OptionSpec spec)
	{
		var valueStart = spec.Name.IndexOf(" <", StringComparison.Ordinal);
		var names = (valueStart < 0 ? spec.Name : spec.Name[..valueStart]).Split(", ");
		return valueStart < 0
			? new Option<bool>(names[0], names[1..]) { Description = spec.Description, Arity = ArgumentArity.Zero }
			: new Option<string>(names[0], names[1..])
			{
				Description = spec.Description,
				Required = spec.Required == true,
				Arity = ArgumentArity.ExactlyOne,
			};
	}
}
