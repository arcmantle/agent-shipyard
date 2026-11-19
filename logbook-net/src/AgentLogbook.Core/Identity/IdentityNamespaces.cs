namespace AgentLogbook.Core.Identity;

/// <summary>
/// The namespace text that every derived stable ID hashes first. They are fixed data-format values of
/// the retained agent-issues format, not product names: a change gives different IDs for the same
/// input and breaks the TypeScript storage-driver contract suite. They are the only names that keep
/// the old product name.
/// </summary>
public static class IdentityNamespaces
{
	public const string Entity = "agent-issues/entity-stable-id/v1";

	public const string Context = "agent-issues/context-stable-id/v1";

	public const string ContextTerm = "agent-issues/context-term-id/v1";

	public const string User = "agent-issues/user-stable-id/v1";
}
