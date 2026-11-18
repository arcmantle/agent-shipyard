using AgentLogbook.Core.ProjectIdentity;

namespace AgentLogbook.Core.Tests.ProjectIdentity;

public class ProjectIdentityResolverTests
{
	private static Func<string, string?> Env(params (string Name, string Value)[] variables) =>
		name => variables.Where(variable => variable.Name == name).Select(variable => variable.Value).FirstOrDefault();

	private static ProjectIdentityResolution Resolve(TempWorkspace workspace, params (string Name, string Value)[] variables) =>
		ProjectIdentityResolver.Resolve(workspace.Root, Env(variables));

	private static string Project(string identity) => $$"""{"projectIdentity":"{{identity}}"}""";

	private static string GitConfig(string url) => $"[remote \"origin\"]\n\turl = {url}\n";

	[Test]
	public async Task Precedence_runs_from_the_new_environment_variable_down_to_the_folder_name()
	{
		using var workspace = new TempWorkspace("Folder Name")
			.WithFile(".agent-shipyard.json", Project("shipyard-json"))
			.WithFile(".agent-shipyard", Project("shipyard-plain"))
			.WithFile(".agent-issues.json", Project("issues-json"))
			.WithFile(".agent-issues", Project("issues-plain"))
			.WithFile(".git/config", GitConfig("https://example.com/org/git-name.git"))
			.WithFile("package.json", """{"name":"package-name"}""");

		var steps = new (string Expected, ProjectIdentitySource Source)[]
		{
			("env-shipyard", ProjectIdentitySource.Environment),
			("env-issues", ProjectIdentitySource.Environment),
			("shipyard-json", ProjectIdentitySource.ProjectFile),
			("shipyard-plain", ProjectIdentitySource.ProjectFile),
			("issues-json", ProjectIdentitySource.ProjectFile),
			("issues-plain", ProjectIdentitySource.ProjectFile),
			("git-name", ProjectIdentitySource.GitRepository),
			("package-name", ProjectIdentitySource.PackageJson),
			("folder-name", ProjectIdentitySource.FolderName),
		};

		var variables = new List<(string, string)>
		{
			("AGENT_SHIPYARD_PROJECT_IDENTITY", "env-shipyard"),
			("AGENT_ISSUES_PROJECT_IDENTITY", "env-issues"),
		};
		var files = new[] { ".agent-shipyard.json", ".agent-shipyard", ".agent-issues.json", ".agent-issues" };

		foreach (var (expected, source) in steps)
		{
			var resolution = Resolve(workspace, [.. variables]);
			await Assert.That(resolution.Identity).IsEqualTo(expected);
			await Assert.That(resolution.Source).IsEqualTo(source);

			// Remove the input that just won, so the next input in the order decides.
			if (variables.Count > 0)
			{
				variables.RemoveAt(0);
			}
			else if (files.FirstOrDefault(file => File.Exists(workspace.PathOf(file))) is { } file)
			{
				File.Delete(workspace.PathOf(file));
			}
			else if (File.Exists(workspace.PathOf(".git/config")))
			{
				File.Delete(workspace.PathOf(".git/config"));
			}
			else
			{
				File.Delete(workspace.PathOf("package.json"));
			}
		}
	}

	[Test]
	public async Task The_new_project_file_wins_over_the_old_file_without_a_warning()
	{
		using var workspace = new TempWorkspace()
			.WithFile(".agent-shipyard.json", Project("new"))
			.WithFile(".agent-issues.json", Project("old"));

		await Assert.That(Resolve(workspace).Identity).IsEqualTo("new");
	}

	[Test]
	public async Task The_old_environment_variable_still_applies_when_the_new_one_is_missing_or_empty()
	{
		using var workspace = new TempWorkspace().WithFile(".agent-shipyard.json", Project("file"));

		await Assert.That(Resolve(workspace, ("AGENT_ISSUES_PROJECT_IDENTITY", "Old Env")).Identity).IsEqualTo("old-env");
		await Assert.That(Resolve(workspace, ("AGENT_SHIPYARD_PROJECT_IDENTITY", ""), ("AGENT_ISSUES_PROJECT_IDENTITY", "Old Env")).Identity).IsEqualTo("old-env");
		await Assert.That(Resolve(workspace, ("AGENT_SHIPYARD_PROJECT_IDENTITY", "***"), ("AGENT_ISSUES_PROJECT_IDENTITY", "Old Env")).Identity).IsEqualTo("old-env");
	}

	[Test]
	public async Task A_new_project_file_without_a_usable_identity_falls_to_the_next_file()
	{
		using var workspace = new TempWorkspace()
			.WithFile(".agent-shipyard.json", "{}")
			.WithFile(".agent-shipyard", "{not json")
			.WithFile(".agent-issues.json", Project("---"))
			.WithFile(".agent-issues", Project("old-plain"));

		await Assert.That(Resolve(workspace).Identity).IsEqualTo("old-plain");
	}

	[Test]
	public async Task An_extensionless_shipyard_folder_is_ignored()
	{
		using var workspace = new TempWorkspace()
			.WithDirectory(".agent-shipyard")
			.WithFile(".agent-shipyard/logbook/local-api.settings.json", Project("inside-folder"))
			.WithFile(".agent-issues.json", Project("old-file"));

		var resolution = Resolve(workspace);

		await Assert.That(resolution.Identity).IsEqualTo("old-file");
		await Assert.That(resolution.Source).IsEqualTo(ProjectIdentitySource.ProjectFile);
	}

	[Test]
	public async Task An_extensionless_old_folder_is_ignored()
	{
		using var workspace = new TempWorkspace().WithDirectory(".agent-issues").WithFile("package.json", """{"name":"pkg"}""");

		await Assert.That(Resolve(workspace).Source).IsEqualTo(ProjectIdentitySource.PackageJson);
	}

	[Test]
	public async Task The_folder_name_is_workspace_when_it_has_no_letter_or_digit()
	{
		using var workspace = new TempWorkspace("日本語");

		var resolution = Resolve(workspace);

		await Assert.That(resolution.Identity).IsEqualTo("workspace");
		await Assert.That(resolution.Source).IsEqualTo(ProjectIdentitySource.FolderName);
	}

	[Test]
	public async Task A_working_directory_with_a_trailing_separator_resolves_like_one_without()
	{
		using var workspace = new TempWorkspace("Trailing Slash");

		var resolution = ProjectIdentityResolver.Resolve(workspace.Root + Path.DirectorySeparatorChar, Env());

		await Assert.That(resolution.Identity).IsEqualTo("trailing-slash");
	}

	[Test]
	public async Task A_nested_working_directory_resolves_the_workspace_root()
	{
		using var workspace = new TempWorkspace()
			.WithFile(".agent-shipyard.json", Project("root-identity"))
			.WithFile("sub/deep/file.txt", "");

		var resolution = ProjectIdentityResolver.Resolve(workspace.PathOf("sub/deep"), Env());

		await Assert.That(resolution.Identity).IsEqualTo("root-identity");
	}
}
