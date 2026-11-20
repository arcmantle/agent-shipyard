using AgentLogbook.Core.ContentHashes;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.ProjectIdentity;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Workspaces;

/// <summary>
/// Opens the workspace of one tenant. It is the port of the TypeScript <c>ensurePgTenant</c>, <c>getOrCreateProjectByIdentity</c>
/// and <c>resolveCurrentProjectId</c>: the per-kind counters, the default project and epic with their <c>contains</c> relation,
/// and the project that a project identity names, registered with its own epic on first use. All of it runs in one transaction
/// that is scoped to the tenant for row-level security.
/// </summary>
public static class WorkspaceInitializer
{
	/// <summary>
	/// Opens the workspace for <paramref name="projectIdentity"/>. A missing or blank identity resolves to the default project.
	/// The call is safe to repeat and safe to run at the same time for the same identity.
	/// </summary>
	/// <exception cref="WorkspaceException">The identity names two projects, or names a record that does not exist.</exception>
	public static async Task<InitializedWorkspace> InitializeAsync(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(dataSource);
		ArgumentException.ThrowIfNullOrWhiteSpace(tenantId);

		return await TenantTransaction.RunAsync(dataSource, tenantId, async (connection, transaction) =>
		{
			var workspace = new TenantWorkspace(connection, transaction, tenantId, cancellationToken);
			var selector = projectIdentity?.Trim();
			return string.IsNullOrEmpty(selector)
				? await workspace.OpenDefaultAsync()
				: await workspace.OpenByIdentityAsync(selector);
		}, cancellationToken);
	}
}

