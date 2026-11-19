using AgentLogbook.Api.Rpc;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Storage.Postgres.Workspaces;

namespace AgentLogbook.Api.Workspaces;

internal static class WorkspaceRpcHandlers
{
	public static RpcMethodRegistry AddWorkspaceMethods(this RpcMethodRegistry registry) =>
		registry.Add(WorkspaceRpc.InitializeMethod, async call =>
			await WorkspaceInitializer.InitializeAsync(call.DataSource, call.Identity.TenantId, call.ProjectIdentity, call.CancellationToken));
}
