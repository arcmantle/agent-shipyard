using System.Diagnostics.CodeAnalysis;

namespace AgentLogbook.Mcp;

/// <summary>Picks the workspace of an MCP session from the roots that the client lists.</summary>
internal static class WorkspaceRoots
{
	/// <summary>The path of the first root that is a <c>file:</c> URI, or null when there is none.</summary>
	public static string? Select(IEnumerable<string> rootUris)
	{
		foreach (var uri in rootUris)
		{
			if (TryFilePath(uri, out var path))
			{
				return path;
			}
		}

		return null;
	}

	private static bool TryFilePath(string uri, [NotNullWhen(true)] out string? path)
	{
		path = null;
		if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) || !parsed.IsFile)
		{
			return false;
		}

		path = parsed.LocalPath;
		return true;
	}
}
