import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createJsonRpcApp, DEFAULT_PROJECT_ID, deriveMigratedEntityIdentity, LocalAuthProvider, type StorageDriver } from "@agent-issues/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { openSqliteStore, SqliteStore } from "../sqlite-store.js";

/**
 * Proves the gate is generic over any `StorageDriver`, not hardcoded to
 * `PgStore` (ADR44's daemon work needs the exact same gate to front a
 * `SqliteStore` instead). `createStore` is called per authenticated
 * request with the resolved identity - `api`'s own
 * `create-json-rpc-app.test.ts` covers the Postgres-backed `PgStore` case
 * the exact same way, proving both concrete `StorageDriver`s work behind
 * the identical gate without either package depending on the other.
 */
describe("JSON-RPC gate is generic over StorageDriver", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-sqlite-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("dispatches createEntity through a SqliteStore-backed createStore factory", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const openedStores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				openedStores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the daemon" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ kind: "initiative", title: "Ship the daemon" });

		for (const store of openedStores) {
			await store.close();
		}
	});

	it("answers authenticated daemon health checks without opening a store", async () => {
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const createStore = vi.fn<() => Promise<StorageDriver>>();
		const app = createJsonRpcApp({ authProvider, createStore });

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "daemonHealth" });

		expect(response.status).toBe(200);
		expect(response.body.result).toEqual({ ready: true });
		expect(createStore).not.toHaveBeenCalled();
	});

	it("dispatches typed available search responses through SqliteStore", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const stores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const capabilityResponse = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "getSearchCapability" });
		const searchResponse = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 2, method: "search", params: { query: "project", scope: { type: "all-projects" } } });

		expect(capabilityResponse.body.result).toEqual({ state: "available" });
		expect(searchResponse.body.result).toEqual({ state: "available", results: [] });

		for (const store of stores) {
			await store.close();
		}
	});

	it("forwards current-project scope and source-type filters through SqliteStore", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const stores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const created = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Current project search result" } });
		const searchResponse = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({
				jsonrpc: "2.0",
				id: 2,
				method: "search",
				params: {
					query: created.body.result.reference,
					scope: { type: "current-project", projectId: deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId },
					filters: { sourceTypes: ["entity"] }
				}
			});

		expect(searchResponse.body.result).toEqual(expect.objectContaining({
			state: "available",
			results: [expect.objectContaining({
				identity: expect.objectContaining({ sourceId: created.body.result.id, sourceType: "entity" }),
				navigationTarget: { type: "entity", entityId: created.body.result.id }
			})]
		}));

		for (const store of stores) {
			await store.close();
		}
	});

	it("returns a typed parse error through SqliteStore", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const stores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "search", params: { query: "search OR", scope: { type: "all-projects" } } });

		expect(response.body.result).toEqual({
			state: "parse-error",
			error: { message: "Expected a search term.", start: 9, end: 9 }
		});

		for (const store of stores) {
			await store.close();
		}
	});

	it("preserves typed rebuilding responses through the JSON-RPC gate", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const stores: StorageDriver[] = [];
		vi.spyOn(SqliteStore.prototype, "getSearchCapability").mockResolvedValue({ state: "rebuilding" });
		vi.spyOn(SqliteStore.prototype, "search").mockResolvedValue({ state: "rebuilding" });
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const capabilityResponse = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "getSearchCapability" });
		const searchResponse = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 2, method: "search", params: { query: "project", scope: { type: "all-projects" } } });

		expect(capabilityResponse.body.result).toEqual({ state: "rebuilding" });
		expect(searchResponse.body.result).toEqual({ state: "rebuilding" });

		for (const store of stores) {
			await store.close();
		}
	});

	it("preserves typed operational-error responses through the JSON-RPC gate", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });
		const stores: StorageDriver[] = [];
		vi.spyOn(SqliteStore.prototype, "search").mockResolvedValue({ state: "operational-error" });
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.send({ jsonrpc: "2.0", id: 1, method: "search", params: { query: "project", scope: { type: "all-projects" } } });

		expect(response.body.result).toEqual({ state: "operational-error" });

		for (const store of stores) {
			await store.close();
		}
	});

	it("creates the trusted authenticated user when a request writes", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const stores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider: {
				async validateToken() {
					return { userId: "entra:ada", tenantId: "sqlite-tenant", displayName: "Ada Lovelace" };
				}
			},
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", "Bearer trusted-token")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship authenticated mutations" } });

		expect(response.status).toBe(200);
		expect(response.body.error).toBeUndefined();
		expect(response.body.result).toMatchObject({ title: "Ship authenticated mutations" });
		expect(await stores[0].listUsers()).toMatchObject([
			{ authenticationSubject: "entra:ada", displayName: "Ada Lovelace" }
		]);

		for (const store of stores) {
			await store.close();
		}
	});

	it("creates the trusted authenticated user when a context write occurs", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const stores: StorageDriver[] = [];
		const app = createJsonRpcApp({
			authProvider: {
				async validateToken() {
					return { userId: "entra:grace", tenantId: "sqlite-tenant", displayName: "Grace Hopper" };
				}
			},
			createStore: async (identity) => {
				const { store } = await openSqliteStore(dbPath, { tenant: identity.tenantId });
				stores.push(store);
				return store;
			}
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", "Bearer trusted-token")
			.send({ jsonrpc: "2.0", id: 1, method: "upsertContext", params: { title: "Project context", summary: "Trusted context write." } });

		expect(response.status).toBe(200);
		expect(response.body.error).toBeUndefined();
		expect(await stores[0].listUsers()).toMatchObject([
			{ authenticationSubject: "entra:grace", displayName: "Grace Hopper" }
		]);

		for (const store of stores) {
			await store.close();
		}
	});

	it("forwards the client's project identity and workspace root headers to createStore (ISS183, ISS166)", async () => {
		const dbPath = path.join(tempDir, "test.db");
		const tenantId = "sqlite-tenant";
		const token = await authProvider.issueToken({ userId: "user-1", tenantId });

		const createStore = vi.fn(async (identity: { tenantId: string }) => (await openSqliteStore(dbPath, { tenant: identity.tenantId })).store);
		const app = createJsonRpcApp({ authProvider, createStore });

		await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${token}`)
			.set("x-agent-issues-project-identity", "repo-a")
			.set("x-agent-issues-workspace-root", "/workspaces/repo-a")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Ship the daemon" } });

		expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), "repo-a", "/workspaces/repo-a", "createEntity");
	});
});

/**
 * ADR45's build-content-hash version handshake: the daemon rejects a
 * request whose client-sent build-hash header doesn't match its own,
 * folded into the same gate layer as auth (before method dispatch), never
 * touching `createStore`/`StorageDriver` for a mismatched request. Omitted
 * entirely for the cloud gate (`versionHandshake` is optional), which has no
 * build-hash concept at all.
 */
describe("JSON-RPC gate version handshake (ISS188, ADR45)", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-version-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function tokenFor(tenantId: string): Promise<string> {
		return authProvider.issueToken({ userId: "user-1", tenantId });
	}

	it("rejects a request whose build-hash header does not match, never reaching createStore", async () => {
		const createStore = vi.fn(async (identity: { tenantId: string }) => {
			const { store } = await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId });
			return store;
		});
		const app = createJsonRpcApp({ authProvider, createStore, versionHandshake: { buildHash: "hash-v2" } });

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v1")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Stale client" } });

		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({ code: "daemon-version-mismatch", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" });
		expect(createStore).not.toHaveBeenCalled();
	});

	it("dispatches normally when the build-hash header matches", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Fresh client" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ title: "Fresh client" });
	});

	it("calls onMismatch exactly once per mismatched request", async () => {
		const onMismatch = vi.fn();
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2", onMismatch }
		});

		await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v1")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Stale" } });

		expect(onMismatch).toHaveBeenCalledOnce();
		expect(onMismatch).toHaveBeenCalledWith({ reason: "build-hash", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" });
	});

	it("treats a missing build-hash header as a mismatch", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "test.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "No header" } });

		expect(response.status).toBe(409);
		expect(response.body.receivedBuildHash).toBeUndefined();
	});
});

/**
 * The daemon-restart-on-different-db handshake: mirrors the build-hash
 * check above but keyed on the daemon's own resolved db path instead - a
 * client requesting a different `--db` than the one this daemon instance is
 * currently fronting is exactly as incompatible as a stale build, and
 * triggers the same drain-then-exit-and-respawn flow (never a silent
 * same-daemon-wrong-db routing bug).
 */
describe("JSON-RPC gate db-path handshake (ISS190)", () => {
	let tempDir: string;
	let authProvider: LocalAuthProvider;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-json-rpc-app-dbpath-"));
		authProvider = new LocalAuthProvider({ secret: "test-only-secret-never-used-in-production" });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function tokenFor(tenantId: string): Promise<string> {
		return authProvider.issueToken({ userId: "user-1", tenantId });
	}

	it("rejects a request whose db-path header does not match, never reaching createStore", async () => {
		const createStore = vi.fn(async (identity: { tenantId: string }) => {
			const { store } = await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId });
			return store;
		});
		const app = createJsonRpcApp({
			authProvider,
			createStore,
			versionHandshake: { buildHash: "hash-v2", dbPath: path.join(tempDir, "current.db") }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.set("x-agent-issues-db-path", path.join(tempDir, "other.db"))
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Wrong db" } });

		expect(response.status).toBe(409);
		expect(response.body).toMatchObject({
			code: "daemon-db-mismatch",
			expectedDbPath: path.join(tempDir, "current.db"),
			receivedDbPath: path.join(tempDir, "other.db")
		});
		expect(createStore).not.toHaveBeenCalled();
	});

	it("dispatches normally when the db-path header matches", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2", dbPath: path.join(tempDir, "current.db") }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.set("x-agent-issues-db-path", path.join(tempDir, "current.db"))
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "Right db" } });

		expect(response.status).toBe(200);
		expect(response.body.result).toMatchObject({ title: "Right db" });
	});

	it("dispatches normally when the daemon has no dbPath configured (e.g. cloud gate never sets it)", async () => {
		const app = createJsonRpcApp({
			authProvider,
			createStore: async (identity) => (await openSqliteStore(path.join(tempDir, "current.db"), { tenant: identity.tenantId })).store,
			versionHandshake: { buildHash: "hash-v2" }
		});

		const response = await request(app)
			.post("/rpc")
			.set("authorization", `Bearer ${await tokenFor("t1")}`)
			.set("x-agent-issues-build-hash", "hash-v2")
			.send({ jsonrpc: "2.0", id: 1, method: "createEntity", params: { kind: "initiative", title: "No dbPath configured" } });

		expect(response.status).toBe(200);
	});
});
