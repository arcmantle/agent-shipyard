#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCAL_DAEMON_SPAWN_FLAG } from "./daemon/local-daemon-store.js";
import ora from "ora";

export type { AgentIssuesContext } from "./cli/shared.js";

export async function runCli(...args: Parameters<typeof import("./cli/index.js").runCli>) {
	const { runCli: runCliCommand } = await import("./cli/index.js");
	return runCliCommand(...args);
}

const MCP_SERVER_FLAG = "--mcp";

export function isEntrypointInvocation(moduleUrl: string, argvPath: string | undefined): boolean {
	if (!argvPath) {
		return false;
	}

	return resolveInvocationPath(fileURLToPath(moduleUrl)) === resolveInvocationPath(argvPath);
}

function resolveInvocationPath(filePath: string): string {
	try {
		return realpathSync.native(filePath);
	} catch {
		return filePath;
	}
}

/**
 * A self-respawned local daemon process (ISS190) re-invokes this same entrypoint with a
 * hidden flag as its first argument, instead of a normal command. Recognizing it here lets
 * `spawnLocalDaemon()` in `@agent-issues/core` re-exec whichever script is currently running
 * without needing any knowledge of the CLI's command-dispatch internals.
 */
export function shouldRunLocalDaemon(args: string[]): boolean {
	return args[0] === LOCAL_DAEMON_SPAWN_FLAG;
}

export function shouldRunMcpServer(args: string[]): boolean {
	return args[0] === MCP_SERVER_FLAG;
}

if (isEntrypointInvocation(import.meta.url, process.argv[1])) {
	if (shouldRunLocalDaemon(process.argv.slice(2))) {
		void import("./daemon/daemon-main.js").then(({ runDaemonProcess }) => {
			runDaemonProcess();
		}).catch((error: unknown) => {
			reportStartupError("Cannot start local daemon", error);
		});
	}
	else if (shouldRunMcpServer(process.argv.slice(2))) {
		void import("./mcp-server/runner.js").then(({ runMcpServer }) => runMcpServer(process.argv.slice(3))).catch((error: unknown) => {
			reportStartupError("Cannot start MCP server", error);
		});
	} else {
		void startCli().catch((error: unknown) => {
			reportStartupError("Cannot start CLI", error);
		});
	}
}

async function startCli(): Promise<void> {
	const args = process.argv.slice(2);
	const spinner = startAgentInitSpinner(args);

	try {
		const { main } = await import("./cli/index.js");
		process.exitCode = await main(args, { agentInitProgressActive: spinner !== undefined });
	} finally {
		spinner?.stop();
	}
}

function startAgentInitSpinner(args: string[]) {
	if (args[0] !== "agent" || args[1] !== "init" || args.includes("--json") || process.stderr.isTTY !== true) {
		return undefined;
	}

	return ora({ stream: process.stderr, text: "Installing the Agent Issues plugin..." }).start();
}

function reportStartupError(prefix: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${prefix}: ${message}\n`);
	process.exitCode = 1;
}