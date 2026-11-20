using System.Text.Json;
using AgentLogbook.Api.Auth;
using AgentLogbook.Core.Rpc;
using AgentLogbook.Core.Workspaces;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace AgentLogbook.Api.Rpc;

/// <summary>
/// <c>POST /rpc</c>: one JSON-RPC 2.0 call per request. The wire follows the TypeScript host: a request without a login is
/// HTTP 401, a body that is not a JSON-RPC request is HTTP 400, and every other answer is HTTP 200 with <c>result</c> or
/// <c>error</c>. The tenant comes from the login, never from the body.
/// </summary>
internal static partial class RpcEndpoint
{
	public const int MaxBodyBytes = 50 * 1024 * 1024;

	private const string MalformedRequest = "Malformed JSON-RPC request: expected { jsonrpc: \"2.0\", method, id }.";

	public static async Task<IResult> HandleAsync(
		HttpContext context,
		IAuthProvider authProvider,
		NpgsqlDataSource dataSource,
		RpcMethodRegistry registry,
		ILogger logger)
	{
		var identity = await authProvider.AuthenticateAsync(context);
		if (identity is null)
		{
			return Results.Json(new { error = "Invalid or expired bearer token." }, statusCode: StatusCodes.Status401Unauthorized);
		}

		JsonDocument document;
		try
		{
			document = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
		}
		catch (JsonException)
		{
			return Malformed();
		}

		using (document)
		{
			var root = document.RootElement;
			if (root.ValueKind != JsonValueKind.Object
				|| !root.TryGetProperty("jsonrpc", out var version) || version.ValueKind != JsonValueKind.String || version.GetString() != RpcWire.Version
				|| !root.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
			{
				return Malformed();
			}

			JsonElement? id = root.TryGetProperty("id", out var idElement) ? idElement.Clone() : null;
			var method = methodElement.GetString()!;
			if (!registry.TryGet(method, out var handler))
			{
				return Error(id, RpcWire.MethodNotFoundCode, $"Method not found: {method}");
			}

			var call = new RpcCall(
				identity,
				context.Request.Headers[RpcWire.ProjectIdentityHeader].FirstOrDefault(),
				root.TryGetProperty("params", out var parameters) ? parameters.Clone() : null,
				dataSource,
				context.RequestAborted);
			try
			{
				return Result(id, await handler(call));
			}
			catch (WorkspaceException exception)
			{
				return Error(id, RpcWire.ServerErrorCode, exception.Message);
			}
			catch (Exception exception) when (exception is not OperationCanceledException)
			{
				// The message of a database or program failure can name hosts and tables. The caller gets a fixed text.
				LogMethodFailed(logger, exception, method);
				return Error(id, RpcWire.ServerErrorCode, "Internal error.");
			}
		}
	}

	[LoggerMessage(Level = LogLevel.Error, Message = "RPC method {Method} failed.")]
	private static partial void LogMethodFailed(ILogger logger, Exception exception, string method);

	private static IResult Malformed() => Results.Json(new { error = MalformedRequest }, statusCode: StatusCodes.Status400BadRequest);

	private static IResult Result(JsonElement? id, object? result) =>
		Json(Envelope(id, ("result", result)));

	private static IResult Error(JsonElement? id, int code, string message) =>
		Json(Envelope(id, ("error", new { code, message })));

	private static Dictionary<string, object?> Envelope(JsonElement? id, (string Name, object? Value) body)
	{
		var envelope = new Dictionary<string, object?> { ["jsonrpc"] = RpcWire.Version };
		if (id is not null)
		{
			envelope["id"] = id;
		}

		envelope[body.Name] = body.Value;
		return envelope;
	}

	private static IResult Json(Dictionary<string, object?> envelope) =>
		Results.Text(JsonSerializer.Serialize(envelope, RpcWire.JsonOptions), "application/json; charset=utf-8");
}
