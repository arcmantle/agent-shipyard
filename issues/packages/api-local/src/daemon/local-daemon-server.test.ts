import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	DaemonDbPathMismatchError,
	DaemonVersionMismatchError,
	HttpStore,
	LocalAuthProvider,
	type RunCredentialCommand
} from "@agent-issues/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBuildContentHash } from "./build-info.js";
import { readDaemonState, saveDaemonState } from "./daemon-state.js";
import { readDaemonToken, saveDaemonToken } from "../auth/daemon-token.js";
import { createLocalDaemonServer, type LocalDaemonServerHandle } from "./local-daemon-server.js";
import { openSqliteStore } from "../sqlite-store.js";

const LOCAL_AUTH_SECRET = "test-only-secret-never-used-in-production";

/**
 * The daemon tracer bullet (ISS186): proves an `HttpStore` client can reach
 * a locally-spawned daemon fronting `SqliteStore` through the exact same
 * JSON-RPC gate the cloud API uses, mirroring `http-store-contract.test.ts`'s
 * real-server-over-the-wire shape but backed by SQLite instead of Postgres.
 * No auth/version handshake/lifecycle here by design (those are ISS184,
 * ISS188, ISS189) - `LocalAuthProvider` stands in as a placeholder seam.
 */
describe("local daemon JSON-RPC tracer bullet (ISS186)", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;
	let handle: LocalDaemonServerHandle;

	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
		handle = createLocalDaemonServer({ authProvider, dbPath: path.join(tempDir, "test.db"), port: 0 });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
	});

	afterEach(async () => {
		await handle.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists an entity created via HttpStore through the daemon's SqliteStore", async () => {
		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });

		const client = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: readBuildContentHash(), dbPath: path.join(tempDir, "test.db") });
		const created = await client.createEntity({ kind: "initiative", title: "Ship the daemon" });
		expect(created).toMatchObject({ kind: "initiative", title: "Ship the daemon" });

		const listed = await client.listEntities("initiative");
		expect(listed.map((entity) => entity.title)).toContain("Ship the daemon");
	});

	it("retrieves the requested release through RPC and rejects missing content without fallback", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const seeded = await openSqliteStore(dbPath);
		for (const version of ["1.0.0", "2.0.0"]) {
			await seeded.store.importInstructionBundle({ version, items: [{ key: "skill/prepare", kind: "skill", body: `# Prepare ${version}\n` }] });
		}
		await seeded.store.close();
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const address = handle.server.address() as AddressInfo;
		const client = new HttpStore({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken, tenantId: "daemon-tenant", buildHash: readBuildContentHash(), dbPath });
		for (const version of ["1.0.0", "2.0.0"]) {
			expect(await client.retrieveInstruction({ version, key: "skill/prepare" })).toMatchObject({
				body: `# Prepare ${version}\n`, version, source: { revision: 1, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
			});
		}
		await expect(client.retrieveInstruction({ version: "3.0.0", key: "skill/prepare" })).rejects.toThrow("defaults unavailable");
		await expect(client.retrieveInstruction({ version: "1.0.0", key: "skill/missing" })).rejects.toThrow("Instruction not found");
	});

	it("imports the host release bundle before retrieval without exposing client installation", async () => {
		await handle.close();
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider, dbPath, port: 0,
			instructionBundle: { version: "4.0.0", items: [{ key: "agent/agent-issues", kind: "agent", body: "# Official agent\n" }] }
		});
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const client = new HttpStore({ baseUrl, bearerToken, tenantId: "daemon-tenant", buildHash: readBuildContentHash(), dbPath });
		expect(await client.retrieveInstruction({ version: "4.0.0", key: "agent/agent-issues" })).toMatchObject({ body: "# Official agent\n" });
		const response = await fetch(`${baseUrl}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}`, "x-agent-issues-build-hash": readBuildContentHash(), "x-agent-issues-db-path": dbPath },
			body: JSON.stringify({ jsonrpc: "2.0", id: "install", method: "importInstructionBundle", params: {} })
		});
		expect(await response.json()).toMatchObject({ error: { code: -32601 } });
	});

	it("keeps tracker commands available when immutable instruction defaults conflict", async () => {
		await handle.close();
		const dbPath = path.join(tempDir, "test.db");
		const original = { version: "4.0.0", items: [{ key: "skill/prepare", kind: "skill" as const, body: "Original defaults" }] };
		const seeded = await openSqliteStore(dbPath);
		await seeded.store.importInstructionBundle(original);
		await seeded.store.close();
		handle = createLocalDaemonServer({ authProvider, dbPath, port: 0, instructionBundle: {
			...original, items: [{ ...original.items[0], body: "Changed defaults" }]
		} });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const address = handle.server.address() as AddressInfo;
		const client = new HttpStore({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken, tenantId: "daemon-tenant", buildHash: readBuildContentHash(), dbPath });
		const issue = await client.createEntity({ kind: "issue", title: "Tracker is available" });
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(client.retrieveInstruction({ version: original.version, key: "skill/prepare" })).rejects.toThrow("Instruction bundle is immutable");
		}
		expect(await client.updateEntityStatus({ entityId: issue.id, status: "done" })).toMatchObject({ entity: { status: "done" } });
		expect(await client.getEntityDetails(issue.id)).toMatchObject({ entity: { title: "Tracker is available" } });
		const check = await openSqliteStore(dbPath);
		try {
			expect(await check.store.retrieveInstruction({ version: original.version, key: "skill/prepare" })).toMatchObject({ body: "Original defaults" });
		} finally {
			await check.store.close();
		}
	});

	it("returns only an error when instruction storage is unavailable", async () => {
		await handle.close();
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({ authProvider, dbPath, port: 0, openStore: async () => { throw new Error("Instruction storage unavailable."); } });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const address = handle.server.address() as AddressInfo;
		const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}`, "x-agent-issues-build-hash": readBuildContentHash(), "x-agent-issues-db-path": dbPath },
			body: JSON.stringify({ jsonrpc: "2.0", id: "retrieve", method: "retrieveInstruction", params: { version: "1.0.0", key: "skill/prepare" } })
		});
		const result = await response.json();
		expect(JSON.stringify(result)).toContain("Instruction storage unavailable");
		expect(result).not.toHaveProperty("result");
	});

	it("routes project identities to distinct projects in one shared database", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "daemon-tenant";
		const seeded = await openSqliteStore(dbPath, { tenant: tenantId });
		const projectA = await seeded.store.createEntity({ kind: "project", title: "Project A" });
		const projectB = await seeded.store.createEntity({ kind: "project", title: "Project B" });
		await seeded.store.createEntity({ kind: "epic", title: "Project A epic", parentId: projectA.id });
		await seeded.store.createEntity({ kind: "epic", title: "Project B epic", parentId: projectB.id });
		await seeded.store.close();

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const clientA = new HttpStore({ baseUrl, bearerToken, tenantId, projectIdentity: projectA.id, buildHash: readBuildContentHash(), dbPath });
		const clientB = new HttpStore({ baseUrl, bearerToken, tenantId, projectIdentity: projectB.id, buildHash: readBuildContentHash(), dbPath });

		await clientA.createEntity({ kind: "initiative", title: "Initiative A" });
		await clientB.createEntity({ kind: "initiative", title: "Initiative B" });

		expect((await clientA.listEntities("initiative")).map((entity) => entity.title)).toEqual(["Initiative A"]);
		expect((await clientB.listEntities("initiative")).map((entity) => entity.title)).toEqual(["Initiative B"]);
	});

	it("registers an unseen repository-style project identity on first request", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "daemon-tenant";
		const seeded = await openSqliteStore(dbPath, { tenant: tenantId });
		await seeded.store.createEntity({ kind: "project", title: "Existing Project" });
		await seeded.store.close();

		const address = handle.server.address() as AddressInfo;
		const options = { baseUrl: `http://127.0.0.1:${address.port}`, tenantId, buildHash: readBuildContentHash(), dbPath };
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const client = new HttpStore({ ...options, bearerToken, projectIdentity: "brand-new-repo" });

		// The fresh-workspace case: before ISS auto-registration this request
		// failed to open a store at all, which the gate surfaced as an opaque
		// HTTP 500 rather than anything the caller could act on.
		expect(await client.listEntities("initiative")).toEqual([]);
		await client.createEntity({ kind: "initiative", title: "First initiative" });

		expect((await client.listEntities("project")).map((entity) => entity.title)).toEqual(["brand-new-repo"]);
		expect((await client.listEntities("initiative")).map((entity) => entity.title)).toEqual(["First initiative"]);

		// A second workspace registers its own project rather than joining the first.
		const otherClient = new HttpStore({ ...options, bearerToken, projectIdentity: "other-repo" });
		expect(await otherClient.listEntities("initiative")).toEqual([]);
		expect((await otherClient.listEntities("project")).map((entity) => entity.title)).toEqual(["other-repo"]);
	});

	it("rejects an unresolvable stable-id project identity instead of registering it", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "daemon-tenant";
		const address = handle.server.address() as AddressInfo;
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const client = new HttpStore({
			baseUrl: `http://127.0.0.1:${address.port}`,
			bearerToken,
			tenantId,
			projectIdentity: "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
			buildHash: readBuildContentHash(),
			dbPath
		});

		await expect(client.listEntities("initiative")).rejects.toThrow(/Cannot resolve project identity/);
	});

	it("retries store initialization after a transient failure", async () => {
		await handle.close();
		let attempts = 0;
		handle = createLocalDaemonServer({
			authProvider,
			dbPath: path.join(tempDir, "test.db"),
			port: 0,
			openStore: async (...args) => {
				attempts++;
				if (attempts === 1) throw new Error("transient initialization failure");
				return openSqliteStore(...args);
			}
		});
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const dbPath = path.join(tempDir, "test.db");
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const client = new HttpStore({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken, tenantId: "daemon-tenant", buildHash: readBuildContentHash(), dbPath });

		await expect(client.listEntities("initiative")).rejects.toThrow(/transient initialization failure/);
		await expect(client.listEntities("initiative")).resolves.toEqual([]);
		expect(attempts).toBe(2);
	});
});

