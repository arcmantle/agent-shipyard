using System.Text.Json;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Client;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Cli.Storage;

/// <summary>
/// What every command that reads or writes records shares: it routes to the API host, opens an <see cref="HttpStore"/> for the workspace
/// of the current folder, and reports the failures that a user can fix as one line on stderr with exit code 1.
/// </summary>
internal static class CliStore
{
	/// <summary>Opens the store of the current workspace. The caller disposes it.</summary>
	public static async Task<HttpStore> OpenAsync(CliRuntime runtime, CancellationToken cancellationToken)
	{
		return await WorkspaceStore.OpenAsync(runtime.WorkingDirectory, runtime.GetEnvironmentVariable, cancellationToken: cancellationToken);
	}

	/// <summary>The failures of routing, transport and the API host. Anything else is a defect and is not hidden.</summary>
	public static bool IsReportable(Exception exception) => exception is ShipyardDataFolderException or InvalidBackendRouteException
		or LocalApiUnavailableException or HttpStoreTransportException or HttpStoreStatusException or HttpStoreProtocolException
		or RpcException or JsonException or UriFormatException;

	/// <summary>Prints a failure and returns the exit code: <c>{"error":"..."}</c> with <c>--json</c>, else <c>agent-logbook &lt;command&gt;: ...</c>.</summary>
	public static int Fail(CliInvocation invocation, string command, string message)
	{
		invocation.Runtime.Stderr.Write((invocation.Json
			? CliJson.Serialize(new ErrorOutput(message), pretty: false)
			: $"{CliApp.CommandName} {command}: {message}") + "\n");
		return 1;
	}

	private sealed record ErrorOutput(string Error);
}
