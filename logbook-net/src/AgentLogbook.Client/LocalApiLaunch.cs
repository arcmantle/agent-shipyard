namespace AgentLogbook.Client;

/// <summary>
/// The command that runs <c>agent-logbook serve</c> in the foreground: the file to start and all its arguments, including <c>serve</c>.
/// The owner of the entry point builds it, because only the entry point knows how the tool was started.
/// </summary>
/// <param name="ToolVersion">
/// The version of the host that this command starts, which is the version of the caller. A running host with another version is replaced
/// before a request uses it. When it is null, the caller accepts any running host.
/// </param>
public sealed record LocalApiLaunch(string FileName, IReadOnlyList<string> Arguments, string? ToolVersion = null);