describe("local daemon state file lifecycle (ISS189)", () => {
	let tempDir: string;
	let homeDirectory: string;
	let authProvider: LocalAuthProvider;
	let handle: LocalDaemonServerHandle | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-home-"));
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("writes a daemon state file with its pid and bound port once listening", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		expect(readDaemonState({ homeDirectory, dbPath })).toEqual({ pid: process.pid, port: address.port });
	});

	it("removes the daemon state file once closed", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		await handle.close();
		handle = undefined;

		expect(readDaemonState({ homeDirectory, dbPath })).toBeUndefined();
	});

	it("stops through its authenticated control endpoint and clears its state", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId: "daemon-tenant" });
		const closed = new Promise<void>((resolve) => handle?.server.once("close", resolve));
		const response = await fetch(`http://127.0.0.1:${address.port}/daemon/stop`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bearerToken}` }
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ stopping: true });
		await closed;
		handle = undefined;
		expect(readDaemonState({ homeDirectory, dbPath })).toBeUndefined();
	});

	it("writes independently discoverable state for two daemons fronting different db paths under the same home directory (ISS192)", async () => {
		const dbPathA = path.join(tempDir, "repo-a.db");
		const dbPathB = path.join(tempDir, "repo-b.db");
		const authProviderB = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });

		handle = createLocalDaemonServer({ authProvider, dbPath: dbPathA, port: 0, homeDirectory });
		const handleB = createLocalDaemonServer({ authProvider: authProviderB, dbPath: dbPathB, port: 0, homeDirectory });
		await Promise.all([
			new Promise<void>((resolve) => handle?.server.once("listening", resolve)),
			new Promise<void>((resolve) => handleB.server.once("listening", resolve))
		]);

		try {
			const addressA = handle.server.address() as AddressInfo;
			const addressB = handleB.server.address() as AddressInfo;

			expect(readDaemonState({ homeDirectory, dbPath: dbPathA })).toEqual({ pid: process.pid, port: addressA.port });
			expect(readDaemonState({ homeDirectory, dbPath: dbPathB })).toEqual({ pid: process.pid, port: addressB.port });
		} finally {
			await handleB.close();
		}
	});
});

describe("local daemon idle timeout (ISS189)", () => {
	let tempDir: string;
	let homeDirectory: string;
	let authProvider: LocalAuthProvider;
	let handle: LocalDaemonServerHandle | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-home-"));
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("self-terminates after the configured idle timeout elapses with no requests", async () => {
		const onIdleExit = vi.fn();
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory,
			idleTimeoutMs: 50,
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(onIdleExit).toHaveBeenCalledOnce();
		expect(readDaemonState({ homeDirectory, dbPath })).toBeUndefined();
	});

	it("resets the idle timer on every request instead of terminating mid-activity", async () => {
		const onIdleExit = vi.fn();
		handle = createLocalDaemonServer({
			authProvider,
			dbPath: path.join(tempDir, "test.db"),
			port: 0,
			homeDirectory,
			idleTimeoutMs: 500,
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const client = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: readBuildContentHash(), dbPath: path.join(tempDir, "test.db") });

		// Keep the daemon "busy" well past the idle timeout by issuing requests more often than it elapses.
		for (let i = 0; i < 6; i++) {
			await client.listEntities("initiative");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		expect(onIdleExit).not.toHaveBeenCalled();
	});
});

/** Fake in-memory OS credential store, mirroring `daemon-token.test.ts`'s helper, so this suite never shells out to a real native tool. */
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

describe("local daemon default auth via its own minted token (ISS184)", () => {
	let tempDir: string;
	let homeDirectory: string;
	let credentialStoreOptions: { platform: "darwin"; runCommand: RunCredentialCommand };
	let handle: LocalDaemonServerHandle | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-home-"));
		credentialStoreOptions = { platform: "darwin", ...fakeCredentialStore() };
	});

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("mints and stores its own token when no authProvider is supplied, accepting requests that carry it", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			dbPath,
			port: 0,
			homeDirectory,
			credentialStoreOptions
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const token = await readDaemonToken({ ...credentialStoreOptions, dbPath });
		expect(token).toBeTruthy();

		const address = handle.server.address() as AddressInfo;
		const client = new HttpStore({
			baseUrl: `http://127.0.0.1:${address.port}`,
			bearerToken: token!,
			tenantId: "irrelevant",
			buildHash: readBuildContentHash(),
			dbPath
		});

		const created = await client.createEntity({ kind: "initiative", title: "Reach the default-auth daemon" });
		expect(created).toMatchObject({ kind: "initiative", title: "Reach the default-auth daemon" });
	});

	it("rejects a request carrying the wrong token", async () => {
		handle = createLocalDaemonServer({
			dbPath: path.join(tempDir, "test.db"),
			port: 0,
			homeDirectory,
			credentialStoreOptions
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const client = new HttpStore({
			baseUrl: `http://127.0.0.1:${address.port}`,
			bearerToken: "not-the-real-token",
			tenantId: "irrelevant",
			buildHash: readBuildContentHash(),
			dbPath: path.join(tempDir, "test.db")
		});

		await expect(client.listEntities("initiative")).rejects.toThrow();
	});

	it("clears its token once closed", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			dbPath,
			port: 0,
			homeDirectory,
			credentialStoreOptions
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		await handle.close();
		handle = undefined;

		await expect(readDaemonToken({ ...credentialStoreOptions, dbPath })).resolves.toBeUndefined();
	});

	it("does not clear a replacement daemon's state or token when an older daemon closes", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			dbPath,
			port: 0,
			homeDirectory,
			credentialStoreOptions
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));
		saveDaemonState({ pid: process.pid + 1, port: 54321 }, { homeDirectory, dbPath });
		await saveDaemonToken("replacement-token", { ...credentialStoreOptions, dbPath });

		await handle.close();
		handle = undefined;

		expect(readDaemonState({ homeDirectory, dbPath })).toEqual({ pid: process.pid + 1, port: 54321 });
		await expect(readDaemonToken({ ...credentialStoreOptions, dbPath })).resolves.toBe("replacement-token");
	});
});

