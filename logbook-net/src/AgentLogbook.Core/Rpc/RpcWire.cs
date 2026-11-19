using System.Text.Encodings.Web;
using System.Text.Json;

namespace AgentLogbook.Core.Rpc;

/// <summary>The constants and JSON settings of the JSON-RPC 2.0 wire contract of <c>POST /rpc</c>.</summary>
public static class RpcWire
{
	public const string Path = "/rpc";
	public const string Version = "2.0";

	/// <summary>The method does not exist.</summary>
	public const int MethodNotFoundCode = -32601;

	/// <summary>Every other failure of a method.</summary>
	public const int ServerErrorCode = -32000;

	/// <summary>The request header that carries the resolved project identity.</summary>
	public const string ProjectIdentityHeader = "x-agent-logbook-project-identity";

	/// <summary>The request header that carries the workspace root.</summary>
	public const string WorkspaceRootHeader = "x-agent-logbook-workspace-root";

	/// <summary>The request header that correlates a write with the browser cache update that started it.</summary>
	public const string CorrelationIdHeader = "x-agent-logbook-correlation-id";

	/// <summary>
	/// Settings for the typed parameters and results: camelCase names, and a null stays a JSON <c>null</c>
	/// (the TypeScript wire contract has fields such as <c>category: null</c>).
	/// </summary>
	public static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web)
	{
		DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
		Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
	};
}
