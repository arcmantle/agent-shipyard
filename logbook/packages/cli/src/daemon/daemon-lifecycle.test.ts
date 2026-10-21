import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	callDaemonWithVersionHandshakeRetry,
	ensureDaemonRunning,
	isDaemonReachable,
	releaseDaemonSpawnLock,
	tryAcquireDaemonSpawnLock,
} from "./daemon-lifecycle.js";
import { DaemonDbPathMismatchError, DaemonVersionMismatchError } from "@agent-issues/core";
import { resolveDaemonFilePath, saveDaemonState } from "@agent-issues/api-local";

describe("daemon liveness probe (ISS189)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	it("resolves true when something is listening on the given port", async () => {
		server = createServer();
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});

		await expect(isDaemonReachable(port)).resolves.toBe(true);
	});

	it("resolves false when nothing is listening on the given port", async () => {
		// Port 1 is a reserved, extremely-unlikely-to-be-bound port for a quick, deterministic "closed" probe.
		await expect(isDaemonReachable(1)).resolves.toBe(false);
	});
});
describe("daemon spawn-race lock (ISS189)", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-lock-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("lets the first caller acquire the lock", () => {
		expect(tryAcquireDaemonSpawnLock({ homeDirectory })).toBe(true);
	});

	it("refuses a second caller while the first still holds the lock", () => {
		tryAcquireDaemonSpawnLock({ homeDirectory });

		expect(tryAcquireDaemonSpawnLock({ homeDirectory })).toBe(false);
	});

	it("lets a caller acquire the lock again once it has been released", () => {
		tryAcquireDaemonSpawnLock({ homeDirectory });
		releaseDaemonSpawnLock({ homeDirectory });

		expect(tryAcquireDaemonSpawnLock({ homeDirectory })).toBe(true);
	});

	it("does not throw when releasing a lock that was never acquired", () => {
		expect(() => releaseDaemonSpawnLock({ homeDirectory })).not.toThrow();
	});

	it("lets two callers targeting different db paths each acquire their own lock independently (ISS192)", () => {
		expect(tryAcquireDaemonSpawnLock({ homeDirectory, dbPath: "/tmp/repo-a.db" })).toBe(true);
		expect(tryAcquireDaemonSpawnLock({ homeDirectory, dbPath: "/tmp/repo-b.db" })).toBe(true);
	});

	it("refuses a second caller for the SAME db path while the first still holds that db path's lock (ISS192)", () => {
		tryAcquireDaemonSpawnLock({ homeDirectory, dbPath: "/tmp/repo-a.db" });

		expect(tryAcquireDaemonSpawnLock({ homeDirectory, dbPath: "/tmp/repo-a.db" })).toBe(false);
	});
});
describe("ensureDaemonRunning (ISS189)", () => {
	let homeDirectory: string;
	let server: Server | undefined;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-ensure-"));
	});

	afterEach(async () => {
		rmSync(homeDirectory, { recursive: true, force: true });
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	function listen(): Promise<number> {
		server = createServer();
		return new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
	}

	it("reuses an already-running daemon's port without spawning", async () => {
		const port = await listen();
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });
		const spawn = vi.fn();

		const result = await ensureDaemonRunning({ homeDirectory, spawn });

		expect(result).toEqual({ port, spawned: false });
		expect(spawn).not.toHaveBeenCalled();
	});

	it("spawns a new daemon when the recorded state file's port is unreachable", async () => {
		saveDaemonState({ pid: 999999, port: 1 }, { homeDirectory });

		const spawn = vi.fn(() => {
			void listen().then((port) => saveDaemonState({ pid: process.pid, port }, { homeDirectory }));
		});

		const result = await ensureDaemonRunning({ homeDirectory, spawn, pollIntervalMs: 5 });

		expect(spawn).toHaveBeenCalledOnce();
		expect(result.spawned).toBe(true);
		expect(result.port).toBeGreaterThan(0);
	});

	it("recovers an abandoned spawn lock when no daemon is running", async () => {
		writeFileSync(resolveDaemonFilePath("daemon", ".lock", { homeDirectory }), "999999");
		const spawn = vi.fn(() => {
			void listen().then((port) => saveDaemonState({ pid: process.pid, port }, { homeDirectory }));
		});

		const result = await ensureDaemonRunning({ homeDirectory, spawn, waitTimeoutMs: 50, pollIntervalMs: 5 });

		expect(spawn).toHaveBeenCalledOnce();
		expect(result).toEqual({ port: expect.any(Number), spawned: true });
	});

	it("recovers when the spawn lock owner exits while another caller waits", async () => {
		tryAcquireDaemonSpawnLock({ homeDirectory });
		const lockFilePath = resolveDaemonFilePath("daemon", ".lock", { homeDirectory });
		const spawn = vi.fn(() => {
			void listen().then((port) => saveDaemonState({ pid: process.pid, port }, { homeDirectory }));
		});
		setTimeout(() => writeFileSync(lockFilePath, "999999"), 10);

		const result = await ensureDaemonRunning({ homeDirectory, spawn, waitTimeoutMs: 50, pollIntervalMs: 5 });

		expect(spawn).toHaveBeenCalledOnce();
		expect(result).toEqual({ port: expect.any(Number), spawned: true });
	});

	it("waits for a concurrent caller's spawn instead of spawning its own when the lock is already held", async () => {
		tryAcquireDaemonSpawnLock({ homeDirectory });
		const spawn = vi.fn();

		const pending = ensureDaemonRunning({ homeDirectory, spawn, pollIntervalMs: 5 });

		const port = await listen();
		saveDaemonState({ pid: process.pid, port }, { homeDirectory });
		releaseDaemonSpawnLock({ homeDirectory });

		const result = await pending;
		expect(spawn).not.toHaveBeenCalled();
		expect(result).toEqual({ port, spawned: false });
	});

	it("rejects when no reachable daemon state appears before the wait timeout", async () => {
		const spawn = vi.fn();

		await expect(
			ensureDaemonRunning({ homeDirectory, spawn, waitTimeoutMs: 50, pollIntervalMs: 5 }),
		).rejects.toThrow();
	});

	it("keeps two different db paths' daemons independently reachable without draining/respawning each other (ISS192)", async () => {
		const portA = await listen();
		saveDaemonState({ pid: process.pid, port: portA }, { homeDirectory, dbPath: "/tmp/repo-a.db" });

		const secondServer = createServer();
		const portB = await new Promise<number>((resolve) => {
			secondServer.listen(0, "127.0.0.1", () => {
				const address = secondServer.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		saveDaemonState({ pid: process.pid, port: portB }, { homeDirectory, dbPath: "/tmp/repo-b.db" });

		const spawnA = vi.fn();
		const spawnB = vi.fn();

		const resultA = await ensureDaemonRunning({ homeDirectory, dbPath: "/tmp/repo-a.db", spawn: spawnA });
		const resultB = await ensureDaemonRunning({ homeDirectory, dbPath: "/tmp/repo-b.db", spawn: spawnB });

		expect(resultA).toEqual({ port: portA, spawned: false });
		expect(resultB).toEqual({ port: portB, spawned: false });
		expect(spawnA).not.toHaveBeenCalled();
		expect(spawnB).not.toHaveBeenCalled();

		await new Promise<void>((resolve) => secondServer.close(() => resolve()));
	});
});

describe("callDaemonWithVersionHandshakeRetry (ISS188, ADR45)", () => {
	let homeDirectory: string;
	let oldServer: Server | undefined;
	let newServer: Server | undefined;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-retry-"));
	});

	afterEach(async () => {
		rmSync(homeDirectory, { recursive: true, force: true });
		for (const server of [oldServer, newServer]) {
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		oldServer = newServer = undefined;
	});

	function listen(): Promise<{ server: Server; port: number }> {
		const server = createServer();
		return new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
			});
		});
	}

	it("retries once against a freshly-spawned daemon once the stale one finishes draining", async () => {
		const old = await listen();
		oldServer = old.server;
		saveDaemonState({ pid: process.pid, port: old.port }, { homeDirectory });

		const spawn = vi.fn(() => {
			void listen().then(({ server, port }) => {
				newServer = server;
				saveDaemonState({ pid: process.pid, port }, { homeDirectory });
			});
		});

		const sendRequest = vi.fn(async (port: number) => {
			if (port === old.port) {
				// Simulate the stale daemon's drain-then-exit finishing shortly after rejecting this request.
				setTimeout(() => oldServer?.close(), 20);
				throw new DaemonVersionMismatchError("new-hash", "old-hash");
			}
			return "ok";
		});

		const result = await callDaemonWithVersionHandshakeRetry(
			{ homeDirectory, spawn, pollIntervalMs: 5, drainPollIntervalMs: 5 },
			sendRequest,
		);

		expect(result).toBe("ok");
		expect(spawn).toHaveBeenCalledOnce();
		expect(sendRequest).toHaveBeenCalledTimes(2);
	});

	it("retries once against a freshly-spawned daemon on a db-path mismatch too (ISS190)", async () => {
		const old = await listen();
		oldServer = old.server;
		saveDaemonState({ pid: process.pid, port: old.port }, { homeDirectory });

		const spawn = vi.fn(() => {
			void listen().then(({ server, port }) => {
				newServer = server;
				saveDaemonState({ pid: process.pid, port }, { homeDirectory });
			});
		});

		const sendRequest = vi.fn(async (port: number) => {
			if (port === old.port) {
				setTimeout(() => oldServer?.close(), 20);
				throw new DaemonDbPathMismatchError("/tmp/new.db", "/tmp/old.db");
			}
			return "ok";
		});

		const result = await callDaemonWithVersionHandshakeRetry(
			{ homeDirectory, spawn, pollIntervalMs: 5, drainPollIntervalMs: 5 },
			sendRequest,
		);

		expect(result).toBe("ok");
		expect(spawn).toHaveBeenCalledOnce();
		expect(sendRequest).toHaveBeenCalledTimes(2);
	});

	it("propagates a non-version-mismatch error without retrying", async () => {
		const old = await listen();
		oldServer = old.server;
		saveDaemonState({ pid: process.pid, port: old.port }, { homeDirectory });
		const spawn = vi.fn();
		const sendRequest = vi.fn(async () => {
			throw new Error("some other failure");
		});

		await expect(
			callDaemonWithVersionHandshakeRetry({ homeDirectory, spawn, pollIntervalMs: 5 }, sendRequest),
		).rejects.toThrow("some other failure");
		expect(spawn).not.toHaveBeenCalled();
		expect(sendRequest).toHaveBeenCalledOnce();
	});
});
