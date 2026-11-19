using System.CommandLine;

namespace AgentLogbook.Cli.Commands;

/// <summary>The streams, workspace, and environment that one command run uses.</summary>
public sealed record CliRuntime(
	TextWriter Stdout,
	TextWriter Stderr,
	string WorkingDirectory,
	Func<string, string?> GetEnvironmentVariable);

/// <summary>One parsed command run.</summary>
public sealed record CliInvocation(
	ParseResult Parse,
	CliRuntime Runtime,
	CommandCatalog Catalog,
	bool Json,
	bool Pretty,
	IReadOnlyList<string> Positionals);

/// <summary>An implemented command. Registering it in a <see cref="CommandCatalog"/> adds it to help, schema discovery, and the command tree.</summary>
public interface ICliCommand
{
	CommandSpec Spec { get; }

	int Run(CliInvocation invocation);
}
