import { spawn } from "node:child_process";

import { Option } from "clipanion";
import ora from "ora";

import { renderAgentInit } from "../renderers.js";
import { BaseCommand, type AgentInitRunner } from "../shared.js";

const MARKETPLACE = "arcmantle/agent-issues-plugin";
const MARKETPLACE_NAME = "agent-issues";
const PLUGIN = "agent-issues@agent-issues";

export const AGENT_HOSTS = ["claude", "copilot"] as const;

type AgentHost = typeof AGENT_HOSTS[number];

export class AgentInitCommand extends BaseCommand {
	public static paths = [["agent", "init"]];

	public host = Option.String("--host", "copilot");

	public async execute(): Promise<number> {
		const host = parseAgentHost(this.host);
		const runner = this.context.agentInitDependencies?.run ?? runAgentInitCommand;
		const errorOutput = this.context.stderr ?? process.stderr;
		const hasActiveProgress = this.context.agentInitProgressActive === true;
		const shouldShowSpinner = !hasActiveProgress && !this.asJson && isInteractiveTerminal(errorOutput);
		const spinner = ora({
			isEnabled: shouldShowSpinner,
			isSilent: !shouldShowSpinner,
			stream: errorOutput,
			text: `Installing the Agent Issues plugin for ${host}...`
		}).start();

		try {
			const marketplaceOutput = await runner(host, ["plugin", "marketplace", "list", "--json"], { quiet: true });
			const commands = getAgentInitCommands(host);

			if (isMarketplaceRegistered(marketplaceOutput)) {
				commands.shift();
			}

			for (const args of commands) {
				await runner(host, args, { quiet: this.asJson || hasActiveProgress || shouldShowSpinner });
			}
		} finally {
			spinner.stop();
		}

		const result = {
			command: "agent-init" as const,
			host,
			marketplace: MARKETPLACE,
			plugin: PLUGIN
		};
		this.print(result, renderAgentInit(result));
		return 0;
	}
}

export function getAgentInitCommands(host: AgentHost): string[][] {
	const commands = [
		["plugin", "marketplace", "add", MARKETPLACE],
		["plugin", "install", PLUGIN]
	];

	if (host === "claude") {
		commands[1].push("--scope", "user");
	}

	return commands;
}

function parseAgentHost(value: string): AgentHost {
	if (isAgentHost(value)) {
		return value;
	}

	throw new Error(`Unsupported plugin host: ${value}. Use copilot or claude.`);
}

function isAgentHost(value: string): value is AgentHost {
	return AGENT_HOSTS.some((host) => host === value);
}

function isMarketplaceRegistered(value: string): boolean {
	let marketplaces: unknown;

	try {
		marketplaces = JSON.parse(value);
	} catch {
		throw new Error("Could not parse plugin marketplace list output.");
	}

	return Array.isArray(marketplaces) && marketplaces.some((marketplace) => (
		isMarketplace(marketplace) && marketplace.name === MARKETPLACE_NAME
	));
}

function isMarketplace(value: unknown): value is { name: unknown } {
	return typeof value === "object" && value !== null && "name" in value;
}

function isInteractiveTerminal(stream: object): boolean {
	return "isTTY" in stream && stream.isTTY === true;
}

const runAgentInitCommand: AgentInitRunner = async (command, args, options) => {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: options.quiet ? ["inherit", "pipe", "pipe"] : "inherit"
		});
		let errorOutput = "";

		let standardOutput = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			standardOutput += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errorOutput += chunk.toString();
		});
		child.once("error", (error) => {
			reject(new Error(`Could not run ${command}: ${error.message}`));
		});
		child.once("close", (exitCode) => {
			if (exitCode === 0) {
				resolve(standardOutput);
				return;
			}

			const detail = errorOutput.trim();
			reject(new Error(`${command} ${args.join(" ")} exited with code ${exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`));
		});
	});
};