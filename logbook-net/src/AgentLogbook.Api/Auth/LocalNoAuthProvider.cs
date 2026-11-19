using Microsoft.AspNetCore.Http;

namespace AgentLogbook.Api.Auth;

/// <summary>
/// No-auth mode of the Local API host: every request acts as the one OS user in the tenant <c>local-&lt;OS user name&gt;</c>.
/// There is no constructor and no default. Only <see cref="Enable"/> creates it, so only the code that starts the local host can turn it on.
/// The API host listens on loopback addresses only while this provider is in use.
/// </summary>
public sealed class LocalNoAuthProvider : IAuthProvider
{
	public const string Provider = "none";

	private LocalNoAuthProvider(ApiIdentity identity)
	{
		Identity = identity;
	}

	public ApiIdentity Identity { get; }

	public object Metadata => new { provider = Provider, tenant = Identity.TenantId };

	public bool RequiresLoopback => true;

	/// <summary>Explicitly enables no-auth mode for the OS user <paramref name="osUserName"/>.</summary>
	public static LocalNoAuthProvider Enable(string osUserName)
	{
		if (string.IsNullOrWhiteSpace(osUserName))
		{
			throw new ArgumentException("The OS user name must not be empty.", nameof(osUserName));
		}

		return new(new ApiIdentity($"local-{osUserName}", osUserName));
	}

	public ValueTask<ApiIdentity?> AuthenticateAsync(HttpContext context) => ValueTask.FromResult<ApiIdentity?>(Identity);
}
