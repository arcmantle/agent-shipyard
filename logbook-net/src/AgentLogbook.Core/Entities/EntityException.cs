using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Core.Entities;

/// <summary>An entity request that the workflow rules or the data do not allow. The message is safe to show to the caller.</summary>
public sealed class EntityException(string message) : RpcDomainException(message);
