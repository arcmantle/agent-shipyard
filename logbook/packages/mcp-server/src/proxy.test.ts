import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { MCP_SERVER_FLAG, runAgentIssuesMcpProxy } from "./proxy.js";

describe("runAgentIssuesMcpProxy", () => {
	it("uses the permanent MCP mode contract supported by the CLI", () => {
		const cliMcpSource = readFileSync(new URL("../../cli/src/mcp-server/runner.ts", import.meta.url), "utf8");
		expect(cliMcpSource).toContain(`export const MCP_SERVER_FLAG = ${JSON.stringify(MCP_SERVER_FLAG)};`);
	});

	it("starts the installed CLI in MCP mode with inherited stdio", () => {
		const child = new EventEmitter() as ChildProcess;
		const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child);

		runAgentIssuesMcpProxy({ platform: "darwin", spawn });

		expect(spawn).toHaveBeenCalledWith("agent-issues", [MCP_SERVER_FLAG], {
			stdio: "inherit",
			shell: false,
			windowsHide: false
		});
	});

	it("starts the Windows command shim in a hidden shell", () => {
		const child = new EventEmitter() as ChildProcess;
		const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => child);

		runAgentIssuesMcpProxy({ platform: "win32", spawn });

		expect(spawn).toHaveBeenCalledWith("agent-issues", [MCP_SERVER_FLAG], {
			stdio: "inherit",
			shell: true,
			windowsHide: true
		});
	});

	it("reports a missing CLI", () => {
		const child = new EventEmitter() as ChildProcess;
		const stderr = { write: vi.fn(() => true) };
		const setExitCode = vi.fn();

		runAgentIssuesMcpProxy({ spawn: () => child, stderr, setExitCode });
		child.emit("error", new Error("ENOENT"));

		expect(stderr.write).toHaveBeenCalledWith("Cannot start agent-issues MCP server: ENOENT\n");
		expect(setExitCode).toHaveBeenCalledWith(1);
	});
});