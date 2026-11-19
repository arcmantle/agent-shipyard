using System.CommandLine;
using System.Reflection;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Cli.ProjectIdentity;

namespace AgentLogbook.Cli;

/// <summary>Runs the agent-logbook command line against explicit output streams.</summary>
public static class CliApp
{
	public const string CommandName = "agent-logbook";

	public static string Version { get; } =
		typeof(CliApp).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
		?? "0.0.0";

	/// <summary>The commands that this release implements. Add a command here and it joins help, schema discovery, and the tree.</summary>
	public static CommandCatalog Catalog { get; } = new(
	[
		new ProjectIdentityCommand(),
		new HelpCommand(),
		new SchemaCommand(),
		new CapabilitiesCommand(),
	]);

	public static int Run(
		string[] args,
		TextWriter stdout,
		TextWriter stderr,
		string? workingDirectory = null,
		Func<string, string?>? getEnvironmentVariable = null) =>
		Run(Catalog, args, stdout, stderr, workingDirectory, getEnvironmentVariable);

	internal static int Run(
		CommandCatalog catalog,
		string[] args,
		TextWriter stdout,
		TextWriter stderr,
		string? workingDirectory = null,
		Func<string, string?>? getEnvironmentVariable = null)
	{
		var runtime = new CliRuntime(
			stdout,
			stderr,
			workingDirectory ?? Directory.GetCurrentDirectory(),
			getEnvironmentVariable ?? Environment.GetEnvironmentVariable);
		var parse = catalog.Root.Parse(args);
		var command = parse.CommandResult.Command;
		var path = command == catalog.Root ? CommandName : command.Name;

		if (parse.Errors.Count > 0)
		{
			stderr.WriteLine(DescribeError(parse, command == catalog.Root, path));
			return 1;
		}

		var invocation = new CliInvocation(
			parse,
			runtime,
			catalog,
			parse.GetValue<bool>(CommandCatalog.JsonOption),
			parse.GetValue<bool>(CommandCatalog.PrettyOption),
			PositionalsOf(parse, command));

		if (command == catalog.Root)
		{
			if (parse.GetValue<bool>(CommandCatalog.VersionOption))
			{
				stdout.WriteLine(Version);
				return 0;
			}

			CliOutput.Write(invocation, MetadataPayloads.Help(catalog), MetadataRenderer.RenderHelp);
			return 0;
		}

		var implemented = catalog.Commands.First(item => item.Spec.Name == command.Name);
		if (parse.GetValue<bool>(CommandCatalog.HelpOption))
		{
			CliOutput.Write(invocation, implemented.Spec, MetadataRenderer.RenderCommandHelp);
			return 0;
		}

		return implemented.Run(invocation);
	}

	private static List<string> PositionalsOf(ParseResult parse, Command command)
	{
		var words = new List<string>();
		foreach (var argument in command.Arguments)
		{
			words.AddRange(parse.GetValue((Argument<string[]>)argument) ?? []);
		}

		return words;
	}

	private static string DescribeError(ParseResult parse, bool atRoot, string path)
	{
		var usage = atRoot ? $"{CommandName} help" : $"{CommandName} {path} --help";
		if (parse.UnmatchedTokens.Count > 0)
		{
			var token = parse.UnmatchedTokens[0];
			var kind = token.StartsWith('-') ? "option" : atRoot ? "command" : "argument";
			var article = kind == "argument" ? "unexpected" : "unknown";
			var target = atRoot ? string.Empty : $" for {path}";
			return $"{CommandName}: {article} {kind} '{token}'{target}. Use {usage}.";
		}

		return $"{CommandName}: {parse.Errors[0].Message.TrimEnd('.')}. Use {usage}.";
	}
}
