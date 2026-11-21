namespace AgentLogbook.Client;

/// <summary>
/// The command that runs <c>agent-logbook serve</c> in the foreground: the file to start and all its arguments, including <c>serve</c>.
/// The owner of the entry point builds it, because only the entry point knows how the tool was started.
/// </summary>
public sealed record LocalApiLaunch(string FileName, IReadOnlyList<string> Arguments);
