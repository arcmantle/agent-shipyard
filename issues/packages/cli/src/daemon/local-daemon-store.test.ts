import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { openLocalDaemonStore, saveDaemonState, saveDaemonToken } from "@agent-issues/api-local";
import { spawnLocalDaemon, LOCAL_DAEMON_SPAWN_FLAG } from "./local-daemon-store.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock
}));

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

describe("local-daemon-store (ISS190, ADR44/45/46)", () => {
	let homeDirectory: string;
	let credentialStoreOptions: ReturnType<typeof fakeCredentialStore>;
	let servers: Server[];

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-store-"));
		credentialStoreOptions = fakeCredentialStore();
		servers = [];
	});

	afterEach(async () => {
		rmSync(homeDirectory, { recursive: true, force: true });
		for (const server of servers) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	type FakeDaemonHandler = (headers: Record<string, string | string[] | undefined>, body: string) => { status: number; body: unknown };

	function listenFakeDaemon(handler: FakeDaemonHandler): Promise<number> {
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				const result = handler(request.headers, body);
				response.writeHead(result.status, { "content-type": "application/json" });
				response.end(JSON.stringify(result.body));
			});
		});
		servers.push(server);
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
	}

	it("returns a store whose calls reach the already-running daemon with the token and build hash", async () => {
		await saveDaemonToken("real-token", credentialStoreOptions);
		let seenAuth: string | string[] | undefined;
		let seenBuildHash: string | string[] | undefined;
		const port = await listenFakeDaemon((headers) => {
			seenAuth = headers.authorization;
			seenBuildHash = headers["x-agent-issues-build-hash"];
			return { status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } };
		});
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });

		const store = await openLocalDaemonStore({ homeDirectory, credentialStoreOptions, buildHash: "hash-1", spawn: vi.fn() });
		await store.listEntities("initiative");

		expect(seenAuth).toBe("Bearer real-token");
		expect(seenBuildHash).toBe("hash-1");
		expect(store.tenantId).toBe(resolveWellKnownLocalTenantId());
	});

	it("sends the configured db path on every call (ISS190)", async () => {
		await saveDaemonToken("real-token", { ...credentialStoreOptions, dbPath: "/tmp/other.db" });
		let seenDbPath: string | string[] | undefined;
		const port = await listenFakeDaemon((headers) => {
			seenDbPath = headers["x-agent-issues-db-path"];
			return { status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } };
		});
		saveDaemonState({ pid: process.pid, port }, { homeDirectory, dbPath: "/tmp/other.db" });

		const store = await openLocalDaemonStore({ homeDirectory, credentialStoreOptions, dbPath: "/tmp/other.db", spawn: vi.fn() });
		await store.listEntities("initiative");

		expect(seenDbPath).toBe("/tmp/other.db");
	});

	it("retries once against a freshly-spawned daemon when the current one reports a stale build hash", async () => {
		await saveDaemonToken("real-token", credentialStoreOptions);
		const oldPort = await listenFakeDaemon(() => {
			// Simulates the stale daemon's own server-side drain-then-exit (ISS188), which begins as soon as it sees a mismatched request - not something the client triggers.
			setTimeout(() => servers[0]?.close(), 10);
			return {
				status: 409,
				body: { error: "Daemon build-hash mismatch.", code: "daemon-version-mismatch", expectedBuildHash: "hash-2", receivedBuildHash: "hash-1" }
			};
		});
		saveDaemonState({ pid: process.pid, port: oldPort }, { homeDirectory });

		const spawn = vi.fn(() => {
			void listenFakeDaemon(() => ({ status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } })).then((newPort) => {
				saveDaemonState({ pid: process.pid, port: newPort }, { homeDirectory });
			});
		});

		const store = await openLocalDaemonStore({
			homeDirectory,
			credentialStoreOptions,
			buildHash: "hash-1",
			spawn,
			pollIntervalMs: 5,
			drainPollIntervalMs: 5
		});
		const result = await store.listEntities("initiative");

		expect(result).toEqual([]);
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("throws a clear error when the daemon is reachable but no token can be read from the credential store", async () => {
		const port = await listenFakeDaemon(() => ({ status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } }));
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });

		await expect(
			openLocalDaemonStore({ homeDirectory, credentialStoreOptions, spawn: vi.fn() })
		).rejects.toThrow(/token/i);
	});

	it("times out when a reachable daemon does not answer its health request", async () => {
		await saveDaemonToken("real-token", credentialStoreOptions);
		const server = createServer(() => {});
		servers.push(server);
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });

		await expect(openLocalDaemonStore({
			homeDirectory,
			credentialStoreOptions,
			requestTimeoutMs: 20,
			spawn: vi.fn()
		})).rejects.toThrow("Local daemon request timed out after 20ms. Request: daemonHealth.");
	});

	it.each([
		{ name: "allows a slow initial health response within the daemon startup deadline", healthDelayMs: 1100, requestDelayMs: 0, requestTimeoutMs: undefined },
		{ name: "does not apply the startup timeout to requests after the health check", healthDelayMs: 0, requestDelayMs: 150, requestTimeoutMs: 100 }
	])("$name", async ({ healthDelayMs, requestDelayMs, requestTimeoutMs }) => {
		await saveDaemonToken("real-token", credentialStoreOptions);
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				const method = (JSON.parse(body) as { method: string }).method;
				const send = () => {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: method === "daemonHealth" ? { ready: true } : [] }));
				};
				if (method === "daemonHealth") {
					if (healthDelayMs > 0) {
						setTimeout(send, healthDelayMs);
					} else {
						send();
					}
				} else {
					setTimeout(send, requestDelayMs);
				}
			});
		});
		servers.push(server);
		const port = await new Promise<number>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });

		const store = await openLocalDaemonStore({
			homeDirectory,
			credentialStoreOptions,
			requestTimeoutMs,
			spawn: vi.fn()
		});

		await expect(store.listEntities("initiative")).resolves.toEqual([]);
	});

	it("refreshes the token when daemon discovery changes to a replacement port", async () => {
		await saveDaemonToken("first-token", credentialStoreOptions);
		const firstPort = await listenFakeDaemon((headers) => ({
			status: headers.authorization === "Bearer first-token" ? 200 : 401,
			body: { jsonrpc: "2.0", id: "1", result: [] }
		}));
		saveDaemonState({ pid: process.pid, port: firstPort }, { homeDirectory });
		const store = await openLocalDaemonStore({ homeDirectory, credentialStoreOptions, spawn: vi.fn() });

		await saveDaemonToken("replacement-token", credentialStoreOptions);
		const replacementPort = await listenFakeDaemon((headers) => ({
			status: headers.authorization === "Bearer replacement-token" ? 200 : 401,
			body: { jsonrpc: "2.0", id: "1", result: [] }
		}));
		saveDaemonState({ pid: process.pid + 1, port: replacementPort }, { homeDirectory });

		await expect(store.listEntities("initiative")).resolves.toEqual([]);
	});

	it("retries once against a freshly-spawned daemon when the current one reports a db-path mismatch (ISS190)", async () => {
		await saveDaemonToken("real-token", { ...credentialStoreOptions, dbPath: "/tmp/new.db" });
		const oldPort = await listenFakeDaemon(() => {
			setTimeout(() => servers[0]?.close(), 10);
			return {
				status: 409,
				body: { error: "Daemon db-path mismatch.", code: "daemon-db-mismatch", expectedDbPath: "/tmp/old.db", receivedDbPath: "/tmp/new.db" }
			};
		});
		saveDaemonState({ pid: process.pid, port: oldPort }, { homeDirectory, dbPath: "/tmp/new.db" });

		const spawn = vi.fn(() => {
			void listenFakeDaemon(() => ({ status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } })).then((newPort) => {
				saveDaemonState({ pid: process.pid, port: newPort }, { homeDirectory, dbPath: "/tmp/new.db" });
			});
		});

		const store = await openLocalDaemonStore({
			homeDirectory,
			credentialStoreOptions,
			dbPath: "/tmp/new.db",
			spawn,
			pollIntervalMs: 5,
			drainPollIntervalMs: 5
		});
		const result = await store.listEntities("initiative");

		expect(result).toEqual([]);
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("re-reads the daemon token before retrying, since a freshly-spawned daemon mints its own new one (ISS190)", async () => {
		await saveDaemonToken("stale-token", { ...credentialStoreOptions, dbPath: "/tmp/new.db" });
		const oldPort = await listenFakeDaemon(() => {
			setTimeout(() => servers[0]?.close(), 10);
			return {
				status: 409,
				body: { error: "Daemon db-path mismatch.", code: "daemon-db-mismatch", expectedDbPath: "/tmp/old.db", receivedDbPath: "/tmp/new.db" }
			};
		});
		saveDaemonState({ pid: process.pid, port: oldPort }, { homeDirectory, dbPath: "/tmp/new.db" });

		const spawn = vi.fn(() => {
			void (async () => {
				// A freshly-spawned real daemon mints and persists its own new token independently of whatever the client already read.
				await saveDaemonToken("freshly-minted-token", { ...credentialStoreOptions, dbPath: "/tmp/new.db" });
				const newPort = await listenFakeDaemon((headers) => {
					if (headers.authorization !== "Bearer freshly-minted-token") {
						return { status: 401, body: { error: "unauthorized" } };
					}
					return { status: 200, body: { jsonrpc: "2.0", id: "1", result: [] } };
				});
				saveDaemonState({ pid: process.pid, port: newPort }, { homeDirectory, dbPath: "/tmp/new.db" });
			})();
		});

		const store = await openLocalDaemonStore({
			homeDirectory,
			credentialStoreOptions,
			dbPath: "/tmp/new.db",
			spawn,
			pollIntervalMs: 5,
			drainPollIntervalMs: 5
		});
		const result = await store.listEntities("initiative");

		expect(result).toEqual([]);
	});
});

