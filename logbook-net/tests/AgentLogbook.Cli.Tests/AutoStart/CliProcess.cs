using System.Diagnostics;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Tests.AutoStart;

/// <summary>Runs one <c>agent-logbook</c> command as a real process, as a user's shell does, in a Shipyard data folder that the test owns.</summary>
internal static class CliProcess
{
	private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(90);

	internal static Process Start(string workspace, string shipyardHome, string? postgresUrl, params string[] args)
	{
		var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
			WorkingDirectory = workspace,
		};
		info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "AgentLogbook.Cli.dll"));
		foreach (var argument in args)
		{
			info.ArgumentList.Add(argument);
		}

		foreach (var name in new[] { "AGENT_LOGBOOK_API_URL", "AGENT_SHIPYARD_PROJECT_IDENTITY", "AGENT_ISSUES_PROJECT_IDENTITY", LocalPostgresSelection.UrlVariable })
		{
			info.Environment.Remove(name);
		}

		info.Environment[ShipyardLogbookFolder.HomeVariable] = shipyardHome;
		if (postgresUrl is not null)
		{
			info.Environment[LocalPostgresSelection.UrlVariable] = postgresUrl;
		}

		return Process.Start(info) ?? throw new InvalidOperationException("The CLI process did not start.");
	}

	internal static async Task<(int Exit, string Out, string Err)> RunAsync(string workspace, string shipyardHome, string? postgresUrl, params string[] args)
	{
		using var process = Start(workspace, shipyardHome, postgresUrl, args);
		return await WaitAsync(process);
	}

	internal static async Task<(int Exit, string Out, string Err)> WaitAsync(Process process)
	{
		var output = process.StandardOutput.ReadToEndAsync();
		var error = process.StandardError.ReadToEndAsync();
		using var timeout = new CancellationTokenSource(Timeout);
		await process.WaitForExitAsync(timeout.Token);
		return (process.ExitCode, await output, await error);
	}

	internal static ShipyardLogbookFolder Folder(string shipyardHome) =>
		ShipyardLogbookFolder.Resolve(name => name == ShipyardLogbookFolder.HomeVariable ? shipyardHome : null, shipyardHome);

	/// <summary>Stops the host that a command started in the data folder of the test, and removes the folder. Only that one process is touched.</summary>
	internal static async Task StopHostAndCleanAsync(string shipyardHome)
	{
		var discovery = LocalApiDiscovery.Read(Folder(shipyardHome));
		if (discovery is not null && discovery.IsProcessAlive())
		{
			using var host = Process.GetProcessById(discovery.ProcessId);
			host.Kill(entireProcessTree: true);
			await host.WaitForExitAsync();
		}

		try
		{
			Directory.Delete(shipyardHome, recursive: true);
		}
		catch (IOException)
		{
			// A temporary folder that stays is not a test failure.
		}
	}
}
