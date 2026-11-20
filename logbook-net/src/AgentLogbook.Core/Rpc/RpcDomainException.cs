namespace AgentLogbook.Core.Rpc;

/// <summary>
/// A request that the data or the workflow rules do not allow. The message is written for the caller and is safe to show:
/// the API host sends it as the message of the JSON-RPC error. Any other exception is a program failure with a fixed message.
/// </summary>
public abstract class RpcDomainException(string message) : Exception(message);
