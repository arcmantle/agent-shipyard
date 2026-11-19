using System.Net;
using AgentLogbook.Api.Auth;
using AgentLogbook.Core.ShipyardData;
using AgentLogbook.Storage.Postgres;
using Npgsql;

namespace AgentLogbook.Api;

/// <summary>
/// The Development API host that the Aspire AppHost starts. It runs the same shared API as the Local API host, with the PostgreSQL
/// that Aspire supplies and a port that Aspire assigns. It never reads or writes the user discovery file, and it never starts
/// without an explicit Shipyard data folder, so a development run cannot touch the installed local state.
/// </summary>
public static class DevelopmentApiHost
{
	/// <summary>The connection string that Aspire supplies for the database resource named <c>logbook</c>.</summary>
	public const string ConnectionStringVariable = "ConnectionStrings__logbook";

	/// <summary>The loopback port that the host listens on. Aspire assigns it.</summary>
	public const string PortVariable = "AGENT_LOGBOOK_DEV_API_PORT";

	/// <summary>
	/// Sets up the schema and starts the API on 127.0.0.1. Any failure leaves no running host.
	/// </summary>
	/// <exception cref="InvalidOperationException">A required setting is missing or not usable.</exception>
	public static async Task<RunningApiHost> StartAsync(
		string toolVersion,
		Func<string, string?> getEnvironmentVariable,
		string osUserName,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(getEnvironmentVariable);

		// The default folder is the user's own folder. A development host must be told where its state lives.
		if (string.IsNullOrWhiteSpace(getEnvironmentVariable(ShipyardLogbookFolder.HomeVariable)))
		{
			throw new InvalidOperationException(
				$"The Development API host needs {ShipyardLogbookFolder.HomeVariable}, so that it cannot use the user Shipyard data folder.");
		}

		var connectionString = getEnvironmentVariable(ConnectionStringVariable);
		if (string.IsNullOrWhiteSpace(connectionString))
		{
			throw new InvalidOperationException($"The Development API host needs the PostgreSQL connection string in {ConnectionStringVariable}.");
		}

		if (!int.TryParse(getEnvironmentVariable(PortVariable), out var port) || port is < 1 or > 65535)
		{
			throw new InvalidOperationException($"The Development API host needs a port from 1 to 65535 in {PortVariable}.");
		}

		ShipyardLogbookFolder.Resolve(getEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).EnsureExists();

		var dataSource = NpgsqlDataSource.Create(connectionString);
		try
		{
			await PostgresSchemaInitializer.InitializeAsync(dataSource, cancellationToken: cancellationToken);

			return await ApiHost.StartAsync(
				new ApiHostOptions
				{
					AuthProvider = LocalNoAuthProvider.Enable(osUserName),
					DataSource = dataSource,
					ToolVersion = toolVersion,
					ListenAddress = IPAddress.Loopback,
					ListenPort = port,
				},
				cancellationToken);
		}
		catch
		{
			await dataSource.DisposeAsync();
			throw;
		}
	}
}
