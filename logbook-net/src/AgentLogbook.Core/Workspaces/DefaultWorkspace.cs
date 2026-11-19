using AgentLogbook.Core.Identity;

namespace AgentLogbook.Core.Workspaces;

/// <summary>
/// The default project and epic that every tenant has. Their IDs derive from the legacy aliases <c>PROJ0</c> and
/// <c>EPIC0</c> with the retained entity namespace, so every tenant, every release, and the TypeScript implementation
/// give the same IDs.
/// </summary>
public static class DefaultWorkspace
{
	public const string ProjectAlias = "PROJ0";
	public const string EpicAlias = "EPIC0";
	public const string ProjectTitle = "Default Project";
	public const string EpicTitle = "Default Epic";

	public static DerivedIdentity Project { get; } = StableIdentity.DeriveEntity(ReferenceKind.Project, ProjectAlias);

	public static DerivedIdentity Epic { get; } = StableIdentity.DeriveEntity(ReferenceKind.Epic, EpicAlias);
}
