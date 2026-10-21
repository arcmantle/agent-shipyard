import { Cli } from "clipanion";

import packageJson from "../../package.json" with { type: "json" };

import { registerCommandFamily } from "./command-loader.js";
import { stringifyJson, type AgentIssuesContext } from "./shared.js";

export type { AgentIssuesContext } from "./shared.js";

function buildCli(): Cli<AgentIssuesContext> {
	const cli = new Cli<AgentIssuesContext>({
		binaryLabel: "agent-issues",
		binaryName: "agent-issues",
		binaryVersion: packageJson.version
	});

	return cli;
}

export async function runCli(argv: string[], context: Partial<AgentIssuesContext> = {}): Promise<number> {
	if (isVersionRequest(argv)) {
		(context.stdout ?? process.stdout).write(`${packageJson.version}\n`);
		return 0;
	}

	const normalizedArgv = normalizeArgv(argv);
	const cli = buildCli();
	await registerCommandFamily(cli, normalizedArgv);
	const command = cli.process(normalizedArgv, { cwd: process.cwd(), ...context });
	return await command.validateAndExecute();
}

export async function main(argv = process.argv.slice(2), context: Partial<AgentIssuesContext> = {}): Promise<number> {
	if (isVersionRequest(argv)) {
		process.stdout.write(`${packageJson.version}\n`);
		return 0;
	}

	const normalizedArgv = normalizeArgv(argv);
	const cli = buildCli();

	try {
		await registerCommandFamily(cli, normalizedArgv);
		const command = cli.process(normalizedArgv, { cwd: process.cwd(), ...context });
		return await command.validateAndExecute();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (argv.includes("--json")) {
			process.stderr.write(`${stringifyJson({ error: message }, argv.includes("--pretty"))}\n`);
		} else if (error instanceof Error) {
			process.stderr.write(cli.error(error));
		} else {
			process.stderr.write(`${message}\n`);
		}

		return 1;
	}
}

function normalizeArgv(argv: string[]): string[] {
	if (argv.length === 0) {
		return ["help"];
	}

	if (argv[0] === "--help" || argv[0] === "-h") {
		return ["help", ...argv.slice(1).filter((arg) => arg !== "--help" && arg !== "-h")];
	}

	if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
		const filtered = argv.filter((arg, index) => index === 0 || (arg !== "--help" && arg !== "-h"));
		return ["help", filtered[0], ...filtered.slice(1)];
	}

	return argv;
}

function isVersionRequest(argv: string[]): boolean {
	return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v");
}
