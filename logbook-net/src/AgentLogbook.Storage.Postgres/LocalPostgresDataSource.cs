using AgentLogbook.Core.LocalApi;
using Npgsql;

namespace AgentLogbook.Storage.Postgres;

/// <summary>Opens the selected local PostgreSQL connection. A connection failure is an error; no other database is tried.</summary>
public static class LocalPostgresDataSource
{
	public static NpgsqlConnectionStringBuilder ToConnectionStringBuilder(this LocalPostgresConnection connection)
	{
		ArgumentNullException.ThrowIfNull(connection);

		return new NpgsqlConnectionStringBuilder
		{
			Host = connection.Host,
			Port = connection.Port,
			Database = connection.Database,
			Username = connection.Username,
			Password = connection.Password,
		};
	}

	public static NpgsqlDataSource Create(LocalPostgresConnection connection) =>
		NpgsqlDataSource.Create(connection.ToConnectionStringBuilder());
}
