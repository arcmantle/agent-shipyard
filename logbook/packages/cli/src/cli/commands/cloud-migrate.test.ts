import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rpcMethods, type RunCredentialCommand } from "@agent-issues/core";
import { createLocalDaemonServer, openSqliteStore, type LocalDaemonServerHandle, type SqliteStore } from "@agent-issues/api-local";
import { saveSavedLogin, type SavedLoginStoreOptions } from "../../auth/auth-session.js";

import { runCli } from "../../cli.js";

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
		return { stdout: "", exitCode: store.delete(key) ? 0 : 44 };
	};
	return { platform: "darwin", runCommand };
}

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

/** A cloud stand-in that dispatches through the real JSON-RPC method table to a SQLite store. */
function startFakeCloudGate(store: SqliteStore): { server: Server; url: string } {
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			void (async () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
				response.writeHead(200, { "content-type": "application/json" });
				try {
					const handler = rpcMethods[body.method];
					if (!handler) throw new Error(`Fake cloud gate does not implement RPC method "${body.method}".`);
					response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: await handler(store, body.params) }));
				} catch (error) {
					response.end(JSON.stringify({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) }, id: body.id, jsonrpc: "2.0" }));
				}
			})();
		});
	});
	server.listen(0);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fake cloud gate has no port.");
	return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("cloud migrate CLI command", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let projectDirectory: string;
	let projectRoot: string;
	let cloudDirectory: string;
	let cloudStore: SqliteStore;
	let credentialStoreOptions: SavedLoginStoreOptions;
	let localDaemon: LocalDaemonServerHandle;

	beforeEach(async () => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-migrate-home-"));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDirectory;
		process.env.USERPROFILE = homeDirectory;
		projectRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-migrate-project-"));
		projectDirectory = path.join(projectRoot, "default-project");
		mkdirSync(projectDirectory);
		cloudDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-migrate-cloud-"));
		cloudStore = (await openSqliteStore(path.join(cloudDirectory, "cloud.db"), { tenant: "tenant-a" })).store;
		credentialStoreOptions = { homeDirectory, ...fakeCredentialStore() };
		localDaemon = createLocalDaemonServer({ credentialStoreOptions, homeDirectory, idleTimeoutMs: 0, onIdleExit: () => {} });
		if (!localDaemon.server.listening) await once(localDaemon.server, "listening");
	});

	afterEach(async () => {
		await localDaemon.close();
		await cloudStore.close();
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectRoot, { force: true, recursive: true });
		rmSync(cloudDirectory, { force: true, recursive: true });
	});

	it("reports a dry run without changing the cloud, then migrates with equal counts", async () => {
		const created = createCapture();
		await runCli(["create", "initiative", "--title", "Local initiative", "--json"], { credentialStoreOptions, cwd: projectDirectory, stdout: created.stream });
		const initiative = JSON.parse(created.read()) as { id: string };
		const gate = startFakeCloudGate(cloudStore);
		try {
			await saveSavedLogin({ name: "cloud", kind: "remote", serviceUrl: gate.url, accessToken: "token-a", expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" }, credentialStoreOptions);

			const dryRun = createCapture();
			await expect(runCli(["cloud", "migrate", "--dry-run", "--json"], { credentialStoreOptions, cwd: projectDirectory, stdout: dryRun.stream })).resolves.toBe(0);
			expect(JSON.parse(dryRun.read())).toMatchObject({ command: "cloud migrate", dryRun: true, mismatched: [] });
			await expect(cloudStore.getEntityDetails(initiative.id)).rejects.toThrow(/not found/i);

			const migrated = createCapture();
			await expect(runCli(["cloud", "migrate", "--json"], { credentialStoreOptions, cwd: projectDirectory, stdout: migrated.stream })).resolves.toBe(0);
			const result = JSON.parse(migrated.read()) as { local: Record<string, number>; cloud: Record<string, number>; mismatched: string[] };
			expect(result.mismatched).toEqual([]);
			expect(result.cloud).toEqual(result.local);
			await expect(cloudStore.getEntityDetails(initiative.id)).resolves.toMatchObject({ entity: { title: "Local initiative" } });
		} finally {
			gate.server.close();
		}
	});
});
