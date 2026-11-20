using AgentLogbook.Client;
using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Cli.Storage;

namespace AgentLogbook.Cli.Init;

/// <summary>
/// The <c>init</c> command. It routes to the API host like every storage command, then opens the workspace of the current
/// folder through <see cref="HttpStore"/>: the tenant of the login, the default project and epic, and the project that the
/// resolved project identity names. The output is the output of the TypeScript command; the <c>dbPath</c> field is the API URL,
/// as it is in the TypeScript remote mode.
/// </summary>
public sealed class InitCommand : ICliCommand
{
	public const string Name = "init";

	public CommandSpec Spec { get; } = new(
		Name,
		"Initialize the local data store.",
		["agent-logbook init"],
		Examples: ["agent-logbook init"],
		Output: new OutputSpec(
			Human: ["Initialized data store at <dbPath>"],
			Json: ["command", "dbPath", "status"]));

	public int Run(CliInvocation invocation) => RunAsync(invocation, CancellationToken.None).GetAwaiter().GetResult();

	internal static async Task<int> RunAsync(CliInvocation invocation, CancellationToken cancellationToken)
	{
		var runtime = invocation.Runtime;
		try
		{
			using var store = await CliStore.OpenAsync(runtime, cancellationToken);
			await store.InitializeWorkspaceAsync(cancellationToken);

			var dbPath = store.BaseUrl.OriginalString;
			runtime.Stdout.Write((invocation.Json
				? CliJson.Serialize(new InitOutput(Name, dbPath, "ok"), invocation.Pretty)
				: $"Initialized data store at {dbPath}") + "\n");
			return 0;
		}
		catch (Exception exception) when (CliStore.IsReportable(exception))
		{
			return CliStore.Fail(invocation, Name, exception.Message);
		}
	}

	private sealed record InitOutput(string Command, string DbPath, string Status);
}
