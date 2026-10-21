import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";

import { DaemonHandshakeMismatchError } from "@agent-issues/core";
import { readDaemonState, resolveDaemonFilePath, type DaemonState, type DaemonStateStoreOptions } from "./daemon-state.js";

export function isDaemonReachable(port: number, options?: { host?: string; timeoutMs?: number }): Promise<boolean> {
	const host = options?.host ?? "127.0.0.1";
	const timeoutMs = options?.timeoutMs ?? 500;

	return new Promise((resolve) => {
		const socket = new Socket();
		const finish = (reachable: boolean) => {
			socket.destroy();
			resolve(reachable);
		};

		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, host);
	});
}

function resolveDaemonSpawnLockFilePath(options?: DaemonStateStoreOptions): string {
	return resolveDaemonFilePath("daemon", ".lock", options);
}

export function tryAcquireDaemonSpawnLock(options?: DaemonStateStoreOptions): boolean {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	try {
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

function reclaimAbandonedDaemonSpawnLock(options?: DaemonStateStoreOptions): boolean {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	try {
		const ownerPid = Number.parseInt(readFileSync(filePath, "utf8"), 10);
		if (Number.isInteger(ownerPid) && ownerPid > 0) {
			try {
				process.kill(ownerPid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
			}
		} else if (Date.now() - statSync(filePath).mtimeMs < 1000) {
			return false;
		}

		unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

export function releaseDaemonSpawnLock(options?: DaemonStateStoreOptions): void {
	const filePath = resolveDaemonSpawnLockFilePath(options);
	if (existsSync(filePath)) unlinkSync(filePath);
}

export type EnsureDaemonRunningOptions = DaemonStateStoreOptions & {
	spawn: () => void;
	waitTimeoutMs?: number;
	pollIntervalMs?: number;
};

export type EnsureDaemonRunningResult = {
	port: number;
	spawned: boolean;
};

async function waitForReachableDaemonState(
	options: Pick<EnsureDaemonRunningOptions, "homeDirectory" | "waitTimeoutMs" | "pollIntervalMs">,
): Promise<DaemonState> {
	const waitTimeoutMs = options.waitTimeoutMs ?? 5000;
	const pollIntervalMs = options.pollIntervalMs ?? 50;
	const deadline = Date.now() + waitTimeoutMs;

	for (;;) {
		const state = readDaemonState(options);
		if (state && (await isDaemonReachable(state.port))) return state;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for a reachable local daemon after ${waitTimeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions): Promise<EnsureDaemonRunningResult> {
	const existing = readDaemonState(options);
	if (existing && (await isDaemonReachable(existing.port))) return { port: existing.port, spawned: false };

	let ownsSpawnLock = tryAcquireDaemonSpawnLock(options);
	if (!ownsSpawnLock && reclaimAbandonedDaemonSpawnLock(options)) ownsSpawnLock = tryAcquireDaemonSpawnLock(options);

	if (!ownsSpawnLock) {
		try {
			const state = await waitForReachableDaemonState(options);
			return { port: state.port, spawned: false };
		} catch (error) {
			if (!reclaimAbandonedDaemonSpawnLock(options) || !tryAcquireDaemonSpawnLock(options)) throw error;
			ownsSpawnLock = true;
		}
	}

	try {
		options.spawn();
		const state = await waitForReachableDaemonState(options);
		return { port: state.port, spawned: true };
	} finally {
		releaseDaemonSpawnLock(options);
	}
}

export type CallDaemonWithVersionHandshakeRetryOptions = EnsureDaemonRunningOptions & {
	drainPollIntervalMs?: number;
	drainTimeoutMs?: number;
};

async function waitForDaemonToDrain(
	port: number,
	options: Pick<CallDaemonWithVersionHandshakeRetryOptions, "drainPollIntervalMs" | "drainTimeoutMs">,
): Promise<void> {
	const pollIntervalMs = options.drainPollIntervalMs ?? 50;
	const timeoutMs = options.drainTimeoutMs ?? 5000;
	const deadline = Date.now() + timeoutMs;

	while (await isDaemonReachable(port)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for the stale local daemon on port ${port} to finish draining after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

export async function callDaemonWithVersionHandshakeRetry<T>(
	options: CallDaemonWithVersionHandshakeRetryOptions,
	sendRequest: (port: number) => Promise<T>,
): Promise<T> {
	const first = await ensureDaemonRunning(options);
	try {
		return await sendRequest(first.port);
	} catch (error) {
		if (!(error instanceof DaemonHandshakeMismatchError)) throw error;
		await waitForDaemonToDrain(first.port, options);
		const retried = await ensureDaemonRunning(options);
		return sendRequest(retried.port);
	}
}