describe("local daemon build-hash version handshake (ISS188, ADR45)", () => {
	let tempDir: string;
	let homeDirectory: string;
	let authProvider: LocalAuthProvider;
	let handle: LocalDaemonServerHandle | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-home-"));
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("rejects a request carrying a stale build hash with a DaemonVersionMismatchError", async () => {
		const onIdleExit = vi.fn();
		handle = createLocalDaemonServer({
			authProvider,
			dbPath: path.join(tempDir, "test.db"),
			port: 0,
			homeDirectory,
			idleTimeoutMs: 0,
			buildHash: "server-hash-v2",
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });

		const staleClient = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: "client-hash-v1" });
		await expect(staleClient.listEntities("initiative")).rejects.toThrow(DaemonVersionMismatchError);
	});

	it("drains and self-terminates once a version-mismatched request has been seen and no requests remain in flight", async () => {
		const onIdleExit = vi.fn();
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory,
			idleTimeoutMs: 0, // never fires from idleness alone - isolates this test to the drain path
			buildHash: "server-hash-v2",
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const staleClient = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: "client-hash-v1" });

		await expect(staleClient.listEntities("initiative")).rejects.toThrow(DaemonVersionMismatchError);

		await vi.waitFor(() => expect(onIdleExit).toHaveBeenCalledOnce());
		expect(readDaemonState({ homeDirectory, dbPath })).toBeUndefined();
	});

	it("lets a concurrent, correctly-versioned request finish before draining completes", async () => {
		const onIdleExit = vi.fn();
		handle = createLocalDaemonServer({
			authProvider,
			dbPath: path.join(tempDir, "test.db"),
			port: 0,
			homeDirectory,
			idleTimeoutMs: 0,
			buildHash: "server-hash-v2",
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });
		const staleClient = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: "client-hash-v1" });
		const freshClient = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: "server-hash-v2", dbPath: path.join(tempDir, "test.db") });

		const [, created] = await Promise.all([
			staleClient.listEntities("initiative").catch(() => undefined),
			freshClient.createEntity({ kind: "initiative", title: "In flight during drain" })
		]);
		expect(created).toMatchObject({ title: "In flight during drain" });

		await vi.waitFor(() => expect(onIdleExit).toHaveBeenCalledOnce());
	});
});

