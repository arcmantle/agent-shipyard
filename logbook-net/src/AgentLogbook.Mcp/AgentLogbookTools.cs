using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using AgentLogbook.Client;
using AgentLogbook.Core.ProjectIdentity;
using AgentLogbook.Core.Rpc;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace AgentLogbook.Mcp;

/// <summary>The tools of this release. Each one is registered in <see cref="AgentLogbookMcp"/>; there is no stub for a tool that is not ported.</summary>
internal sealed class AgentLogbookTools(AgentLogbookMcpOptions options)
{
	/// <summary>The most bytes of one tool result, as in the TypeScript server.</summary>
	private const int ResponseBudgetBytes = 65536;

	private static readonly JsonSerializerOptions Json = new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		DefaultIgnoreCondition = JsonIgnoreCondition.Never,
		Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
	};

	public async Task<CallToolResult> ProjectIdentityAsync(McpServer server, CancellationToken cancellationToken)
	{
		var scope = await ResolveScopeAsync(server, cancellationToken);
		return Result(new ProjectIdentityResult(scope.ProjectIdentity, scope.WorkspaceRoot));
	}

	public async Task<CallToolResult> ResourceShowAsync(McpServer server, ResourceShowRequest request, CancellationToken cancellationToken)
	{
		if (request.Resource != "entity")
		{
			return Failure($"Unsupported resource: {request.Resource}. This release reads the entity resource only.", string.Empty, string.Empty);
		}

		try
		{
			var scope = await ResolveScopeAsync(server, cancellationToken);
			using var store = await WorkspaceStore.OpenAsync(scope.WorkspaceRoot, options.GetEnvironmentVariable, scope.ProjectIdentity, cancellationToken);
			var details = await store.GetEntityDetailsAsync(request.Reference, cancellationToken);
			var entity = details.Entity;
			var reference = entity.Reference;
			var reads = new EntityReads(
				new ToolRead("resource_body", new { request = new { resource = "entity", entityId = reference } }),
				new ToolRead("relation_query", new { entityId = reference }),
				new CommandRead("agent-logbook", ["show", reference, "--json"]));
			var result = Result(new EntityShown(entity.ToSummary(), reads));
			if (Size(result) <= ResponseBudgetBytes)
			{
				return result;
			}

			var oversized = Result(new { error = "Entity metadata exceeds the 65536-byte response budget. No metadata was returned. Use the complete CLI detail read.", reference, reads });
			oversized.IsError = true;
			return oversized;
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			return Failure(exception.Message, "Resource metadata read failed.", "Resource metadata read failed. Error details exceed the response budget. No metadata was returned. Check the resource identifiers or use the complete CLI detail read.");
		}
	}

	private async Task<Scope> ResolveScopeAsync(McpServer server, CancellationToken cancellationToken)
	{
		var workspaceRoot = await ClientWorkspaceRootAsync(server, cancellationToken) ?? options.WorkspaceRoot;
		var identity = options.ProjectIdentity
			?? ProjectIdentityResolver.Resolve(workspaceRoot, options.GetEnvironmentVariable).Identity;
		return new Scope(identity, workspaceRoot);
	}

	// MCP clients still send workspace roots; the TypeScript server reads them, so parity needs them. The SDK marks roots as deprecated.
#pragma warning disable MCP9005
	/// <summary>The first file root of the client. A client without the roots capability, and a failed roots request, give the fallback.</summary>
	private static async Task<string?> ClientWorkspaceRootAsync(McpServer server, CancellationToken cancellationToken)
	{
		if (server.ClientCapabilities?.Roots is null)
		{
			return null;
		}

		try
		{
			var roots = await server.RequestRootsAsync(new ListRootsRequestParams(), cancellationToken);
			return WorkspaceRoots.Select(roots.Roots.Select(root => root.Uri));
		}
		catch (Exception exception) when (exception is McpException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
		{
			return null;
		}
	}
#pragma warning restore MCP9005

	private static CallToolResult Result(object value)
	{
		var node = JsonSerializer.SerializeToNode(value, Json) ?? throw new InvalidOperationException("A tool result cannot be null.");
		return new CallToolResult
		{
			Content = [new TextContentBlock { Text = node.ToJsonString(Json) }],
			StructuredContent = JsonSerializer.SerializeToElement(node, Json),
		};
	}

	/// <summary>An error result. The text of the message is bounded: when it is larger than the budget, the fixed text replaces it.</summary>
	private static CallToolResult Failure(string message, string fallback, string oversized)
	{
		var text = string.IsNullOrEmpty(message) ? fallback : message;
		var result = new CallToolResult { IsError = true, Content = [new TextContentBlock { Text = text }] };
		if (Size(result) > ResponseBudgetBytes)
		{
			result.Content = [new TextContentBlock { Text = oversized }];
		}

		return result;
	}

	private static int Size(CallToolResult result) => System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(result, McpJsonUtilities.DefaultOptions));

	private sealed record Scope(string ProjectIdentity, string WorkspaceRoot);

	private sealed record ProjectIdentityResult(string ProjectIdentity, string WorkspaceRoot);

	private sealed record EntityShown(EntitySummary Entity, EntityReads Reads);

	private sealed record EntityReads(ToolRead Body, ToolRead Relations, CommandRead Details);

	private sealed record ToolRead(string Tool, object Arguments);

	private sealed record CommandRead(string Command, string[] Arguments);
}

/// <summary>The input of <c>resource_show</c>: the entity resource. The other resources of the TypeScript tool are not ported yet.</summary>
public sealed record ResourceShowRequest
{
	[System.ComponentModel.Description("The resource kind. Only entity is available.")]
	[System.ComponentModel.DataAnnotations.AllowedValues("entity")]
	public required string Resource { get; init; }

	[System.ComponentModel.Description("The ID, reference, or short reference of the entity.")]
	public required string Reference { get; init; }
}
