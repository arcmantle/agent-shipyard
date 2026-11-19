using System.Net;
using AgentLogbook.Api.Auth;
using Npgsql;

namespace AgentLogbook.Api;

/// <summary>What <see cref="ApiHost"/> needs. Nothing has a default that opens the host to other machines or removes the login.</summary>
public sealed class ApiHostOptions
{
	public required IAuthProvider AuthProvider { get; init; }

	public required NpgsqlDataSource DataSource { get; init; }

	public required string ToolVersion { get; init; }

	public required IPAddress ListenAddress { get; init; }

	/// <summary>The port to listen on. 0 lets the OS choose.</summary>
	public int ListenPort { get; init; }

	internal void Validate()
	{
		if (AuthProvider.RequiresLoopback && !IPAddress.IsLoopback(ListenAddress))
		{
			throw new InvalidOperationException(
				$"The auth provider accepts requests without a login, so the host can listen on a loopback address only, not on {ListenAddress}.");
		}
	}
}
