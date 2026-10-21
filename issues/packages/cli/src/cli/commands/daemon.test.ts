import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RunCredentialCommand } from "@agent-issues/core";
import { createLocalDaemonServer, readDaemonState, type LocalDaemonServerHandle } from "@agent-issues/api-local";

import { controlDaemon } from "./daemon.js";

describe("controlDaemon", () => {
	let tempDirectory: string;
	let homeDirectory: string;
	let dbPath: string;
	let handle: LocalDaemonServerHandle | undefined;
	let credentialStoreOptions: { platform: "darwin"; runCommand: RunCredentialCommand };

	beforeEach(() => {
		tempDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-command-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-command-home-"));
		dbPath = path.join(tempDirectory, "issues.db");
		credentialStoreOptions = { platform: "darwin", ...fakeCredentialStore() };
	});

	afterEach(async () => {
		await handle?.close();
		rmSync(tempDirectory, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("stops the selected database daemon", async () => {
		handle = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions });
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const result = await controlDaemon("stop", dbPath, { homeDirectory, credentialStoreOptions });

		expect(result).toMatchObject({ action: "stop", dbPath, stopped: true });
		expect(readDaemonState({ homeDirectory, dbPath })).toBeUndefined();
		handle = undefined;
	});

	it("restarts the selected database daemon", async () => {
		handle = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions });
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));
		const spawn = vi.fn(() => {
			handle = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions });
		});

		const result = await controlDaemon("restart", dbPath, { homeDirectory, credentialStoreOptions, spawn });

		expect(result).toMatchObject({ action: "restart", dbPath, stopped: true, started: true });
		expect(spawn).toHaveBeenCalledOnce();
		expect(readDaemonState({ homeDirectory, dbPath })).toEqual({ pid: process.pid, port: expect.any(Number) });
	});
});

function fakeCredentialStore(): { runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();
	const runCommand: RunCredentialCommand = async (command) => {
		const [action, , account, , service] = command.args;
		const key = `${service}:${account}`;
		if (action === "add-generic-password") {
			store.set(key, command.args[6]);
			return { stdout: "", exitCode: 0 };
		}
		if (action === "find-generic-password") {
			const value = store.get(key);
			return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
		}
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
	};
	return { runCommand };
}