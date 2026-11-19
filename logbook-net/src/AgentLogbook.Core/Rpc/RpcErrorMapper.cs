using System.Text.Json;

namespace AgentLogbook.Core.Rpc;

/// <summary>
/// Turns the error object of a JSON-RPC error response into an exception. The kind follows the shape of <c>data</c>,
/// in the order of the TypeScript client, because several shapes share fields.
/// </summary>
public static class RpcErrorMapper
{
	private static readonly string[] EntityRevisionReasons = ["entity-not-found", "revision-out-of-range", "broken-chain"];
	private static readonly string[] ContextRevisionReasons = ["context-not-found", "term-not-found", "revision-out-of-range", "broken-chain"];

	public static RpcException Map(JsonElement error)
	{
		var message = StringField(error, "message") ?? string.Empty;
		var code = error.ValueKind == JsonValueKind.Object && error.TryGetProperty("code", out var codeElement) && codeElement.TryGetInt32(out var parsedCode)
			? parsedCode
			: RpcWire.ServerErrorCode;
		JsonElement? data = error.ValueKind == JsonValueKind.Object && error.TryGetProperty("data", out var dataElement) ? dataElement.Clone() : null;

		if (data is not { ValueKind: JsonValueKind.Object } d)
		{
			return new RpcServerException(message, code, data);
		}

		if (StringField(d, "observationId") is { } observationId)
		{
			return new CompletionObservationConflictException(message, code, data, observationId);
		}

		if (IsConflict(d, out var revision, out var hash))
		{
			if (StringField(d, "entityId") is { } entityId)
			{
				return new EntityConflictException(message, code, data, entityId, revision, hash);
			}

			if (StringField(d, "commentId") is { } commentId)
			{
				return new IssueCommentConflictException(message, code, data, commentId, revision, hash);
			}

			if (StringField(d, "entryId") is { } entryId)
			{
				return new PlanEntryConflictException(message, code, data, entryId, revision, hash);
			}
		}

		if (StringField(d, "entityId") is { } revisionEntityId && StringField(d, "reason") is { } entityReason && EntityRevisionReasons.Contains(entityReason))
		{
			return new EntityRevisionException(message, code, data, revisionEntityId, entityReason, IntField(d, "headRevision"));
		}

		if (StringField(d, "contextKey") is { } contextKey)
		{
			if (StringField(d, "reason") is { } contextReason && ContextRevisionReasons.Contains(contextReason))
			{
				return new ContextRevisionException(message, code, data, contextKey, contextReason, IntField(d, "headRevision"), StringField(d, "term"));
			}

			if (IsConflict(d, out revision, out hash))
			{
				return StringField(d, "term") is { } term
					? new ContextTermConflictException(message, code, data, contextKey, term, revision, hash)
					: new ContextConflictException(message, code, data, contextKey, revision, hash);
			}
		}

		return new RpcServerException(message, code, data);
	}

	private static bool IsConflict(JsonElement data, out int revision, out string hash)
	{
		hash = StringField(data, "currentContentHash")!;
		var current = IntField(data, "currentRevision");
		revision = current ?? 0;
		return current is not null && hash is not null;
	}

	private static string? StringField(JsonElement element, string name) =>
		element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
			? value.GetString()
			: null;

	private static int? IntField(JsonElement element, string name) =>
		element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
			? number
			: null;
}
