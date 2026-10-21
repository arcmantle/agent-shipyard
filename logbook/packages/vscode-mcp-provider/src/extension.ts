import * as vscode from "vscode";

const PROVIDER_ID = "agent-issues.mcp-server";
const SERVER_LABEL = "Agent Issues";
const PROJECT_IDENTITY_ENVIRONMENT_VARIABLE = "AGENT_ISSUES_PROJECT_IDENTITY";

class AgentIssuesMcpServerProvider implements vscode.McpServerDefinitionProvider {
	public provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
		const configuration = vscode.workspace.getConfiguration("agentIssues.mcp");
		const projectIdentity = vscode.workspace.getConfiguration("agentIssues").get<string>("projectIdentity")?.trim();
		const command = configuration.get<string>("command", "agent-issues-mcp");
		const args = configuration.get<string[]>("args", []);
		const environment = projectIdentity ? { [PROJECT_IDENTITY_ENVIRONMENT_VARIABLE]: projectIdentity } : undefined;
		const server = new vscode.McpStdioServerDefinition(SERVER_LABEL, command, args, environment);
		server.cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
		return [server];
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, new AgentIssuesMcpServerProvider()));
}