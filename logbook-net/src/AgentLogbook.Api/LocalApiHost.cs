using System.Net;
using AgentLogbook.Api.Auth;
using AgentLogbook.Core.LocalApi;
using AgentLogbook.Core.ShipyardData;
using AgentLogbook.Storage.Postgres;

namespace AgentLogbook.Api;

/// <summary>The foreground Local API host: shared API, explicit no-auth, loopback only, user-supplied PostgreSQL.</summary>
public sealed class LocalApiHost : IAsyncDisposable
{
	private static readonly TimeSpan StartLockTimeout = TimeSpan.FromSeconds(30);

	private readonly RunningApiHost host;
	private readonly ShipyardLogbookFolder folder;
	private readonly Npgsql.NpgsqlDataSource dataSource;

	private LocalApiHost(RunningApiHost host, ShipyardLogbookFolder folder, Npgsql.NpgsqlDataSource dataSource, LocalApiDiscovery discovery)
	{
		this.host = host;
		this.folder = folder;
		this.dataSource = dataSource;
		Discovery = discovery;
	}

	public LocalApiDiscovery Discovery { get; }

	/// <summary>
	/// Selects PostgreSQL, sets up the schema, starts the API on 127.0.0.1 with an OS-assigned port, and only then publishes the
	/// discovery file. Any failure leaves no discovery file and no running host.
	/// </summary>
	/// <exception cref="LocalApiStartupException">The host cannot start. The message says why.</exception>
	public static async Task<LocalApiHost> StartAsync(
		string toolVersion,
		Func<string, string?> getEnvironmentVariable,
		string osUserName,
		CancellationToken cancellationToken = default)
	{
		try
		{
			return await StartCoreAsync(toolVersion, getEnvironmentVariable, osUserName, cancellationToken);
		}
		catch (Exception exception) when (exception is LocalPostgresSettingsException or ShipyardDataFolderException
			or Npgsql.NpgsqlException or UnrecognizedSchemaException or InvalidOperationException or ArgumentException
			or System.Security.Authentication.AuthenticationException or IOException
			or System.Net.Sockets.SocketException or UnauthorizedAccessException)
		{
			throw new LocalApiStartupException(exception.Message, exception);
		}
	}

	private static async Task<LocalApiHost> StartCoreAsync(
		string toolVersion,
		Func<string, string?> getEnvironmentVariable,
		string osUserName,
		CancellationToken cancellationToken)
	{
		var folder = ShipyardLogbookFolder.Resolve(getEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).EnsureExists();
		var selection = LocalPostgresSelection.Select(getEnvironmentVariable, folder);

		// One start at a time: the check of the discovery file and the write of the new one must not interleave with another start.
		await using var startLock = await AcquireStartLockAsync(folder, cancellationToken);

		var existing = LocalApiDiscovery.Read(folder);
		if (existing is not null)
		{
			if (existing.IsProcessAlive())
			{
				throw new LocalApiStartupException(
					$"A Local API host is already running at {existing.Url} (process {existing.ProcessId}). Stop it before you start another one.");
			}

			// A host that was killed leaves its file. Remove it so that a failed start cannot look like a host.
			File.Delete(folder.DiscoveryFile);
		}

		var dataSource = LocalPostgresDataSource.Create(selection.Connection);
		RunningApiHost? host = null;
		try
		{
			await PostgresSchemaInitializer.InitializeAsync(dataSource, cancellationToken: cancellationToken);

			host = await ApiHost.StartAsync(
				new ApiHostOptions
				{
					AuthProvider = LocalNoAuthProvider.Enable(osUserName),
					DataSource = dataSource,
					ToolVersion = toolVersion,
					ListenAddress = IPAddress.Loopback,
					ListenPort = 0,
				},
				cancellationToken);

			var discovery = new LocalApiDiscovery(
				host.Url.GetLeftPart(UriPartial.Authority),
				host.Port,
				Environment.ProcessId,
				toolVersion,
				DateTimeOffset.UtcNow);
			discovery.Write(folder);

			return new LocalApiHost(host, folder, dataSource, discovery);
		}
		catch
		{
			if (host is not null)
			{
				await host.DisposeAsync();
			}

			await dataSource.DisposeAsync();
			throw;
		}
	}

	private static async Task<FileStream> AcquireStartLockAsync(ShipyardLogbookFolder folder, CancellationToken cancellationToken)
	{
		var deadline = System.Diagnostics.Stopwatch.StartNew();
		while (true)
		{
			try
			{
				return new FileStream(folder.StartLockFile, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.None);
			}
			catch (IOException) when (deadline.Elapsed < StartLockTimeout)
			{
				await Task.Delay(100, cancellationToken);
			}
		}
	}

	/// <summary>Removes the discovery file first, so that no client finds a host that no longer answers, then stops the API.</summary>
	public async Task StopAsync(CancellationToken cancellationToken = default)
	{
		Discovery.RemoveIfCurrent(folder);
		await host.StopAsync(cancellationToken);
	}

	public async ValueTask DisposeAsync()
	{
		Discovery.RemoveIfCurrent(folder);
		await host.DisposeAsync();
		await dataSource.DisposeAsync();
	}
}

/// <summary>The Local API host did not start. No discovery file was published.</summary>
public sealed class LocalApiStartupException : Exception
{
	public LocalApiStartupException(string message)
		: base(message)
	{
	}

	public LocalApiStartupException(string message, Exception innerException)
		: base(message, innerException)
	{
	}
}
