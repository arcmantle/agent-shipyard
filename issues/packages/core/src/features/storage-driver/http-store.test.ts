import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { CompletionObservationConflictError, SynchronizeConflictError } from "../synchronize/canonical-chain.js";
import { IssueCommentConflictError } from "./issue-comment-store.js";
import { PlanEntryConflictError } from "../plan-entry/plan-entry-types.js";
import { DaemonDbPathMismatchError, DaemonHandshakeMismatchError, DaemonVersionMismatchError, HttpStore } from "./http-store.js";
import type { SearchCapability, SearchResponse } from "./search-store.js";
import type { StorageDriver } from "./storage-driver.js";
import type { WorkspaceRetrievalContext } from "../workspace-observation/workspace-observation.js";

describe("HttpStore Plan entry transport", () => {
	it("calls the Plan-entry creation RPC method", async () => {
		const fetchImpl: typeof fetch = async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as { method: string; params: unknown };
			expect(request).toMatchObject({
				method: "createPlanEntry",
				params: { planId: "plan-id", role: "question", body: "Which backend stores entries?" }
			});
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				result: {
					id: "entry-id",
					reference: "PLAN_ENTRY_00000000000000000000000000",
					shortReference: "PLAN_ENTRY_000000",
					planId: "plan-id",
					createdBy: "user-id",
					updatedBy: "user-id",
					role: "question",
					body: "Which backend stores entries?",
					scopeDirection: null,
					referencedEntityIds: [],
					supersededEntryIds: [],
					tombstone: false,
					revision: 1,
					contentHash: "hash",
					createdAt: "2026-08-15T00:00:00.000Z",
					updatedAt: "2026-08-15T00:00:00.000Z"
				}
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.createPlanEntry({ planId: "plan-id", role: "question", body: "Which backend stores entries?" })).resolves.toMatchObject({ id: "entry-id" });
	});
});

describe("HttpStore search transport", () => {
	it("returns an available capability and final ordered search results", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
			requests.push({ method, params });
			const result: SearchCapability | SearchResponse = method === "getSearchCapability"
				? { state: "available" }
				: {
					state: "available",
					retrievalDiagnostics: [],
					results: [{
						id: "result-1",
						identity: {
							sourceType: "entity",
							sourceId: "entity-1",
							reference: "ISS_00000000000000000000000000",
							shortReference: "ISS_000000"
						},
						title: "First result",
						projectId: "project-1",
						projectLabel: "Test project",
						updatedAt: "2026-08-28T00:00:00.000Z",
						navigationTarget: { type: "entity", entityId: "entity-1" },
						match: { field: "title" },
						codeCompatibility: "exact-commit"
					}]
				};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.getSearchCapability()).resolves.toEqual({ state: "available" });
		await expect(client.search({ query: "first", scope: { type: "current-project", projectId: "project-1" } })).resolves.toEqual({
			state: "available",
			retrievalDiagnostics: [],
			results: [{
				id: "result-1",
				identity: {
					sourceType: "entity",
					sourceId: "entity-1",
					reference: "ISS_00000000000000000000000000",
					shortReference: "ISS_000000"
				},
				title: "First result",
				projectId: "project-1",
				projectLabel: "Test project",
				updatedAt: "2026-08-28T00:00:00.000Z",
				navigationTarget: { type: "entity", entityId: "entity-1" },
				match: { field: "title" },
				codeCompatibility: "exact-commit"
			}]
		});
		expect(requests).toEqual([
			{ method: "getSearchCapability", params: undefined },
			{ method: "search", params: { query: "first", scope: { type: "current-project", projectId: "project-1" } } }
		]);
	});

	it("round-trips privacy-safe workspace retrieval context for search and entity queries", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const retrievalContext: WorkspaceRetrievalContext = {
			repositoryIdentity: "repository-digest",
			commitSha: "commit-sha",
			calculatedVersion: "1.2.3",
			diagnostics: [{ code: "prospector-calculation-failed", message: "Calculation is unavailable." }]
		};
		const fetchImpl: typeof fetch = async (_input, init) => {
			const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
			requests.push({ method, params });
			const result = method === "queryEntities" ? { entities: [], total: 0 } : { state: "available", results: [] };
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await client.search({ query: "workspace", scope: { type: "all-projects" }, retrievalContext });
		await client.queryEntities({ kind: "issue", retrievalContext });
		await client.search({
			query: "workspace",
			scope: { type: "all-projects" },
			retrievalContext: { diagnostics: [{ code: "workspace-observation-failed", message: "Workspace observation is unavailable." }] }
		});

		expect(requests).toEqual([
			{ method: "search", params: { query: "workspace", scope: { type: "all-projects" }, retrievalContext } },
			{ method: "queryEntities", params: { kind: "issue", retrievalContext } },
			{
				method: "search",
				params: {
					query: "workspace",
					scope: { type: "all-projects" },
					retrievalContext: { diagnostics: [{ code: "workspace-observation-failed", message: "Workspace observation is unavailable." }] }
				}
			}
		]);
	});
});

