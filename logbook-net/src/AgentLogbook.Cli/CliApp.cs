using System.Reflection;
using AgentLogbook.Cli.ProjectIdentity;

namespace AgentLogbook.Cli;

/// <summary>Runs the agent-logbook command line against explicit output streams.</summary>
public static class CliApp
{
	public const string CommandName = "agent-logbook";

	public static string Version { get; } =
		typeof(CliApp).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
		?? "0.0.0";

	public static int Run(
		string[] args,
		TextWriter stdout,
		TextWriter stderr,
		string? workingDirectory = null,
		Func<string, string?>? getEnvironmentVariable = null)
	{
		if (args is ["--version"])
		{
			stdout.WriteLine(Version);
			return 0;
		}

		if (args is [ProjectIdentityCommand.Name, ..])
		{
			return ProjectIdentityCommand.Run(
				args[1..],
				stdout,
				stderr,
				workingDirectory ?? Directory.GetCurrentDirectory(),
				getEnvironmentVariable ?? Environment.GetEnvironmentVariable);
		}

		stderr.WriteLine(args.Length == 0
			? $"{CommandName}: no command given. Use --version or {ProjectIdentityCommand.Name}."
			: $"{CommandName}: unknown argument '{args[0]}'.");
		return 1;
	}
}
