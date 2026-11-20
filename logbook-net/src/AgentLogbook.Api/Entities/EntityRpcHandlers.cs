using System.Text.Json;
using AgentLogbook.Api.Rpc;
using AgentLogbook.Core.Entities;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Storage.Postgres.Entities;

namespace AgentLogbook.Api.Entities;

internal static class EntityRpcHandlers
{
	public static RpcMethodRegistry AddEntityMethods(this RpcMethodRegistry registry) => registry
		.Add(EntityRpc.CreateMethod, async call => await EntityStore.CreateAsync(
			call.DataSource, call.Identity.TenantId, call.ProjectIdentity, call.Identity.UserName,
			ReadParameters<CreateEntityRequest>(call, EntityRpc.CreateMethod), call.CancellationToken))
		.Add(EntityRpc.GetDetailsMethod, async call => await EntityStore.GetDetailsAsync(
			call.DataSource, call.Identity.TenantId, call.ProjectIdentity,
			ReadParameters<GetEntityDetailsRequest>(call, EntityRpc.GetDetailsMethod).EntityId ?? "undefined", call.CancellationToken))
		.Add(EntityRpc.ListMethod, async call => await EntityStore.ListAsync(
			call.DataSource, call.Identity.TenantId, call.ProjectIdentity,
			ReadParameters<ListEntitiesRequest>(call, EntityRpc.ListMethod).Kind, call.CancellationToken))
		.Add(EntityRpc.QueryMethod, async call => await EntityStore.QueryAsync(
			call.DataSource, call.Identity.TenantId, call.ProjectIdentity,
			ReadParameters<QueryEntitiesRequest>(call, EntityRpc.QueryMethod), call.CancellationToken));

	/// <summary>The parameters of a call. A call without <c>params</c> has all fields unset.</summary>
	private static T ReadParameters<T>(RpcCall call, string method)
	{
		try
		{
			return (call.Params is { ValueKind: not JsonValueKind.Null } parameters
				? parameters.Deserialize<T>(RpcWire.JsonOptions)
				: JsonSerializer.Deserialize<T>("{}", RpcWire.JsonOptions))
				?? throw new EntityException($"Invalid parameters for {method}.");
		}
		catch (JsonException)
		{
			throw new EntityException($"Invalid parameters for {method}.");
		}
	}
}
