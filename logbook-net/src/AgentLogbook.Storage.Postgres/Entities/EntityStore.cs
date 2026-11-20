using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Identity;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Storage.Postgres.Workspaces;
using Npgsql;

namespace AgentLogbook.Storage.Postgres.Entities;

/// <summary>
/// The entity records of one tenant: create, read with relations, list and query. It is the port of the TypeScript
/// <c>PgEntityStore</c> and <c>PgStore</c> methods of the same names, with the SQL of the TypeScript Postgres storage. Every call is one
/// transaction that is scoped to the tenant for row-level security, and acts in the project that the project identity names.
/// </summary>
public static class EntityStore
{
	/// <summary>Creates an entity under an optional structural parent and writes its first revision. The author is the user of the login.</summary>
	/// <exception cref="EntityException">The request breaks a workflow rule or names a record that does not exist.</exception>
	public static Task<EntitySummary> CreateAsync(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		string actorSubject,
		CreateEntityRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		ArgumentException.ThrowIfNullOrWhiteSpace(actorSubject);
		return RunAsync(dataSource, tenantId, projectIdentity, session => session.CreateAsync(actorSubject, request), cancellationToken);
	}

	/// <summary>An entity with the relations around it, its derived status, and for an issue its completion observations and comments.</summary>
	/// <exception cref="EntityException">No entity has the ID, reference or short reference, or the workspace has no such entity.</exception>
	public static Task<EntityDetails> GetDetailsAsync(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		string entityId,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(entityId);
		return RunAsync(dataSource, tenantId, projectIdentity, session => session.GetDetailsAsync(entityId), cancellationToken);
	}

	/// <summary>The entities of one kind in the current project, by ID, with derived statuses.</summary>
	public static Task<IReadOnlyList<EntitySummary>> ListAsync(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		string? kind,
		CancellationToken cancellationToken = default) =>
		RunAsync(dataSource, tenantId, projectIdentity, session => session.ListAsync(kind), cancellationToken);

	/// <summary>The entities of one kind that match the filters, with the total before the limit.</summary>
	public static Task<QueryEntitiesResult> QueryAsync(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		QueryEntitiesRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		return RunAsync(dataSource, tenantId, projectIdentity, session => session.QueryAsync(request), cancellationToken);
	}

	private static Task<T> RunAsync<T>(
		NpgsqlDataSource dataSource,
		string tenantId,
		string? projectIdentity,
		Func<EntitySession, Task<T>> work,
		CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(dataSource);
		ArgumentException.ThrowIfNullOrWhiteSpace(tenantId);
		return TenantTransaction.RunAsync(dataSource, tenantId, async (connection, transaction) =>
		{
			// The project resolves before anything else, in the same transaction: its registration is serialized by an advisory lock.
			var workspace = new TenantWorkspace(connection, transaction, tenantId, cancellationToken);
			var projectId = await workspace.ResolveCurrentProjectIdAsync(projectIdentity);
			return await work(new EntitySession(connection, transaction, tenantId, projectId, projectIdentity, workspace, cancellationToken));
		}, cancellationToken);
	}
}
