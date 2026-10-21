import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	decodeCanonicalChainBundle,
	encodeCanonicalChainBundle,
	type CanonicalChainWireBundle,
	type RunCredentialCommand
} from "@agent-issues/core";
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
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
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

/**
 * A fake cloud gate whose JSON-RPC methods delegate straight to a real
 * `SqliteStore` standing in for "the cloud side" - proving the `synchronize`
 * command's own wiring (opens both stores, calls `synchronizeStores`,
 * reports the summary, closes both) without needing a real Postgres-backed
 * API server. `HttpStore`'s wire shape and every individual seam method are
 * already proven for real in `packages/api-pg/src/http-store-contract.test.ts`.
 */
function startFakeCloudGate(store: SqliteStore): { server: Server; url: string } {
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			void (async () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
				try {
					const result = await dispatch(store, body.method, body.params);
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { code: -32000, message }, id: body.id, jsonrpc: "2.0" }));
				}
			})();
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { server, url: `http://127.0.0.1:${port}` };
}

async function dispatch(store: SqliteStore, method: string, params: unknown): Promise<unknown> {
	const args = (params ?? {}) as Record<string, unknown>;
	switch (method) {
		case "createEntity":
			return store.createEntity(args as Parameters<SqliteStore["createEntity"]>[0]);
		case "exportCanonicalChains":
			return encodeCanonicalChainBundle(await store.exportCanonicalChains());
		case "importCanonicalChains":
			return store.importCanonicalChains(decodeCanonicalChainBundle(args.bundle as CanonicalChainWireBundle));
		case "listAllRelations":
			return store.listAllRelations();
		case "applyRelations":
			return store.applyRelations(args.relations as Parameters<SqliteStore["applyRelations"]>[0]);
		case "getEntityDetails":
			return store.getEntityDetails(args.entityId as string);
		case "getDatabaseSnapshot":
			return store.getDatabaseSnapshot();
		default:
			throw new Error(`Fake cloud gate does not implement RPC method "${method}".`);
	}
}

describe("synchronize CLI command (ISS59/ADR15, ADR16)", () => {
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
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-cli-home-"));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDirectory;
		process.env.USERPROFILE = homeDirectory;
		projectRoot = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-cli-project-"));
		projectDirectory = path.join(projectRoot, "default-project");
		mkdirSync(projectDirectory);
		cloudDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-synchronize-cli-cloud-"));
		cloudStore = (await openSqliteStore(path.join(cloudDirectory, "cloud.db"), { tenant: "tenant-a" })).store;
		credentialStoreOptions = { homeDirectory, ...fakeCredentialStore() };
		localDaemon = createLocalDaemonServer({ credentialStoreOptions, homeDirectory, idleTimeoutMs: 0, onIdleExit: () => {} });
		if (!localDaemon.server.listening) {
			await once(localDaemon.server, "listening");
		}
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

	it("is a true no-op on a repeated run once both sides are converged", async () => {
		const gate = startFakeCloudGate(cloudStore);

		try {
			await saveSavedLogin(
				{
					name: "work",
					kind: "remote",
					serviceUrl: gate.url,
					accessToken: "token-a",
					expiresAt: "2099-01-01T00:00:00.000Z",
					tenantId: "tenant-a",
					userId: "user-1"
				},
				credentialStoreOptions
			);

			// First run reconciles each side's independently-seeded sentinel
			// history (different ids, identical content) - only the second run
			// is a true no-op.
			const firstRun = createCapture();
			await runCli(["synchronize"], { credentialStoreOptions, cwd: projectDirectory, stdout: firstRun.stream });

			const stdout = createCapture();
			const stderr = createCapture();
			const exitCode = await runCli(["synchronize"], {
				credentialStoreOptions,
				cwd: projectDirectory,
				stderr: stderr.stream,
				stdout: stdout.stream
			});

			expect(stderr.read()).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout.read()).toContain("Already in sync");
		} finally {
			gate.server.close();
		}
	});

	it("propagates a brand-new cloud entity to the local store", async () => {
		const gate = startFakeCloudGate(cloudStore);

		try {
			await saveSavedLogin(
				{
					name: "work",
					kind: "remote",
					serviceUrl: gate.url,
					accessToken: "token-a",
					expiresAt: "2099-01-01T00:00:00.000Z",
					tenantId: "tenant-a",
					userId: "user-1"
				},
				credentialStoreOptions
			);

			// The active remote login routes the ordinary create command to the
			// destination; synchronize then brings that entity down to local.
			const createOut = createCapture();
			await runCli(["create", "initiative", "--title", "Ship synchronize", "--json"], {
				credentialStoreOptions,
				cwd: projectDirectory,
				stdout: createOut.stream
			});
			const created = JSON.parse(createOut.read()) as { id: string };

			const stdout = createCapture();
			const exitCode = await runCli(["synchronize"], { credentialStoreOptions, cwd: projectDirectory, stdout: stdout.stream });

			expect(exitCode).toBe(0);
			expect(stdout.read()).toContain("Synchronized with");

			const { store: localStore } = await openSqliteStore(undefined, { currentWorkingDirectory: projectDirectory });
			try {
				const localDetails = await localStore.getEntityDetails(created.id);
				expect(localDetails.entity.title).toBe("Ship synchronize");
			} finally {
				await localStore.close();
			}
		} finally {
			gate.server.close();
		}
	});

	it("surfaces an actionable error when the globally active login is local", async () => {
		await expect(runCli(["synchronize"], { credentialStoreOptions, cwd: projectDirectory })).rejects.toThrow(
			/active remote saved login.*auth switch/s
		);
	});

	it("surfaces the active remote saved login's refresh command when it is expired", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://api.example.com",
				accessToken: "token-a",
				expiresAt: "2000-01-01T00:00:00.000Z",
				tenantId: "tenant-a",
				userId: "user-1"
			},
			credentialStoreOptions
		);

		await expect(runCli(["synchronize"], { credentialStoreOptions, cwd: projectDirectory })).rejects.toThrow(
			/auth login --name work --url https:\/\/api\.example\.com/
		);
	});
});
