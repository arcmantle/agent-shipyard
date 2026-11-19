using AgentLogbook.Cli.Commands;
using AgentLogbook.Cli.Metadata;
using AgentLogbook.Core.ProjectIdentity;

namespace AgentLogbook.Cli.ProjectIdentity;

/// <summary>The <c>project-identity</c> command. It reads the workspace only and starts no API host.</summary>
public sealed class ProjectIdentityCommand : ICliCommand
{
	public const string Name = "project-identity";

	public CommandSpec Spec { get; } = new(
		Name,
		"Show the project identity resolved from the current workspace.",
		["agent-logbook project-identity"],
		Examples: ["agent-logbook project-identity", "agent-logbook project-identity --json"],
		Notes:
		[
			"Resolution precedence is environment override, .agent-shipyard.json file, .agent-shipyard file, .agent-issues.json file, old extensionless project file, Git remote name, package.json name, then folder name.",
		],
		Output: new OutputSpec(
			Human: ["Resolved project identity and its source"],
			Json: ["command", "identity", "source"]));

	public int Run(CliInvocation invocation)
	{
		var runtime = invocation.Runtime;
		var resolution = ProjectIdentityResolver.Resolve(runtime.WorkingDirectory, runtime.GetEnvironmentVariable);
		runtime.Stdout.Write((invocation.Json
			? CliJson.Serialize(new ProjectIdentityOutput(Name, resolution.Identity, resolution.SourceName), invocation.Pretty)
			: $"Project identity: {resolution.Identity}\nSource: {resolution.SourceName}") + "\n");
		return 0;
	}

	private sealed record ProjectIdentityOutput(string Command, string Identity, string Source);
}
