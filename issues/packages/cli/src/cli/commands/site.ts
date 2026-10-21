import { spawn, type SpawnOptions } from "node:child_process";

import { Option } from "clipanion";

import { startLiveSite, stopLiveSite } from "../../site/index.js";

import { renderLiveSite, renderStartedLiveSite, renderStopLiveSite } from "../renderers.js";
import { parsePortOption, TenantCommand } from "../shared.js";

export class SiteCommand extends TenantCommand {
	public static paths = [["site"]];

	public portValue = Option.String("--port");
	public foreground = Option.Boolean("--foreground", false);
	public stop = Option.Boolean("--stop", false);

	public async execute(): Promise<number> {
		if (this.foreground) {
			return await this.serve();
		}

		const port = parsePortOption(this.portValue) ?? 4173;
		if (this.stop) {
			const result = await stopLiveSite({ port });
			this.print(result, renderStopLiveSite(result));
			return 0;
		}

		const result = await launchDetachedLiveSite({ cwd: this.context.cwd, dbPath: this.dbPath, port });
		this.print(result, renderStartedLiveSite(result));
		return 0;
	}

	protected async serve(): Promise<number> {
		const result = await startLiveSite({
			currentWorkingDirectory: this.context.cwd,
			dbPath: this.dbPath,
			port: parsePortOption(this.portValue)
		});

		await new Promise<void>((resolve, reject) => {
			if (result.server.listening) {
				resolve();
				return;
			}

			result.server.once("listening", resolve);
			result.server.once("error", reject);
		});

		this.print(result.info, renderLiveSite(result.info));

		await new Promise<void>((resolve, reject) => {
			result.server.once("close", resolve);
			result.server.once("error", reject);
		});

		return 0;
	}
}

type DetachedLiveSiteChild = {
	exitCode?: number | null;
	kill?(): boolean;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
	removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
	unref(): void;
};
type DetachedLiveSiteSpawner = (command: string, args: string[], options: SpawnOptions) => DetachedLiveSiteChild;
type LiveSiteReadinessProbe = (url: string) => Promise<void>;

export async function launchDetachedLiveSite(
	input: { cwd: string; dbPath?: string; entryPoint?: string; port: number },
	spawnProcess: DetachedLiveSiteSpawner = spawn,
	readinessProbe: LiveSiteReadinessProbe = waitForLiveSiteReadiness
): Promise<{ host: string; port: number; started: boolean; url: string }> {
	const entryPoint = input.entryPoint ?? process.argv[1];
	if (!entryPoint) {
		throw new Error("Could not determine the agent-issues CLI entry point.");
	}

	const args = [entryPoint, "site", "--foreground", "--port", String(input.port)];
	if (input.dbPath) {
		args.push("--db", input.dbPath);
	}

	const child = spawnProcess(process.execPath, args, {
		cwd: input.cwd,
		detached: true,
		env: process.env,
		stdio: "ignore"
	});
	await waitForSpawn(child);
	if (child.exitCode !== undefined && child.exitCode !== null) {
		throw new Error(`Live site process exited before it became reachable with code ${child.exitCode}.`);
	}
	const url = `http://127.0.0.1:${input.port}`;
	try {
		await waitForDetachedSiteReadiness(child, url, readinessProbe);
	} catch (error) {
		child.kill?.();
		throw error;
	}
	child.on("error", (error) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Live site process error: ${message}\n`);
	});
	child.unref();

	return {
		host: "127.0.0.1",
		port: input.port,
		started: true,
		url
	};
}

async function waitForDetachedSiteReadiness(child: DetachedLiveSiteChild, url: string, readinessProbe: LiveSiteReadinessProbe) {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
		};
		const onError = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: unknown) => {
			cleanup();
			reject(new Error(`Live site process exited before it became reachable${typeof code === "number" ? ` with code ${code}` : ""}.`));
		};

		child.once("error", onError);
		child.once("exit", onExit);
		void readinessProbe(url).then(() => {
			cleanup();
			resolve();
		}, (error) => {
			cleanup();
			reject(error);
		});
	});
}

async function waitForLiveSiteReadiness(url: string) {
	const deadline = Date.now() + 5000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return;
			}
			lastError = new Error(`Live site readiness returned ${response.status}.`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	throw new Error(`Live site did not become reachable at ${url}.`, { cause: lastError });
}

async function waitForSpawn(child: DetachedLiveSiteChild) {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: unknown) => {
			child.removeListener("spawn", onSpawn);
			reject(error);
		};
		const onSpawn = () => {
			child.removeListener("error", onError);
			resolve();
		};

		child.once("error", onError);
		child.once("spawn", onSpawn);
	});
}
