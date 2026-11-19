namespace AgentLogbook.Core.LocalApi;

/// <summary>Where the selected local PostgreSQL connection came from.</summary>
public enum LocalPostgresSource
{
	/// <summary>The <c>AGENT_LOGBOOK_LOCAL_PG_URL</c> environment variable.</summary>
	Environment,

	/// <summary>The <c>postgresUrl</c> setting in <c>local-api.settings.json</c>.</summary>
	SettingsFile,

	/// <summary>The built-in default that matches the supplied Docker Compose file.</summary>
	BuiltInDefault,
}

/// <summary>A validated PostgreSQL connection that the Local API host uses.</summary>
public sealed record LocalPostgresConnection
{
	private LocalPostgresConnection(string host, int port, string database, string username, string? password)
	{
		Host = host;
		Port = port;
		Database = database;
		Username = username;
		Password = password;
	}

	public const int DefaultPort = 5432;

	public string Host { get; }

	public int Port { get; }

	public string Database { get; }

	public string Username { get; }

	public string? Password { get; }

	/// <summary>The description of the connection without the password. Use it in messages and logs.</summary>
	public override string ToString() => $"postgres://{Username}@{Host}:{Port}/{Database}";

	/// <summary>Parses a <c>postgres://</c> or <c>postgresql://</c> URL. The message never contains the password.</summary>
	/// <exception cref="FormatException">The URL is not a complete PostgreSQL connection URL.</exception>
	public static LocalPostgresConnection Parse(string url)
	{
		ArgumentNullException.ThrowIfNull(url);

		if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)
			|| !(uri.Scheme is "postgres" or "postgresql"))
		{
			throw new FormatException("The value must be a URL that starts with postgres:// or postgresql://.");
		}

		if (uri.Host.Length == 0)
		{
			throw new FormatException("The URL must name a host.");
		}

		if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
		{
			throw new FormatException("The URL must not have query parameters or a fragment.");
		}

		var path = uri.AbsolutePath.Trim('/');
		if (path.Length == 0 || path.Contains('/', StringComparison.Ordinal))
		{
			throw new FormatException("The URL path must be exactly one database name.");
		}

		var userInfo = uri.UserInfo;
		var separator = userInfo.IndexOf(':', StringComparison.Ordinal);
		var user = Uri.UnescapeDataString(separator < 0 ? userInfo : userInfo[..separator]);
		var password = separator < 0 ? null : Uri.UnescapeDataString(userInfo[(separator + 1)..]);
		if (user.Length == 0)
		{
			throw new FormatException("The URL must name a user.");
		}

		return new(
			uri.IdnHost,
			uri.Port < 0 ? DefaultPort : uri.Port,
			Uri.UnescapeDataString(path),
			user,
			password);
	}
}