describe("spawnLocalDaemon (ISS190)", () => {
	beforeEach(() => {
		spawnMock.mockClear();
	});

	it("re-invokes this process's own entrypoint as a detached child carrying the hidden daemon flag", () => {
		const originalArgv1 = process.argv[1];
		process.argv[1] = "/path/to/entrypoint.js";

		try {
			spawnLocalDaemon();

			expect(spawnMock).toHaveBeenCalledWith(
				process.execPath,
				["/path/to/entrypoint.js", LOCAL_DAEMON_SPAWN_FLAG],
				expect.objectContaining({ detached: true })
			);
		} finally {
			process.argv[1] = originalArgv1;
		}
	});

	it("appends --db <path> to the respawned argv when a db path is supplied (ISS190)", () => {
		const originalArgv1 = process.argv[1];
		process.argv[1] = "/path/to/entrypoint.js";

		try {
			spawnLocalDaemon({ dbPath: "/tmp/other.db" });

			expect(spawnMock).toHaveBeenCalledWith(
				process.execPath,
				["/path/to/entrypoint.js", LOCAL_DAEMON_SPAWN_FLAG, "--db", "/tmp/other.db"],
				expect.objectContaining({ detached: true })
			);
		} finally {
			process.argv[1] = originalArgv1;
		}
	});

	it("hides the detached daemon window on Windows", () => {
		const originalArgv1 = process.argv[1];
		process.argv[1] = "/path/to/entrypoint.js";

		try {
			spawnLocalDaemon({ platform: "win32" });

			expect(spawnMock).toHaveBeenCalledWith(
				process.execPath,
				["/path/to/entrypoint.js", LOCAL_DAEMON_SPAWN_FLAG],
				expect.objectContaining({ detached: true, windowsHide: true })
			);
		} finally {
			process.argv[1] = originalArgv1;
		}
	});

	it("throws when no process entrypoint is available to re-invoke", () => {
		const originalArgv1 = process.argv[1];
		process.argv[1] = undefined as unknown as string;

		try {
			expect(() => spawnLocalDaemon()).toThrow(/entrypoint/i);
		} finally {
			process.argv[1] = originalArgv1;
		}
	});
});