describe("HttpStore entity-type transport", () => {
	it("forwards type on entity creation and nullable type updates", async () => {
		const requests: Array<{ method: string; params: unknown }> = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
			requests.push({ method, params });
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await client.createEntity({ kind: "issue", title: "Pioneer map", type: "pioneer-map" });
		await client.updateEntity({ entityId: "issue-id", type: null, expectedRevision: 1, expectedContentHash: "current-hash" });

		expect(requests).toEqual([
			{ method: "createEntity", params: { kind: "issue", title: "Pioneer map", type: "pioneer-map" } },
			{ method: "updateEntity", params: { entityId: "issue-id", type: null, expectedRevision: 1, expectedContentHash: "current-hash" } }
		]);
		expectTypeOf<Parameters<HttpStore["createEntity"]>[0]>().toEqualTypeOf<Parameters<StorageDriver["createEntity"]>[0]>();
		expectTypeOf<Parameters<HttpStore["updateEntity"]>[0]>().toEqualTypeOf<Parameters<StorageDriver["updateEntity"]>[0]>();
	});
});

describe("HttpStore synchronize conflict transport (ISS267/ADR55)", () => {
	it("recreates a typed completion-observation conflict", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Cannot synchronize completion observation observation-id: immutable facts differ.",
						data: { observationId: "observation-id" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.importCanonicalChains({ entities: [], contexts: [], contextTerms: [], issueComments: [], planEntries: [], users: [] })).rejects.toMatchObject({
			name: "CompletionObservationConflictError",
			observationId: "observation-id"
		} satisfies Partial<CompletionObservationConflictError>);
	});

	it("recreates a typed conflict with current record metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Cannot synchronize divergent or stale context-term project:tenant: current revision is 3.",
						data: { recordKind: "context-term", recordId: "project:tenant", currentRevision: 3, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.importCanonicalChains({ entities: [], contexts: [], contextTerms: [], issueComments: [], planEntries: [], users: [] })).rejects.toMatchObject({
			name: "SynchronizeConflictError",
			recordKind: "context-term",
			recordId: "project:tenant",
			currentRevision: 3,
			currentContentHash: "current-hash"
		} satisfies Partial<SynchronizeConflictError>);
	});

	it("recreates a Plan-entry synchronization conflict", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Cannot synchronize divergent Plan entry entry-id: current revision is 2.",
						data: { recordKind: "plan-entry", recordId: "entry-id", currentRevision: 2, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.importCanonicalChains({ entities: [], contexts: [], contextTerms: [], issueComments: [], planEntries: [], users: [] })).rejects.toMatchObject({
			name: "SynchronizeConflictError",
			recordKind: "plan-entry",
			recordId: "entry-id",
			currentRevision: 2,
			currentContentHash: "current-hash"
		} satisfies Partial<SynchronizeConflictError>);
	});

	it("recreates a typed issue-comment conflict with current record metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Stale edit for issue comment comment-id: current revision is 3.",
						data: { commentId: "comment-id", currentRevision: 3, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.updateIssueComment({
			commentId: "comment-id",
			body: "Updated comment.",
			expectedRevision: 1,
			expectedContentHash: "stale-hash"
		})).rejects.toMatchObject({
			name: "IssueCommentConflictError",
			commentId: "comment-id",
			currentRevision: 3,
			currentContentHash: "current-hash"
		} satisfies Partial<IssueCommentConflictError>);
	});

	it("recreates a typed Plan-entry conflict with current record metadata", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "1",
					error: {
						code: -32603,
						message: "Stale edit for Plan entry entry-id: current revision is 3.",
						data: { entryId: "entry-id", currentRevision: 3, currentContentHash: "current-hash" }
					}
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		const client = new HttpStore({ baseUrl: "https://example.test", bearerToken: "token", tenantId: "t1", fetchImpl });

		await expect(client.updatePlanEntry({
			entryId: "entry-id",
			body: "Updated Plan entry.",
			expectedRevision: 1,
			expectedContentHash: "stale-hash"
		})).rejects.toMatchObject({
			name: "PlanEntryConflictError",
			entryId: "entry-id",
			currentRevision: 3,
			currentContentHash: "current-hash"
		} satisfies Partial<PlanEntryConflictError>);
	});
});

