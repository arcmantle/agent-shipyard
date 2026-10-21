import * as vscode from "vscode";

const PROVIDER_ID = "agent-wayfinder.mcp-server";
const SERVER_LABEL = "Agent Wayfinder";

class AgentWayfinderMcpServerProvider implements vscode.McpServerDefinitionProvider {
	public provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
		const configuration = vscode.workspace.getConfiguration("agentWayfinder.mcp");
		const command = configuration.get<string>("command", "agent-wayfinder");
		const args = configuration.get<string[]>("args", ["mcp"]);
		const server = new vscode.McpStdioServerDefinition(SERVER_LABEL, command, args);
		server.cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
		return [server];
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, new AgentWayfinderMcpServerProvider()));
}