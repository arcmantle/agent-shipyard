using System.Text.Json;
using AgentLogbook.Api.Auth;
using AgentLogbook.Api.Entities;
using AgentLogbook.Api.Workspaces;
using Npgsql;

namespace AgentLogbook.Api.Rpc;

/// <summary>What one JSON-RPC method gets: who calls, the project identity header, the raw params, and the database.</summary>
public sealed record RpcCall(
	ApiIdentity Identity,
	string? ProjectIdentity,
	JsonElement? Params,
	NpgsqlDataSource DataSource,
	CancellationToken CancellationToken);

/// <summary>
/// The JSON-RPC methods that this release implements, by name. A feature slice adds its methods here. A method that
/// is not registered answers <c>Method not found</c>, as the TypeScript host does for a method it does not have.
/// </summary>
public sealed class RpcMethodRegistry
{
	private readonly Dictionary<string, Func<RpcCall, Task<object?>>> methods = new(StringComparer.Ordinal);

	public RpcMethodRegistry Add(string name, Func<RpcCall, Task<object?>> handler)
	{
		ArgumentException.ThrowIfNullOrEmpty(name);
		ArgumentNullException.ThrowIfNull(handler);
		if (!methods.TryAdd(name, handler))
		{
			throw new ArgumentException($"The RPC method '{name}' is registered twice.", nameof(name));
		}

		return this;
	}

	public bool TryGet(string name, out Func<RpcCall, Task<object?>> handler) => methods.TryGetValue(name, out handler!);

	/// <summary>The registry of this release.</summary>
	public static RpcMethodRegistry CreateDefault() => new RpcMethodRegistry().AddWorkspaceMethods().AddEntityMethods();
}
