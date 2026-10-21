import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpStore, type RunCredentialCommand } from "@agent-issues/core";
import { LocalDaemonStore, saveDaemonState, saveDaemonToken } from "@agent-issues/api-local";
import { saveSavedLogin } from "../auth/auth-session.js";
import { openSynchronizeStores } from "./open-synchronize-stores.js";

/** Fake in-memory OS credential store, mirroring `daemon-token.test.ts`'s helper, so this suite never shells out to a real native tool. */
function fakeCredentialStore(): { platform: "darwin"; runCommand: RunCredentialCommand } {
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

	return { platform: "darwin", runCommand };
}

describe("openSynchronizeStores (ISS59/ADR13, ADR18)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let projectRoot: string;
	let credentialStoreOptions: ReturnType<typeof fakeCredentialStore>;
	let servers: Server[];

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-home-"));
		// See the identical comment in open-storage-driver.test.ts: the local
		// backend's SQLite db path only respects HOME, so it must be redirected here
		// too or the "opens a local SqliteStore..." case below pollutes the
		// developer's real ~/.agent-issues/agent-issues.db.
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-open-sync-stores-project-"));
		projectDirectory = path.join(projectRoot, "default-project");
		mkdirSync(projectDirectory);
		credentialStoreOptions = fakeCredentialStore();
		servers = [];
	});

	afterEach(async () => {
		for (const server of servers) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it("opens a local daemon store and the active remote saved login as the destination", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://api.example.com",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			{ homeDirectory, ...credentialStoreOptions }
		);
		await saveDaemonToken("daemon-token", credentialStoreOptions);
		const daemon = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: [] }));
		});
		servers.push(daemon);
		const port = await new Promise<number>((resolve) => {
			daemon.listen(0, "127.0.0.1", () => {
				const address = daemon.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });

		const { local, cloud, destination } = await openSynchronizeStores({
			databaseOptions: { currentWorkingDirectory: projectDirectory },
			authSessionOptions: { homeDirectory, ...credentialStoreOptions },
			localDaemon: { homeDirectory, credentialStoreOptions, spawn: () => {} }
		});

		try {
			expect(local).toBeInstanceOf(LocalDaemonStore);
			expect(cloud).toBeInstanceOf(HttpStore);
			expect(cloud.tenantId).toBe("tenant-a");
			expect(destination).toEqual({ name: "work", serviceUrl: "https://api.example.com", tenantId: "tenant-a" });
		} finally {
			await local.close();
			await cloud.close();
		}
	});

	it("throws an actionable error when the globally active login is local", async () => {
		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions }
			})
		).rejects.toThrow(/active remote saved login.*auth switch/s);
	});

	it("directs the user to refresh the active remote saved login when it has expired", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://api.example.com",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2000-01-01T00:00:00.000Z"
			},
			{ homeDirectory, ...credentialStoreOptions }
		);

		await expect(
			openSynchronizeStores({
				databaseOptions: { currentWorkingDirectory: projectDirectory },
				authSessionOptions: { homeDirectory, ...credentialStoreOptions }
			})
		).rejects.toThrow(
			'Saved login "work" has expired. Run "agent-issues auth login --name work --url https://api.example.com" to refresh it.'
		);
	});
});
