namespace AgentLogbook.Mcp;

/// <summary>What one MCP server run needs from its host process.</summary>
/// <param name="WorkspaceRoot">The workspace when the MCP client offers no file root.</param>
/// <param name="GetEnvironmentVariable">The environment of the process.</param>
/// <param name="ProjectIdentity">An identity from <c>--project-identity</c>. It replaces the identity of the workspace.</param>
/// <param name="ToolVersion">The version that the server reports in its server info.</param>
public sealed record AgentLogbookMcpOptions(
	string WorkspaceRoot,
	Func<string, string?> GetEnvironmentVariable,
	string ToolVersion,
	string? ProjectIdentity = null);
