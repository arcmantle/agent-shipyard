using Microsoft.AspNetCore.Http;

namespace AgentLogbook.Api.Auth;

/// <summary>The tenant and the user that a request acts as.</summary>
public sealed record ApiIdentity(string TenantId, string UserName);

/// <summary>
/// The one place where the API host learns who a request acts as. The production host uses Entra ID.
/// The Local API host uses <see cref="LocalNoAuthProvider"/>.
/// </summary>
public interface IAuthProvider
{
	/// <summary>The content of the <c>auth</c> field of the discovery document. It names the provider.</summary>
	object Metadata { get; }

	/// <summary>True when the provider accepts requests without a login. The host then listens on loopback addresses only.</summary>
	bool RequiresLoopback { get; }

	/// <summary>The identity of the request, or null when the request is not allowed.</summary>
	ValueTask<ApiIdentity?> AuthenticateAsync(HttpContext context);
}