/**
 * `HttpStore`'s full behavioral contract runs against a real gate elsewhere
 * (`http-store-contract.test.ts`, `storage-driver-contract.test.ts`). This
 * file only covers the build-hash version-handshake header/error handling
 * (ISS188, ADR45), which needs no `StorageDriver`/Postgres at all - a bare
 * fake HTTP server standing in for the daemon's `/rpc` route is enough.
 */
describe("HttpStore build-hash version handshake (ISS188, ADR45)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(409, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "Daemon build-hash mismatch.", code: "daemon-version-mismatch", expectedBuildHash: "hash-v2", receivedBuildHash: "hash-v1" }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured build hash on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-build-hash"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", buildHash: "hash-v1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(seenHeader).toBe("hash-v1");
	});

	it("sends the configured project-change correlation on every request", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-correlation-id"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", correlationId: "write-1", tenantId: "t1" });
		await client.updateEntityStatus({ entityId: "ISS1", status: "done" }).catch(() => undefined);

		expect(seenHeader).toBe("write-1");
	});

	it("sends no build-hash header when none is configured (cloud mode, unaffected)", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-build-hash" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(sawHeader).toBe(false);
	});

	it("throws a DaemonVersionMismatchError carrying both hashes on a 409 mismatch response", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", buildHash: "hash-v1" });

		await expect(client.listEntities("initiative")).rejects.toThrow(DaemonVersionMismatchError);
		try {
			await client.listEntities("initiative");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonVersionMismatchError);
			expect((error as DaemonVersionMismatchError).expectedBuildHash).toBe("hash-v2");
			expect((error as DaemonVersionMismatchError).receivedBuildHash).toBe("hash-v1");
		}
	});
});

/**
 * ISS190's daemon-restart-on-different-db mechanism: mirrors the build-hash
 * handshake above but keyed on the requested db path instead.
 */
describe("HttpStore db-path handshake (ISS190)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(409, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "Daemon db-path mismatch.", code: "daemon-db-mismatch", expectedDbPath: "/tmp/current.db", receivedDbPath: "/tmp/other.db" }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured db path on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-db-path"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(seenHeader).toBe("/tmp/other.db");
	});

	it("sends no db-path header when none is configured (cloud mode, unaffected)", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-db-path" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative").catch(() => undefined);

		expect(sawHeader).toBe(false);
	});

	it("throws a DaemonDbPathMismatchError carrying both paths on a 409 db-mismatch response", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });

		try {
			await client.listEntities("initiative");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DaemonDbPathMismatchError);
			expect((error as DaemonDbPathMismatchError).expectedDbPath).toBe("/tmp/current.db");
			expect((error as DaemonDbPathMismatchError).receivedDbPath).toBe("/tmp/other.db");
		}
	});

	it("is also a DaemonHandshakeMismatchError, like DaemonVersionMismatchError", async () => {
		const baseUrl = await listenWithHandler(() => undefined);
		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", dbPath: "/tmp/other.db" });

		await expect(client.listEntities("initiative")).rejects.toThrow(DaemonHandshakeMismatchError);
	});
});

/**
 * ISS183's project-scoping seam: unlike build-hash/db-path, there is no
 * mismatch/error concept here - the header just carries the client's
 * already-resolved project identity onward to the cloud gate, which uses
 * it to scope a bare `context` command to that project's own glossary.
 */
describe("HttpStore project-identity header (ISS183)", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
	});

	async function listenWithHandler(handler: (headers: Record<string, string | string[] | undefined>) => void): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				handler(request.headers);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: [] }));
			});
		});
		const port = await new Promise<number>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});
		return `http://127.0.0.1:${port}`;
	}

	it("sends the configured project identity on every request when supplied", async () => {
		let seenHeader: string | string[] | undefined;
		const baseUrl = await listenWithHandler((headers) => {
			seenHeader = headers["x-agent-issues-project-identity"];
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1", projectIdentity: "repo-a" });
		await client.listEntities("initiative");

		expect(seenHeader).toBe("repo-a");
	});

	it("sends no project-identity header when none is configured", async () => {
		let sawHeader = false;
		const baseUrl = await listenWithHandler((headers) => {
			sawHeader = "x-agent-issues-project-identity" in headers;
		});

		const client = new HttpStore({ baseUrl, bearerToken: "token", tenantId: "t1" });
		await client.listEntities("initiative");

		expect(sawHeader).toBe(false);
	});
});
