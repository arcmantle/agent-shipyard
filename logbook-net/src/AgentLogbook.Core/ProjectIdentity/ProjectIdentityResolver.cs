using System.Text.Json;
using System.Text.RegularExpressions;

namespace AgentLogbook.Core.ProjectIdentity;

/// <summary>
/// Resolves the project identity of a workspace. Precedence: <c>AGENT_SHIPYARD_PROJECT_IDENTITY</c>,
/// <c>AGENT_ISSUES_PROJECT_IDENTITY</c>, <c>.agent-shipyard.json</c>, <c>.agent-shipyard</c>,
/// <c>.agent-issues.json</c>, <c>.agent-issues</c>, the Git origin name, the package name, the folder name.
/// An input that is missing or gives no usable name is skipped, so the next input decides.
/// </summary>
public static partial class ProjectIdentityResolver
{
	public const string ProjectIdentityField = "projectIdentity";

	public static readonly IReadOnlyList<string> EnvironmentVariables =
		["AGENT_SHIPYARD_PROJECT_IDENTITY", "AGENT_ISSUES_PROJECT_IDENTITY"];

	public static readonly IReadOnlyList<string> ProjectFileNames =
		[".agent-shipyard.json", ".agent-shipyard", ".agent-issues.json", ".agent-issues"];

	private const string FallbackIdentity = "workspace";

	public static ProjectIdentityResolution Resolve(string workingDirectory, Func<string, string?> getEnvironmentVariable)
	{
		var root = FindWorkspaceRoot(workingDirectory);

		return FromEnvironment(getEnvironmentVariable)
			?? FromProjectFile(root)
			?? FromGitRepository(root)
			?? FromPackageJson(root)
			?? FromFolderName(root);
	}

	/// <summary>The first folder from the working directory upward with a workspace or Git marker, else the first with a package file, else the working directory.</summary>
	public static string FindWorkspaceRoot(string workingDirectory)
	{
		var start = Path.TrimEndingDirectorySeparator(Path.GetFullPath(workingDirectory));

		return FindUpward(start, "pnpm-workspace.yaml", ".git")
			?? FindUpward(start, "package.json")
			?? start;
	}

	private static string? FindUpward(string start, params string[] markers)
	{
		for (var folder = start; folder is not null; folder = Path.GetDirectoryName(folder))
		{
			if (markers.Any(marker => Exists(Path.Combine(folder, marker))))
			{
				return folder;
			}
		}

		return null;
	}

	private static ProjectIdentityResolution? FromEnvironment(Func<string, string?> getEnvironmentVariable)
	{
		foreach (var name in EnvironmentVariables)
		{
			var identity = Named(getEnvironmentVariable(name));
			if (identity is not null)
			{
				return new(identity, ProjectIdentitySource.Environment);
			}
		}

		return null;
	}

	private static ProjectIdentityResolution? FromProjectFile(string root)
	{
		foreach (var fileName in ProjectFileNames)
		{
			var identity = Named(ReadStringField(Path.Combine(root, fileName), ProjectIdentityField));
			if (identity is not null)
			{
				return new(identity, ProjectIdentitySource.ProjectFile);
			}
		}

		return null;
	}

	private static ProjectIdentityResolution? FromPackageJson(string root)
	{
		var identity = Named(ReadStringField(Path.Combine(root, "package.json"), "name"));
		return identity is null ? null : new(identity, ProjectIdentitySource.PackageJson);
	}

	private static ProjectIdentityResolution? FromGitRepository(string root)
	{
		var configPath = ResolveGitConfigPath(root);
		var contents = File.Exists(configPath) ? TryReadText(configPath) : null;
		var identity = Named(contents is null ? null : ExtractOriginRepositoryName(contents));
		return identity is null ? null : new(identity, ProjectIdentitySource.GitRepository);
	}

	private static ProjectIdentityResolution FromFolderName(string root)
	{
		var identity = PathSegment.Sanitize(Path.GetFileName(root));
		return new(identity.Length == 0 ? FallbackIdentity : identity, ProjectIdentitySource.FolderName);
	}

	private static string? Named(string? value)
	{
		if (string.IsNullOrEmpty(value))
		{
			return null;
		}

		var identity = PathSegment.Sanitize(value);
		return identity.Length == 0 ? null : identity;
	}

	/// <summary>Reads a string field of a JSON object file. A file that is missing, not an object, not JSON, or has no such string gives null.</summary>
	private static string? ReadStringField(string path, string field)
	{
		if (!File.Exists(path) || TryReadText(path) is not { } text)
		{
			return null;
		}

		try
		{
			using var document = JsonDocument.Parse(text);
			return document.RootElement.ValueKind == JsonValueKind.Object
				&& document.RootElement.TryGetProperty(field, out var value)
				&& value.ValueKind == JsonValueKind.String
					? value.GetString()
					: null;
		}
		catch (JsonException)
		{
			return null;
		}
	}

	private static string ResolveGitConfigPath(string root)
	{
		var gitPath = Path.Combine(root, ".git");
		if (!Exists(gitPath) || Directory.Exists(gitPath))
		{
			return Path.Combine(gitPath, "config");
		}

		// A linked worktree or submodule: ".git" is a file that names the real Git folder.
		var gitDirectory = TryReadText(gitPath) is { } pointer ? ReadGitDirectory(pointer) : null;
		var resolvedGitDirectory = gitDirectory is null ? gitPath : Path.GetFullPath(Path.Combine(root, gitDirectory));
		var worktreeConfigPath = Path.Combine(resolvedGitDirectory, "config");
		if (Exists(worktreeConfigPath))
		{
			return worktreeConfigPath;
		}

		var commonDirectoryPath = Path.Combine(resolvedGitDirectory, "commondir");
		if (!File.Exists(commonDirectoryPath) || TryReadText(commonDirectoryPath) is not { } commonDirectory)
		{
			return worktreeConfigPath;
		}

		return Path.Combine(Path.GetFullPath(Path.Combine(resolvedGitDirectory, commonDirectory.Trim())), "config");
	}

	private static string? ReadGitDirectory(string pointer)
	{
		foreach (var line in pointer.Split('\n'))
		{
			const string prefix = "gitdir:";
			if (!line.StartsWith(prefix, StringComparison.Ordinal))
			{
				continue;
			}

			var value = line[prefix.Length..].TrimStart().TrimEnd('\r');
			if (value.Length > 0)
			{
				return value;
			}
		}

		return null;
	}

	private static string? ExtractOriginRepositoryName(string gitConfig)
	{
		var section = OriginSection().Match(gitConfig);
		if (!section.Success)
		{
			return null;
		}

		var url = UrlLine().Match(section.Groups[1].Value);
		if (!url.Success)
		{
			return null;
		}

		var value = url.Groups[1].Value.Trim();
		var lastSegment = value[(value.LastIndexOfAny(['/', ':']) + 1)..];
		return lastSegment.EndsWith(".git", StringComparison.Ordinal) ? lastSegment[..^4] : lastSegment;
	}

	private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

	private static string? TryReadText(string path)
	{
		try
		{
			return File.ReadAllText(path);
		}
		catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
		{
			return null;
		}
	}

	[GeneratedRegex("""\[remote "origin"\]([\s\S]*?)(?:\n\[|\z)""", RegexOptions.CultureInvariant)]
	private static partial Regex OriginSection();

	[GeneratedRegex(@"^\s*url\s*=\s*(.+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant)]
	private static partial Regex UrlLine();
}
