using System.Reflection;
using AgentLogbook.Cli.ProjectIdentity;
using AgentLogbook.Cli.Serve;

namespace AgentLogbook.Cli;

/// <summary>Runs the agent-logbook command line against explicit output streams.</summary>
public static class CliApp
{
	public const string CommandName = "agent-logbook";

	public static string Version { get; } =
		typeof(CliApp).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
		?? "0.0.0";

	/// <summary>Runs the command line, including commands that run until <paramref name="shutdown"/> is cancelled.</summary>
	public static Task<int> RunAsync(
		string[] args,
		TextWriter stdout,
		TextWriter stderr,
		CancellationToken shutdown,
		string? workingDirectory = null,
		Func<string, string?>? getEnvironmentVariable = null) =>
		args is [ServeCommand.Name, ..]
			? ServeCommand.RunAsync(args[1..], stdout, stderr, getEnvironmentVariable ?? Environment.GetEnvironmentVariable, shutdown)
			: Task.FromResult(Run(args, stdout, stderr, workingDirectory, getEnvironmentVariable));

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
			? $"{CommandName}: no command given. Use --version, {ProjectIdentityCommand.Name}, or {ServeCommand.Name}."
			: $"{CommandName}: unknown argument '{args[0]}'.");
		return 1;
	}
}
