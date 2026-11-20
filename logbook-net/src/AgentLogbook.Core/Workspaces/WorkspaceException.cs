namespace AgentLogbook.Core.Workspaces;

/// <summary>A workspace request that the data does not allow, for example a project identity that names two projects. The message is safe to show to the caller.</summary>
public sealed class WorkspaceException(string message) : Exception(message);
