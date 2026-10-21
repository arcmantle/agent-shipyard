import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "./build-plugin.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-claude-plugin-"));
const configRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-claude-config-"));
const pluginDir = path.join(artifactRoot, "plugin");
const isolatedEnvironment = { ...process.env, CLAUDE_CONFIG_DIR: configRoot };

try {
	buildPlugin({ sourceDir: packageRoot, targetDir: pluginDir });
	run("claude", ["plugin", "validate", pluginDir, "--strict"]);
	const marketplacePath = path.join(pluginDir, ".claude-plugin", "marketplace.json");
	const hiddenMarketplacePath = `${marketplacePath}.validation`;
	renameSync(marketplacePath, hiddenMarketplacePath);
	try {
		run("claude", ["plugin", "validate", pluginDir, "--strict"]);
	} finally {
		renameSync(hiddenMarketplacePath, marketplacePath);
	}

	const directPlugins = readJsonOutput(
		run("claude", ["--plugin-dir", pluginDir, "plugin", "list", "--json"], isolatedEnvironment)
	);
	assertPluginInventory(directPlugins, "agent-issues@inline");

	run("claude", ["plugin", "marketplace", "add", pluginDir, "--scope", "user"], isolatedEnvironment);
	run(
		"claude",
		["plugin", "install", "agent-issues@agent-issues", "--scope", "user"],
		isolatedEnvironment
	);
	const installedPlugins = readJsonOutput(
		run("claude", ["plugin", "list", "--json"], isolatedEnvironment)
	);
	const installedPlugin = assertPluginInventory(installedPlugins, "agent-issues@agent-issues");
	if (typeof installedPlugin.installPath !== "string") {
		throw new Error("Claude did not report the installed plugin cache path");
	}
	rmSync(artifactRoot, { force: true, recursive: true });

	const details = run(
		"claude",
		["--plugin-dir", installedPlugin.installPath, "plugin", "details", "agent-issues@inline"],
		isolatedEnvironment
	);
	assertIncludes(details, "Agents (1)  agent-issues", "Claude agent inventory");
	assertIncludes(details, "MCP servers (1)  agent-issues", "Claude MCP inventory");
	assertIncludes(details, "start-work", "Claude namespaced skill inventory");
	const agentContent = readFileSync(path.join(installedPlugin.installPath, "agents", "agent-issues.md"), "utf8");
	assertIncludes(agentContent, 'call the agent-issues MCP tool `instruction_retrieve`', "Claude agent instruction retrieval");
	const argumentsBlock = agentContent.match(/```json\n([\s\S]*?)\n```/)?.[1];
	if (!argumentsBlock || JSON.parse(argumentsBlock).key !== "agent/agent-issues-claude") {
		throw new Error("Claude agent instruction retrieval has incorrect arguments");
	}

	const server = installedPlugin.mcpServers?.["agent-issues"];
	if (typeof server?.command !== "string" || !Array.isArray(server.args)) {
		throw new Error("Claude MCP configuration does not define the agent-issues stdio command");
	}
	const mcpOutput = run(
		server.command,
		server.args,
		process.env,
		[
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "plugin-validation", version: "1.0.0" }
				}
			}),
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
			JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
		].join("\n") + "\n"
	);
	assertIncludes(mcpOutput, '"name":"agent-issues"', "MCP server identity");
	assertIncludes(mcpOutput, '"name":"project_identity"', "MCP tool list");
	assertIncludes(mcpOutput, '"name":"instruction_retrieve"', "MCP instruction retrieval");

	console.log("Claude plugin validation passed.");
} finally {
	rmSync(artifactRoot, { force: true, recursive: true });
	rmSync(configRoot, { force: true, recursive: true });
}

function run(command, args, environment = process.env, input) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: environment,
		input,
		timeout: 120_000
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
		);
	}
	return result.stdout;
}

function readJsonOutput(output) {
	const value = JSON.parse(output);
	if (!Array.isArray(value)) {
		throw new Error("Claude plugin list did not return an array");
	}
	return value;
}

function assertPluginInventory(plugins, pluginId) {
	const plugin = plugins.find((candidate) => candidate?.id === pluginId);
	if (!plugin) {
		throw new Error(`Claude did not load ${pluginId}`);
	}
	const server = plugin.mcpServers?.["agent-issues"];
	if (server?.command !== "agent-issues-mcp" || !Array.isArray(server.args) || server.args.length !== 0) {
		throw new Error(`${pluginId} does not expose the global Agent Issues MCP server`);
	}
	return plugin;
}

function assertIncludes(value, expected, label) {
	if (!value.includes(expected)) {
		throw new Error(`${label} is missing ${expected}`);
	}
}