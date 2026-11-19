namespace AgentLogbook.Core.Identity;

/// <summary>A stable UUID or a canonical reference is not valid. The message is the retained contract text.</summary>
public sealed class MalformedReferenceException(string message) : FormatException(message);
