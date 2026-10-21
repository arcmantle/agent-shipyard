import type { LocalDaemonStoreOptions } from "@agent-issues/api-local";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalMcpServer } from "./index.js";

export async function runMcpStdioServer(options: LocalDaemonStoreOptions): Promise<void> {
	const server = createLocalMcpServer(options);
	await server.connect(new StdioServerTransport());
}