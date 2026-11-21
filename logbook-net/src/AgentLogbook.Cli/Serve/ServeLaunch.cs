using AgentLogbook.Client;

namespace AgentLogbook.Cli.Serve;

/// <summary>How this process starts <c>agent-logbook serve</c> in the background: the same tool, started the same way.</summary>
internal static class ServeLaunch
{
	public static LocalApiLaunch Current()
	{
		var processPath = Environment.ProcessPath;
		if (processPath is not null && Path.GetFileNameWithoutExtension(processPath).Equals(CliApp.CommandName, StringComparison.OrdinalIgnoreCase))
		{
			// The installed tool command.
			return new LocalApiLaunch(processPath, [ServeCommand.Name], CliApp.Version);
		}

		// Started through the .NET host (dotnet AgentLogbook.Cli.dll, or a test process that hosts the CLI): start the CLI assembly the same way.
		var dotnet = processPath is not null && Path.GetFileNameWithoutExtension(processPath).Equals("dotnet", StringComparison.OrdinalIgnoreCase)
			? processPath
			: Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";
		return new LocalApiLaunch(dotnet, [typeof(CliApp).Assembly.Location, ServeCommand.Name], CliApp.Version);
	}
}
