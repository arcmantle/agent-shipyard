using AgentLogbook.Api;

namespace AgentLogbook.Cli.Serve;

/// <summary>
/// <c>agent-logbook serve</c> runs the Local API host in the foreground until the process gets a termination signal or a stop request (<c>agent-logbook host stop</c>).
/// It listens on 127.0.0.1 in explicit no-auth mode and takes no options.
/// </summary>
internal static class ServeCommand
{
	public const string Name = "serve";

	public static async Task<int> RunAsync(
		string[] args,
		TextWriter stdout,
		TextWriter stderr,
		Func<string, string?> getEnvironmentVariable,
		CancellationToken shutdown)
	{
		if (args.Length > 0)
		{
			stderr.WriteLine($"{CliApp.CommandName} {Name}: unexpected argument '{args[0]}'. The command takes no arguments.");
			return 1;
		}

		LocalApiHost host;
		try
		{
			host = await LocalApiHost.StartAsync(CliApp.Version, getEnvironmentVariable, Environment.UserName, shutdown);
		}
		catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
		{
			return 0;
		}
		catch (LocalApiStartupException exception)
		{
			stderr.WriteLine($"{CliApp.CommandName} {Name}: the Local API host did not start. {exception.Message}");
			return 1;
		}

		await using (host)
		{
			stdout.WriteLine($"Local API host {host.Discovery.ToolVersion} listening on {host.Discovery.Url} (process {host.Discovery.ProcessId}).");
			stdout.Flush();

			// A termination signal or a stop request through the local control path ends the host the same way.
			using var stopping = CancellationTokenSource.CreateLinkedTokenSource(shutdown, host.StopRequested);
			try
			{
				await Task.Delay(Timeout.Infinite, stopping.Token);
			}
			catch (OperationCanceledException)
			{
				// A termination signal is the normal end of this command.
			}

			await host.StopAsync(CancellationToken.None);
		}

		return 0;
	}
}
