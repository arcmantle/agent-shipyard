using System.Text.Json;
using AgentLogbook.Cli;

namespace AgentLogbook.Cli.Tests;

public class ProjectIdentityCommandTests
{
	private static readonly Func<string, string?> NoEnvironment = _ => null;

	private static (int Exit, string Out, string Err) Run(string workingDirectory, Func<string, string?>? environment, params string[] args)
	{
		var stdout = new StringWriter();
		var stderr = new StringWriter();
		var exit = CliApp.Run(args, stdout, stderr, workingDirectory, environment ?? NoEnvironment);
		return (exit, stdout.ToString(), stderr.ToString());
	}

	private static string NewWorkspace(string name, params (string Path, string Contents)[] files)
	{
		var root = Path.Combine(Directory.CreateTempSubdirectory("logbook-cli-identity-").FullName, name);
		Directory.CreateDirectory(root);
		File.WriteAllText(Path.Combine(root, "pnpm-workspace.yaml"), "");
		foreach (var (path, contents) in files)
		{
			File.WriteAllText(Path.Combine(root, path), contents);
		}

		return root;
	}

	private static void Delete(string workspace) => Directory.Delete(Path.GetDirectoryName(workspace)!, recursive: true);

	[Test]
	public async Task Human_output_names_the_identity_and_its_source()
	{
		var workspace = NewWorkspace("My Folder");
		try
		{
			var (exit, output, error) = Run(workspace, null, "project-identity");

			await Assert.That(exit).IsEqualTo(0);
			await Assert.That(output).IsEqualTo($"Project identity: my-folder\nSource: folder-name\n");
			await Assert.That(error).IsEmpty();
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	public async Task Json_output_has_command_identity_and_source()
	{
		var workspace = NewWorkspace("w", (".agent-shipyard.json", """{"projectIdentity":"New One"}"""));
		try
		{
			var (exit, output, error) = Run(workspace, null, "project-identity", "--json");

			await Assert.That(exit).IsEqualTo(0);
			await Assert.That(output).IsEqualTo("{\"command\":\"project-identity\",\"identity\":\"new-one\",\"source\":\"project-file\"}\n");
			await Assert.That(error).IsEmpty();
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	public async Task Pretty_json_is_indented_and_has_the_same_fields()
	{
		var workspace = NewWorkspace("w");
		try
		{
			var (exit, output, _) = Run(workspace, null, "project-identity", "--json", "--pretty");
			using var document = JsonDocument.Parse(output);

			await Assert.That(exit).IsEqualTo(0);
			await Assert.That(output).Contains("\n  \"identity\"");
			await Assert.That(document.RootElement.GetProperty("source").GetString()).IsEqualTo("folder-name");
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	public async Task The_environment_override_reaches_the_command()
	{
		var workspace = NewWorkspace("w", (".agent-issues.json", """{"projectIdentity":"file"}"""));
		try
		{
			var (_, output, _) = Run(workspace, name => name == "AGENT_ISSUES_PROJECT_IDENTITY" ? "Old Env" : null, "project-identity", "--json");

			await Assert.That(output).Contains("\"identity\":\"old-env\"").And.Contains("\"source\":\"environment\"");
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	public async Task The_new_environment_variable_wins_over_the_old_one()
	{
		var workspace = NewWorkspace("w");
		try
		{
			var (_, output, _) = Run(workspace, name => name switch
			{
				"AGENT_SHIPYARD_PROJECT_IDENTITY" => "New Env",
				"AGENT_ISSUES_PROJECT_IDENTITY" => "Old Env",
				_ => null,
			}, "project-identity", "--json");

			await Assert.That(output).Contains("\"identity\":\"new-env\"");
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	[Arguments("--help")]
	[Arguments("-h")]
	public async Task Help_documents_the_command_and_the_new_precedence(string flag)
	{
		var workspace = NewWorkspace("w");
		try
		{
			var (exit, output, error) = Run(workspace, null, "project-identity", flag);

			await Assert.That(exit).IsEqualTo(0);
			await Assert.That(error).IsEmpty();
			await Assert.That(output).StartsWith("project-identity\n\nShow the project identity resolved from the current workspace.");
			await Assert.That(output).Contains("agent-logbook project-identity --json");
			await Assert.That(output).Contains(".agent-shipyard.json file, .agent-shipyard file, .agent-issues.json file, old extensionless project file, Git remote name");
			await Assert.That(output).DoesNotContain("--db").And.DoesNotContain("SQLite");
		}
		finally
		{
			Delete(workspace);
		}
	}

	[Test]
	[Arguments("--bogus", "unknown option '--bogus'")]
	[Arguments("extra", "unexpected argument 'extra'")]
	public async Task An_unknown_option_or_argument_fails_on_stderr_without_output(string argument, string message)
	{
		var workspace = NewWorkspace("w");
		try
		{
			var (exit, output, error) = Run(workspace, null, "project-identity", "--json", argument);

			await Assert.That(exit).IsEqualTo(1);
			await Assert.That(output).IsEmpty();
			await Assert.That(error).Contains(message).And.Contains("project-identity --help");
		}
		finally
		{
			Delete(workspace);
		}
	}
}
