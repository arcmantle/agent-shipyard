using System.Text.Json;

namespace AgentLogbook.Core.Rpc;

/// <summary>
/// A JSON-RPC error response. The subclasses are the error kinds that the wire contract identifies by the shape of the error
/// <c>data</c>; every other error is an <see cref="RpcServerException"/>. <see cref="ErrorData"/> is always the data of the response.
/// </summary>
public class RpcException : Exception
{
	public RpcException(string message, int code, JsonElement? data)
		: base(message)
	{
		Code = code;
		ErrorData = data;
	}

	public int Code { get; }

	/// <summary>The <c>data</c> of the error response. Null when the response has no <c>data</c> field.</summary>
	public JsonElement? ErrorData { get; }
}

/// <summary>An error response that has no known data shape. The message is the message of the response.</summary>
public sealed class RpcServerException(string message, int code, JsonElement? data) : RpcException(message, code, data);

/// <summary>A write used a stale revision of an entity.</summary>
public sealed class EntityConflictException(string message, int code, JsonElement? data, string entityId, int currentRevision, string currentContentHash)
	: RpcException(message, code, data)
{
	public string EntityId { get; } = entityId;

	public int CurrentRevision { get; } = currentRevision;

	public string CurrentContentHash { get; } = currentContentHash;
}

/// <summary>A write used a stale revision of an issue comment.</summary>
public sealed class IssueCommentConflictException(string message, int code, JsonElement? data, string commentId, int currentRevision, string currentContentHash)
	: RpcException(message, code, data)
{
	public string CommentId { get; } = commentId;

	public int CurrentRevision { get; } = currentRevision;

	public string CurrentContentHash { get; } = currentContentHash;
}

/// <summary>A write used a stale revision of a Plan entry.</summary>
public sealed class PlanEntryConflictException(string message, int code, JsonElement? data, string entryId, int currentRevision, string currentContentHash)
	: RpcException(message, code, data)
{
	public string EntryId { get; } = entryId;

	public int CurrentRevision { get; } = currentRevision;

	public string CurrentContentHash { get; } = currentContentHash;
}

/// <summary>A write used a stale revision of a context summary.</summary>
public sealed class ContextConflictException(string message, int code, JsonElement? data, string contextKey, int currentRevision, string currentContentHash)
	: RpcException(message, code, data)
{
	public string ContextKey { get; } = contextKey;

	public int CurrentRevision { get; } = currentRevision;

	public string CurrentContentHash { get; } = currentContentHash;
}

/// <summary>A write used a stale revision of a context term.</summary>
public sealed class ContextTermConflictException(string message, int code, JsonElement? data, string contextKey, string term, int currentRevision, string currentContentHash)
	: RpcException(message, code, data)
{
	public string ContextKey { get; } = contextKey;

	public string Term { get; } = term;

	public int CurrentRevision { get; } = currentRevision;

	public string CurrentContentHash { get; } = currentContentHash;
}

/// <summary>A read of an entity revision failed. <see cref="Reason"/> is <c>entity-not-found</c>, <c>revision-out-of-range</c>, or <c>broken-chain</c>.</summary>
public sealed class EntityRevisionException(string message, int code, JsonElement? data, string entityId, string reason, int? headRevision)
	: RpcException(message, code, data)
{
	public string EntityId { get; } = entityId;

	public string Reason { get; } = reason;

	public int? HeadRevision { get; } = headRevision;
}

/// <summary>
/// A read of a context revision failed. <see cref="Reason"/> is <c>context-not-found</c>, <c>term-not-found</c>,
/// <c>revision-out-of-range</c>, or <c>broken-chain</c>.
/// </summary>
public sealed class ContextRevisionException(string message, int code, JsonElement? data, string contextKey, string reason, int? headRevision, string? term)
	: RpcException(message, code, data)
{
	public string ContextKey { get; } = contextKey;

	public string Reason { get; } = reason;

	public int? HeadRevision { get; } = headRevision;

	public string? Term { get; } = term;
}

/// <summary>A completion observation was recorded with different content before.</summary>
public sealed class CompletionObservationConflictException(string message, int code, JsonElement? data, string observationId)
	: RpcException(message, code, data)
{
	public string ObservationId { get; } = observationId;
}
