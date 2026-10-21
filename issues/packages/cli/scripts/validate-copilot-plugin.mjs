import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPlugin } from "./build-plugin.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-copilot-plugin-"));
const directConfigRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-copilot-direct-"));
const marketplaceConfigRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-copilot-marketplace-"));
const directCacheRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-copilot-direct-cache-"));
const marketplaceCacheRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-copilot-marketplace-cache-"));
const pluginDir = path.join(artifactRoot, "plugin");
const directEnvironment = isolatedEnvironment(directConfigRoot, directCacheRoot);
const marketplaceEnvironment = isolatedEnvironment(marketplaceConfigRoot, marketplaceCacheRoot);

try {
	buildPlugin({ sourceDir: packageRoot, targetDir: pluginDir });

	const directInstall = run("copilot", ["plugin", "install", pluginDir], directEnvironment);
	assertIncludes(directInstall, 'Plugin "agent-issues" installed successfully.', "Copilot direct install");
	const directList = run("copilot", ["plugin", "list"], directEnvironment);
	assertIncludes(directList, "agent-issues (v", "Copilot direct plugin inventory");
	validateComponents(path.join(directConfigRoot, "installed-plugins", "_direct", "plugin"), directEnvironment);

	run("copilot", ["plugin", "marketplace", "add", pluginDir], marketplaceEnvironment);
	const marketplaceBrowse = run(
		"copilot",
		["plugin", "marketplace", "browse", "agent-issues"],
		marketplaceEnvironment
	);
	assertIncludes(marketplaceBrowse, "agent-issues", "Copilot marketplace inventory");
	const marketplaceInstall = run(
		"copilot",
		["plugin", "install", "agent-issues@agent-issues"],
		marketplaceEnvironment
	);
	assertIncludes(marketplaceInstall, "Installed 16 skills.", "Copilot marketplace install");
	const updatedVersion = incrementPatchVersion(
		readJsonFile(path.join(pluginDir, "plugin.json")).version
	);
	setPluginVersion(pluginDir, updatedVersion);
	run(
		"copilot",
		["plugin", "marketplace", "update", "agent-issues"],
		marketplaceEnvironment
	);
	run("copilot", ["plugin", "update", "agent-issues"], marketplaceEnvironment);
	const updatedList = run("copilot", ["plugin", "list"], marketplaceEnvironment);
	assertIncludes(updatedList, `(v${updatedVersion})`, "Copilot updated plugin inventory");
	const installedPluginDir = updatedList.includes(`from ${pluginDir}`)
		? pluginDir
		: path.join(marketplaceConfigRoot, "installed-plugins", "agent-issues", "agent-issues");
	if (installedPluginDir !== pluginDir) rmSync(artifactRoot, { force: true, recursive: true });
	const mcpServer = validateComponents(installedPluginDir, marketplaceEnvironment);

	const mcpOutput = run(
		mcpServer.command,
		mcpServer.args,
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

	console.log("Copilot plugin validation passed.");
} finally {
	for (const directory of [
		artifactRoot,
		directConfigRoot,
		marketplaceConfigRoot,
		directCacheRoot,
		marketplaceCacheRoot
	]) {
		rmSync(directory, { force: true, recursive: true });
	}
}

function validateComponents(installedPluginDir, environment) {
	const agentPath = path.join(
		installedPluginDir,
		"agents",
		"copilot",
		"agent-issues.agent.md"
	);
	if (!existsSync(agentPath)) {
		throw new Error(`Copilot agent not found in installed plugin: ${agentPath}`);
	}
	const agentContent = readFileSync(agentPath, "utf8");
	assertIncludes(agentContent, 'call the agent-issues MCP tool `instruction_retrieve`', "Copilot agent");
	const argumentsBlock = agentContent.match(/```json\n([\s\S]*?)\n```/)?.[1];
	if (!argumentsBlock || JSON.parse(argumentsBlock).key !== "agent/agent-issues") {
		throw new Error("Copilot agent instruction retrieval has incorrect arguments");
	}

	const skills = readJsonOutput(run("copilot", ["skill", "list", "--json"], environment));
	if (!Array.isArray(skills)) {
		throw new Error("Copilot skill list did not return an array");
	}
	const startWorkSkill = skills.find((skill) => skill?.name === "start-work");
	if (startWorkSkill?.source !== "plugin") {
		throw new Error("Copilot did not expose the start-work plugin skill");
	}

	const mcpConfiguration = readJsonOutput(
		run("copilot", ["mcp", "get", "agent-issues", "--json"], environment)
	);
	const mcpServer = mcpConfiguration?.["agent-issues"];
	if (
		mcpServer?.source !== "plugin" ||
		mcpServer.command !== "agent-issues-mcp" ||
		!Array.isArray(mcpServer.args) ||
		mcpServer.args.length !== 0
	) {
		throw new Error("Copilot did not expose the global Agent Issues MCP server");
	}
	return mcpServer;
}

function isolatedEnvironment(configRoot, cacheRoot) {
	return {
		...process.env,
		CI: "true",
		COPILOT_AUTO_UPDATE: "false",
		COPILOT_CACHE_HOME: cacheRoot,
		COPILOT_HOME: configRoot,
		NO_COLOR: "1"
	};
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
	return `${result.stdout}${result.stderr}`;
}

function readJsonOutput(output) {
	return JSON.parse(output);
}

function readJsonFile(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function setPluginVersion(pluginRoot, version) {
	for (const relativePath of [
		"plugin.json",
		path.join(".plugin", "plugin.json"),
		path.join(".claude-plugin", "plugin.json")
	]) {
		const filePath = path.join(pluginRoot, relativePath);
		const manifest = readJsonFile(filePath);
		manifest.version = version;
		writeFileSync(filePath, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	for (const relativePath of [
		path.join(".github", "plugin", "marketplace.json"),
		path.join(".claude-plugin", "marketplace.json")
	]) {
		const filePath = path.join(pluginRoot, relativePath);
		const marketplace = readJsonFile(filePath);
		marketplace.plugins[0].version = version;
		writeFileSync(filePath, `${JSON.stringify(marketplace, null, "\t")}\n`);
	}
}

function incrementPatchVersion(version) {
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`Plugin validation requires a stable semantic version: ${version}`);
	}
	const parts = version.split(".").map(Number);
	return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function assertIncludes(value, expected, label) {
	if (!value.includes(expected)) {
		throw new Error(`${label} is missing ${expected}`);
	}
}