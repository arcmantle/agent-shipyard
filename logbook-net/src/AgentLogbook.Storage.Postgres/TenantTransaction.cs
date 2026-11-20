using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres;

/// <summary>
/// One transaction that is scoped to a tenant. Row-level security reads <c>app.tenant_id</c>, which is set for this transaction only,
/// so a statement in it can only see and change the rows of that tenant. The transaction commits when the work returns and rolls back
/// when it throws.
/// </summary>
internal static class TenantTransaction
{
	public static async Task<T> RunAsync<T>(
		NpgsqlDataSource dataSource,
		string tenantId,
		Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work,
		CancellationToken cancellationToken)
	{
		await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
		await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
		await connection.ExecuteAsync(new CommandDefinition(
			"SELECT set_config('app.tenant_id', @tenantId, true)", new { tenantId }, transaction, cancellationToken: cancellationToken));

		var result = await work(connection, transaction);
		await transaction.CommitAsync(cancellationToken);
		return result;
	}
}