/**
 * ISS190's daemon-restart-on-different-db mechanism: mirrors the build-hash
 * handshake above, but keyed on the daemon's own resolved db path instead of
 * a build-content-hash. A client requesting a different `--db` is exactly as
 * incompatible as one running a stale build, and drives the same
 * drain-then-exit-and-respawn flow.
 */
describe("local daemon db-path handshake (ISS190)", () => {
	let tempDir: string;
	let homeDirectory: string;
	let authProvider: LocalAuthProvider;
	let handle: LocalDaemonServerHandle | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-local-daemon-"));
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-home-"));
		authProvider = new LocalAuthProvider({ secret: LOCAL_AUTH_SECRET });
	});

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("rejects a request whose db-path header does not match its own resolved db path with a DaemonDbPathMismatchError", async () => {
		const onIdleExit = vi.fn();
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({
			authProvider,
			dbPath,
			port: 0,
			homeDirectory,
			idleTimeoutMs: 0,
			buildHash: readBuildContentHash(),
			onIdleExit
		});
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });

		const mismatchedClient = new HttpStore({
			baseUrl,
			bearerToken,
			tenantId,
			buildHash: readBuildContentHash(),
			dbPath: path.join(tempDir, "other.db")
		});
		await expect(mismatchedClient.listEntities("initiative")).rejects.toThrow(DaemonDbPathMismatchError);
	});

	it("dispatches normally when the db-path header matches its own resolved db path", async () => {
		const dbPath = path.join(tempDir, "test.db");
		handle = createLocalDaemonServer({ authProvider, dbPath, port: 0, homeDirectory, idleTimeoutMs: 0, buildHash: readBuildContentHash() });
		await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

		const address = handle.server.address() as AddressInfo;
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const tenantId = "daemon-tenant";
		const bearerToken = await authProvider.issueToken({ userId: "user-1", tenantId });

		const matchingClient = new HttpStore({ baseUrl, bearerToken, tenantId, buildHash: readBuildContentHash(), dbPath });
		await expect(matchingClient.listEntities("initiative")).resolves.toEqual([]);
	});
});
