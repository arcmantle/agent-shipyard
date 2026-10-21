import { resolveDatabasePath } from "@agent-issues/api-local";

import { spawnLocalDaemon } from "../daemon/local-daemon-store.js";
import { runMcpStdioServer } from "./stdio.js";

export const MCP_SERVER_FLAG = "--mcp";
export const PROJECT_IDENTITY_FLAG = "--project-identity";

export function parseMcpProjectIdentity(args: string[]): string | undefined {
	if (args.length === 0) {
		return undefined;
	}

	if (args.length !== 2 || args[0] !== PROJECT_IDENTITY_FLAG || !args[1]) {
		throw new Error(`Usage: ${MCP_SERVER_FLAG} [${PROJECT_IDENTITY_FLAG} <projectIdentity>]`);
	}

	return args[1];
}

export async function runMcpServer(args: string[] = []): Promise<void> {
	const dbPath = resolveDatabasePath();
	const workspaceRoot = process.cwd();
	const projectIdentity = parseMcpProjectIdentity(args);
	await runMcpStdioServer({ dbPath, spawn: () => spawnLocalDaemon({ dbPath }), projectIdentity, workspaceRoot });
}