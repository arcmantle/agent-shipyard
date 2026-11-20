using AgentLogbook.Core.ProjectIdentity;
using AgentLogbook.Core.ShipyardData;

namespace AgentLogbook.Client;

/// <summary>
/// How the CLI and the MCP server open the store of one workspace: route to the API host, resolve the project identity, and
/// build an <see cref="HttpStore"/>. Both use this one path, so they agree on the backend and the identity.
/// </summary>
public static class WorkspaceStore
{
	/// <summary>
	/// Opens the store of <paramref name="workspaceRoot"/>. <paramref name="projectIdentity"/> replaces the resolved identity when it is set.
	/// The caller disposes the store.
	/// </summary>
	public static async Task<HttpStore> OpenAsync(
		string workspaceRoot,
		Func<string, string?> getEnvironmentVariable,
		string? projectIdentity = null,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(workspaceRoot);
		ArgumentNullException.ThrowIfNull(getEnvironmentVariable);

		var folder = ShipyardLogbookFolder.Resolve(getEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
		var route = await BackendRouter.ResolveAsync(getEnvironmentVariable, folder, cancellationToken: cancellationToken);
		return new HttpStore(new HttpStoreOptions
		{
			BaseUrl = route.BaseUrl,
			BearerToken = route.BearerToken,
			ProjectIdentity = projectIdentity ?? ProjectIdentityResolver.Resolve(workspaceRoot, getEnvironmentVariable).Identity,
			WorkspaceRoot = workspaceRoot,
		});
	}
}
