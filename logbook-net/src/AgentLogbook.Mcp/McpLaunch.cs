namespace AgentLogbook.Mcp;

/// <summary>The arguments after the first-argument <c>--mcp</c>.</summary>
public static class McpLaunch
{
	public const string Flag = "--mcp";

	public const string ProjectIdentityFlag = "--project-identity";

	public const string Usage = $"Usage: {Flag} [{ProjectIdentityFlag} <projectIdentity>]";

	/// <summary>Parses the arguments that follow <c>--mcp</c>. Returns false with the usage text when they are not valid.</summary>
	public static bool TryParse(IReadOnlyList<string> arguments, out string? projectIdentity, out string? error)
	{
		projectIdentity = null;
		error = null;
		if (arguments.Count == 0)
		{
			return true;
		}

		if (arguments is [ProjectIdentityFlag, { Length: > 0 } identity])
		{
			projectIdentity = identity;
			return true;
		}

		error = Usage;
		return false;
	}
}
