namespace AgentLogbook.Core.ProjectIdentity;

/// <summary>The input that decided a project identity.</summary>
public enum ProjectIdentitySource
{
	Environment,
	ProjectFile,
	GitRepository,
	PackageJson,
	FolderName,
}

/// <summary>A resolved project identity and the input that supplied it.</summary>
public readonly record struct ProjectIdentityResolution(string Identity, ProjectIdentitySource Source)
{
	/// <summary>The source name used in CLI output.</summary>
	public string SourceName => Source switch
	{
		ProjectIdentitySource.Environment => "environment",
		ProjectIdentitySource.ProjectFile => "project-file",
		ProjectIdentitySource.GitRepository => "git-repository",
		ProjectIdentitySource.PackageJson => "package-json",
		ProjectIdentitySource.FolderName => "folder-name",
		_ => throw new InvalidOperationException($"Unknown project identity source {Source}."),
	};
}
