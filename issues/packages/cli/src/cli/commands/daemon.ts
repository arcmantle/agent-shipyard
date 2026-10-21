import { Option } from "clipanion";

import {
	clearDaemonState,
	clearDaemonToken,
	ensureDaemonRunning,
	isDaemonReachable,
	readDaemonState,
	readDaemonToken,
	resolveDatabasePath,
	type DaemonStateStoreOptions,
	type DaemonTokenStoreOptions
} from "@agent-issues/api-local";

import { spawnLocalDaemon } from "../../daemon/local-daemon-store.js";
import { TenantCommand } from "../shared.js";

const STOP_TIMEOUT_MS = 5000;
const STOP_POLL_INTERVAL_MS = 50;
const STOP_REQUEST_TIMEOUT_MS = 5000;

type DaemonAction = "stop" | "restart";

export type DaemonControlResult = {
	command: "daemon";
	action: DaemonAction;
	dbPath: string;
	stopped: boolean;
	started?: boolean;
};

export type DaemonControlOptions = DaemonStateStoreOptions & {
	credentialStoreOptions?: DaemonTokenStoreOptions;
	spawn?: () => void;
};

export class DaemonCommand extends TenantCommand {
	public static paths = [["daemon"]];

	public stop = Option.Boolean("--stop", false);
	public restart = Option.Boolean("--restart", false);

	public async execute(): Promise<number> {
		if (this.stop === this.restart) {
			throw new Error("Use exactly one of --stop or --restart.");
		}

		const action: DaemonAction = this.restart ? "restart" : "stop";
		const result = await controlDaemon(action, this.dbPath, {
			homeDirectory: this.context.credentialStoreOptions?.homeDirectory,
			credentialStoreOptions: this.context.credentialStoreOptions,
			spawn: () => spawnLocalDaemon({ dbPath: resolveDatabasePath(this.dbPath) })
		});
		this.print(result, renderDaemonControl(result));
		return 0;
	}
}

export async function controlDaemon(
	action: DaemonAction,
	dbPath: string | undefined,
	options: DaemonControlOptions = {}
): Promise<DaemonControlResult> {
	const resolvedDbPath = resolveDatabasePath(dbPath);
	const stateOptions = { homeDirectory: options.homeDirectory, dbPath: resolvedDbPath };
	const state = readDaemonState(stateOptions);
	let stopped = false;

	if (state && await isDaemonReachable(state.port)) {
		const token = await readDaemonToken({ ...options.credentialStoreOptions, dbPath: resolvedDbPath });
		if (!token) {
			throw new Error("Local daemon is running but no daemon token was found in the OS credential store.");
		}

		let response: Response;
		try {
			response = await fetch(`http://127.0.0.1:${state.port}/daemon/stop`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(STOP_REQUEST_TIMEOUT_MS)
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "TimeoutError") {
				throw new Error(`Local daemon stop request timed out after ${STOP_REQUEST_TIMEOUT_MS}ms.`, { cause: error });
			}
			throw error;
		}
		if (response.status !== 202) {
			throw new Error(`Local daemon stop request failed with HTTP ${response.status}.`);
		}
		await response.text();
		await waitForDaemonToStop(state.port);
		stopped = true;
	} else if (state) {
		clearDaemonState(stateOptions);
		await clearDaemonToken({ ...options.credentialStoreOptions, dbPath: resolvedDbPath });
	}

	if (action === "stop") {
		return { command: "daemon", action, dbPath: resolvedDbPath, stopped };
	}

	const started = await ensureDaemonRunning({
		...stateOptions,
		spawn: options.spawn ?? (() => spawnLocalDaemon({ dbPath: resolvedDbPath }))
	});
	return { command: "daemon", action, dbPath: resolvedDbPath, stopped, started: started.spawned };
}

async function waitForDaemonToStop(port: number): Promise<void> {
	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (await isDaemonReachable(port)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for the local daemon on port ${port} to stop.`);
		}
		await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
	}
}

function renderDaemonControl(result: DaemonControlResult): string {
	if (result.action === "stop") {
		return result.stopped ? `Stopped local daemon for ${result.dbPath}` : `No local daemon was running for ${result.dbPath}`;
	}

	return result.started ? `Restarted local daemon for ${result.dbPath}` : `Verified local daemon for ${result.dbPath}`;
}