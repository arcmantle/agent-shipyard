import { spawn } from "node:child_process";

import { Option } from "clipanion";

import { KANBAN_HEALTH_PATH, startKanbanServer, stopKanbanServer, type KanbanServerInfo } from "../../kanban/server.js";
import { BaseCommand, parsePortOption } from "../shared.js";

const DEFAULT_KANBAN_PORT = 4174;
const STARTUP_TIMEOUT_MS = 3000;

export class KanbanCommand extends BaseCommand {
	public static paths = [["kanban"]];

	public portValue = Option.String("--port");
	public serve = Option.Boolean("--serve", false);
	public stop = Option.Boolean("--stop", false);

	public async execute(): Promise<number> {
		const port = parsePortOption(this.portValue) ?? DEFAULT_KANBAN_PORT;
		if (this.stop) {
			if (this.serve) {
				throw new Error("--serve and --stop cannot be used together.");
			}

			const result = await stopKanbanServer({ port });
			this.print(result, renderStopKanban(result));
			return 0;
		}

		if (this.serve) {
			const handle = await startKanbanServer({ port });
			await new Promise<void>((resolve, reject) => {
				handle.server.once("close", resolve);
				handle.server.once("error", reject);
			});
			return 0;
		}

		const info = await startBackgroundKanbanServer(port);
		openUrl(info.url);
		this.print(info, `Opened Kanban at ${info.url}`);
		return 0;
	}
}

async function startBackgroundKanbanServer(port: number): Promise<KanbanServerInfo> {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Could not determine the agent-issues CLI entrypoint.");
	}

	spawn(process.execPath, [entrypoint, "kanban", "--serve", "--port", String(port)], {
		detached: true,
		stdio: "ignore"
	}).unref();

	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}${KANBAN_HEALTH_PATH}`);
			if (response.status === 200) {
				return { host: "127.0.0.1", port, url };
			}
		} catch {
			// The detached server has not bound its port yet.
		}

		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
	}

	throw new Error(`Kanban server did not start at ${url}.`);
}

function openUrl(url: string) {
	if (process.platform === "darwin") {
		spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		return;
	}

	if (process.platform === "win32") {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		return;
	}

	spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function renderStopKanban(result: Awaited<ReturnType<typeof stopKanbanServer>>): string {
	if (result.stopped) {
		return `Stopped Kanban at ${result.url}`;
	}

	if (!result.reachable) {
		return `No Kanban server was running at ${result.url}`;
	}

	return `A server is listening at ${result.url}, but it does not expose the Kanban stop endpoint.`;
}