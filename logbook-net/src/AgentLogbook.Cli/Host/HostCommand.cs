using System.Globalization;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Cli.Serve;
using AgentLogbook.Cli.Storage;
using AgentLogbook.Client;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Host;

/// <summary>
/// <c>agent-logbook host status|stop|restart</c> controls the background Local API host that the CLI and the MCP server start.
/// Status never starts a host. Stop and restart act only on the host that the discovery file names and that answers as that process.
/// </summary>
public sealed class HostCommand : ICliCommand
{
	public const string Name = "host";

	private const string Status = "status";
	private const string Stop = "stop";
	private const string Restart = "restart";

	public CommandSpec Spec { get; } = new(
		Name,
		"Show, stop, or restart the background Local API host.",
		["agent-logbook host <status|stop|restart>"],
		Positionals: [new PositionalSpec("action", "What to do with the background host.", Required: true, AllowedValues: [Status, Stop, Restart])],
		Examples: ["agent-logbook host status", "agent-logbook host stop", "agent-logbook host restart --json"],
		Notes:
		[
			"status reads the discovery file and asks the host who it is. It never starts a host. It exits with 0 for a running or a stopped host and with 1 for a stale state.",
			"stop lets active requests finish, then ends the host. It succeeds when no host runs. It refuses, and touches nothing, when a live process that is not the host holds the discovery file.",
			"restart stops the running host as stop does, then starts one replacement with the current Local API settings. With no host running it starts one.",
		],
		Output: new OutputSpec(
			Human:
			[
				"Local API host running at <url> (process <processId>, version <toolVersion>, started <startedAt>).",
				"No Local API host is running.",
			],
			Json: ["command", "action", "state", "url", "port", "processId", "toolVersion", "startedAt", "reason", "stoppedProcessId"]));

	public int Run(CliInvocation invocation) => RunAsync(invocation, CancellationToken.None).GetAwaiter().GetResult();

	internal static async Task<int> RunAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		var runtime = invocation.Runtime;
		if (invocation.Positionals.Count != 1 || invocation.Positionals[0] is not (Status or Stop or Restart))
		{
			return CliStore.Fail(invocation, Name, $"Missing or unknown action. Usage: {Name} <{Status}|{Stop}|{Restart}>");
		}

		var action = invocation.Positionals[0];
		try
		{
			var folder = ShipyardLogbookFolder.Resolve(runtime.GetEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
			switch (action)
			{
				case Status:
					var status = await LocalApiHostControl.InspectAsync(folder, cancellationToken: cancellationToken);
					Print(invocation, action, status.State, status.Discovery, status.Reason, null, StatusHuman(status));
					return status.State == LocalApiHostState.Stale ? 1 : 0;

				case Stop:
					var stopped = await LocalApiHostControl.StopAsync(folder, cancellationToken: cancellationToken);
					Print(invocation, action, LocalApiHostState.Stopped, null, stopped.Note, stopped.Stopped?.ProcessId, StopHuman(stopped));
					return 0;

				default:
					var restarted = await LocalApiHostControl.RestartAsync(
						folder, ServeLaunch.Current(), runtime.GetEnvironmentVariable, cancellationToken: cancellationToken);
					Print(invocation, action, LocalApiHostState.Running, restarted.Started, null, restarted.Replaced?.ProcessId, RestartHuman(restarted));
					return 0;
			}
		}
		catch (Exception exception) when (exception is LocalApiHostControlException or LocalApiUnavailableException or ShipyardDataFolderException)
		{
			return CliStore.Fail(invocation, Name, exception.Message);
		}
	}

	private static void Print(
		CliInvocation invocation,
		string action,
		LocalApiHostState state,
		LocalApiDiscovery? discovery,
		string? reason,
		int? stoppedProcessId,
		string human)
	{
		// A stale status keeps the facts of the file, so a user sees which process the file names.
		invocation.Runtime.Stdout.Write((invocation.Json
			? CliJson.Serialize(
				new HostOutput(
					Name,
					action,
					state switch { LocalApiHostState.Running => "running", LocalApiHostState.Stale => "stale", _ => "stopped" },
					discovery?.Url,
					discovery?.Port,
					discovery?.ProcessId,
					discovery?.ToolVersion,
					discovery?.StartedAt.ToString("O", CultureInfo.InvariantCulture),
					reason,
					stoppedProcessId),
				invocation.Pretty)
			: human) + "\n");
	}

	private static string StatusHuman(LocalApiHostStatus status) => status.State switch
	{
		LocalApiHostState.Running => Running(status.Discovery!),
		LocalApiHostState.Stale => $"The Local API host state is stale. {status.Reason}",
		_ => "No Local API host is running.",
	};

	private static string StopHuman(LocalApiHostStopResult result) => result.Stopped is { } host
		? $"Stopped the Local API host (process {host.ProcessId})."
		: result.Note is null
			? "No Local API host is running."
			: $"No Local API host is running. {result.Note}";

	private static string RestartHuman(LocalApiHostRestartResult result) => result.Replaced is { } old
		? $"Stopped the Local API host (process {old.ProcessId}). {Running(result.Started)}"
		: $"No Local API host was running. {Running(result.Started)}";

	private static string Running(LocalApiDiscovery host) =>
		$"Local API host running at {host.Url} (process {host.ProcessId}, version {host.ToolVersion}, started {host.StartedAt.ToString("O", CultureInfo.InvariantCulture)}).";

	private sealed record HostOutput(
		string Command,
		string Action,
		string State,
		string? Url,
		int? Port,
		int? ProcessId,
		string? ToolVersion,
		string? StartedAt,
		string? Reason,
		int? StoppedProcessId);
}
