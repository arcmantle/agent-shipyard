using System.Text;
using System.Text.Json;
using AgentLogbook.Core.ProjectIdentity;

namespace AgentLogbook.Cli.ProjectIdentity;

/// <summary>The <c>project-identity</c> command. It reads the workspace only and starts no API host.</summary>
internal static class ProjectIdentityCommand
{
	public const string Name = "project-identity";

	public static int Run(
		IReadOnlyList<string> options,
		TextWriter stdout,
		TextWriter stderr,
		string workingDirectory,
		Func<string, string?> getEnvironmentVariable)
	{
		var json = false;
		var pretty = false;
		var help = false;

		foreach (var option in options)
		{
			switch (option)
			{
				case "--json":
					json = true;
					break;
				case "--pretty":
					pretty = true;
					break;
				case "--help" or "-h":
					help = true;
					break;
				default:
					stderr.WriteLine(option.StartsWith('-')
						? $"{CliApp.CommandName}: unknown option '{option}' for {Name}. Use {Name} --help."
						: $"{CliApp.CommandName}: unexpected argument '{option}' for {Name}. Use {Name} --help.");
					return 1;
			}
		}

		if (help)
		{
			stdout.Write(HelpText.ReplaceLineEndings("\n"));
			return 0;
		}

		var resolution = ProjectIdentityResolver.Resolve(workingDirectory, getEnvironmentVariable);
		stdout.Write((json
			? RenderJson(resolution, pretty)
			: $"Project identity: {resolution.Identity}\nSource: {resolution.SourceName}") + "\n");
		return 0;
	}

	private static string RenderJson(ProjectIdentityResolution resolution, bool pretty)
	{
		using var buffer = new MemoryStream();
		using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = pretty }))
		{
			writer.WriteStartObject();
			writer.WriteString("command", Name);
			writer.WriteString("identity", resolution.Identity);
			writer.WriteString("source", resolution.SourceName);
			writer.WriteEndObject();
		}

		// The writer indents with the platform newline; output uses LF on every platform.
		return Encoding.UTF8.GetString(buffer.ToArray()).ReplaceLineEndings("\n");
	}

	private const string HelpText = """
		project-identity

		Show the project identity resolved from the current workspace.

		Usage:
		  agent-logbook project-identity

		Options:
		  --json | Print machine-readable JSON. Entity mutations return acknowledgements; list and relation reads return summaries.
		  --pretty | Pretty-print JSON when used with --json.
		  --help, -h | Show help for the whole CLI or the selected command.

		Examples:
		  agent-logbook project-identity
		  agent-logbook project-identity --json

		Notes:
		  Resolution precedence is environment override, .agent-shipyard.json file, .agent-shipyard file, .agent-issues.json file, old extensionless project file, Git remote name, package.json name, then folder name.

		Output:
		  Human-readable:
		    Resolved project identity and its source
		  JSON fields:
		    command
		    identity
		    source

		""";
}
