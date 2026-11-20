namespace AgentLogbook.Core.Rpc;

/// <summary>A project or an epic of a workspace, as the RPC methods of the workspace feature report it.</summary>
public sealed record WorkspaceEntity(string Id, string Reference, string ShortReference, string Title);

/// <summary>
/// The result of <see cref="WorkspaceRpc.InitializeMethod"/>: the project that the request identity names with its epic,
/// and the default project and epic of the tenant. <see cref="Created"/> is true when this call registered the project.
/// </summary>
public sealed record InitializedWorkspace(
	string TenantId,
	WorkspaceEntity Project,
	WorkspaceEntity Epic,
	bool Created,
	WorkspaceEntity DefaultProject,
	WorkspaceEntity DefaultEpic);

/// <summary>The wire contract of the workspace feature.</summary>
public static class WorkspaceRpc
{
	/// <summary>
	/// Opens the workspace of the request. The TypeScript implementation does this work when it opens a store for any
	/// project call; the .NET client opens no store, so <c>init</c> asks for it explicitly. The method has no parameters:
	/// the tenant comes from the login and the project from <see cref="RpcWire.ProjectIdentityHeader"/>.
	/// </summary>
	public const string InitializeMethod = "initializeWorkspace";
}
