using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace AgentLogbook.Mcp;

/// <summary>The MCP server of agent-logbook. It reads and writes the protocol on a transport and sends its tools to the connected host.</summary>
public static class AgentLogbookMcp
{
	public const string ServerName = "agent-logbook";

	/// <summary>Runs the server on the standard input and output until the host closes the input or <paramref name="cancellationToken"/> is cancelled.</summary>
	public static Task RunStdioAsync(AgentLogbookMcpOptions options, CancellationToken cancellationToken) =>
		RunAsync(options, new StdioServerTransport(ServerName), cancellationToken);

	public static async Task RunAsync(AgentLogbookMcpOptions options, ITransport transport, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(options);
		ArgumentNullException.ThrowIfNull(transport);

		var tools = new AgentLogbookTools(options);
		await using var server = McpServer.Create(transport, new McpServerOptions
		{
			ServerInfo = new Implementation { Name = ServerName, Version = options.ToolVersion },
			ToolCollection =
			[
				McpServerTool.Create(
					tools.ProjectIdentityAsync,
					new McpServerToolCreateOptions
					{
						Name = "project_identity",
						Description = "Get the resolved project identity for this MCP server.",
					}),
				McpServerTool.Create(
					tools.ResourceShowAsync,
					new McpServerToolCreateOptions
					{
						Name = "resource_show",
						Description = "Read resource metadata without authored bodies. Set request.resource to entity with reference. Bodies use resource_body. Follow returned read references.",
						ReadOnly = true,
					}),
			],
		});
		await server.RunAsync(cancellationToken);
	}
}
