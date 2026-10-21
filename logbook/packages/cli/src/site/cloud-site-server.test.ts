import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstructionFragmentError, type InstructionSourceResult, type RunCredentialCommand } from "@agent-issues/core";
import { saveSavedLogin, type SavedLoginStoreOptions } from "../auth/auth-session.js";
import { getInstructionVersion } from "../runtime/instruction-version.js";

import { startLiveSite, type LiveSiteHandle } from "./index.js";

type RpcRequestLog = { authorization: string | undefined; method: string; params: unknown };

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

/** A minimal fake cloud gate exposing both /rpc and /events, standing in for the real one (proven in packages/api-pg/src/http-store-contract.test.ts and the cloud API's own SSE route). */
function startFakeCloudGate(handleMethod: (method: string, params: unknown) => unknown): {
	push: (tenantEvent: unknown) => void;
	requests: RpcRequestLog[];
	server: Server;
	url: string;
} {
	const requests: RpcRequestLog[] = [];
	const eventClients = new Set<ServerResponse>();

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

		if (requestUrl.pathname === "/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive"
			});
			response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
			eventClients.add(response);
			request.on("close", () => eventClients.delete(response));
			return;
		}

		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
			requests.push({ authorization: request.headers.authorization, method: body.method, params: body.params });
			const result = handleMethod(body.method, body.params);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result instanceof InstructionFragmentError
				? { id: body.id, jsonrpc: "2.0", error: { code: -32000, message: result.message, data: {
					instructionFragmentError: true, reason: result.reason, currentSource: result.currentSource, affectedReferences: result.affectedReferences
				} } }
				: { id: body.id, jsonrpc: "2.0", result }));
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		push: (tenantEvent: unknown) => {
			const payload = `data: ${JSON.stringify(tenantEvent)}\n\n`;
			for (const client of eventClients) client.write(payload);
		},
		requests,
		server,
		url: `http://127.0.0.1:${port}`
	};
}

function waitForSnapshotChangedEvent(url: string): { event: Promise<unknown>; stop: () => void } {
	let resolveEvent!: (value: unknown) => void;
	const promise = new Promise<unknown>((resolve) => {
		resolveEvent = resolve;
	});

	const controller = new AbortController();
	void (async () => {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.body) return;
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
					if (dataLine) {
						const parsed = JSON.parse(dataLine.slice("data:".length).trim());
						if (parsed.type === "snapshot-changed") {
							resolveEvent(parsed);
						}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} catch {
			// aborted
		}
	})();

	return { event: promise, stop: () => controller.abort() };
}

describe("site server follows the seam in cloud mode (ISS56)", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let handle: LiveSiteHandle | undefined;
	let credentialStoreOptions: SavedLoginStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-site-cloud-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-site-cloud-project-"));
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(async () => {
		if (handle?.server.listening) {
			await new Promise<void>((resolve) => {
				handle?.server.once("close", () => resolve());
				handle?.close();
			});
		}
		handle = undefined;
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("routes both site reset contracts through the active cloud owner and CLI release", async () => {
		const currentSource: InstructionSourceResult = { key: "skill/prepare", kind: "skill", body: "Personal", version: "0.2.0", source: { type: "override", revision: 2, contentHash: "personal", defaultVersion: "0.1.0" } };
		const proposedSource: InstructionSourceResult = { ...currentSource, body: "Default", source: { type: "default", revision: 3, contentHash: "official" } };
		const expectedRevisions = [{ key: currentSource.key, sourceType: "override", expectedRevision: 2 }];
		const inspection = { version: "0.2.0", owner: { type: "cloud", tenantId: "tenant-a", userId: "user-1" }, overrides: [{ currentSource, proposedSource }], personalFragments: [], affectedInstructions: [currentSource.key], expectedRevisions };
		const gate = startFakeCloudGate((method) => {
			if (method === "inspectInstructionReset") return { key: currentSource.key, version: "0.2.0", currentSource, proposedSource, affectedInstructions: [], modifiedFragments: [] };
			if (method === "resetInstructionSource") return proposedSource;
			if (method === "inspectInstructionResetAll" || method === "resetInstructionAll") return inspection;
			return {};
		});
		try {
			await saveSavedLogin({ name: "work", kind: "remote", serviceUrl: gate.url, accessToken: "token-resets", expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" }, credentialStoreOptions);
			handle = await startLiveSite({ credentialStoreOptions, currentWorkingDirectory: projectDirectory, port: 0 });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));
			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const baseUrl = `http://127.0.0.1:${port}/api/instructions`;
			const read = (operation: string) => fetch(`${baseUrl}/${operation}?tenant=another-tenant&project=another-project&key=skill%2Fprepare&version=another-release`);
			const post = (operation: string, body: object) => fetch(`${baseUrl}/${operation}?tenant=another-tenant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, userId: "another-user", version: "another-release" }) });
			expect((await read("reset/inspect")).status).toBe(200);
			const reset = await post("reset", { key: currentSource.key, expectedRevision: 2 });
			expect(reset.status).toBe(200);
			expect(await reset.json()).toEqual(proposedSource);
			const all = await read("reset-all/inspect").then((response) => response.json());
			expect(all).toMatchObject(inspection);
			expect((await post("reset-all", { expectedRevisions, confirmationToken: all.confirmationToken })).status).toBe(200);
			for (const request of gate.requests.filter((request) => request.method.startsWith("inspectInstructionReset") || request.method.startsWith("resetInstruction"))) {
				expect(request.authorization).toBe("Bearer token-resets");
				expect(request.params).toEqual({ version: getInstructionVersion(),
					...(request.method === "inspectInstructionReset" || request.method === "resetInstructionSource" ? { key: currentSource.key } : {}),
					...(request.method === "resetInstructionSource" ? { expectedRevision: 2 } : {}),
					...(request.method === "resetInstructionAll" ? { expectedRevisions } : {}) });
			}
		} finally { gate.server.close(); }
	});

	it("routes fragment lifecycle through the active cloud owner and preserves removal errors", async () => {
		const created: InstructionSourceResult = { key: "fragment/personal", kind: "fragment", body: "Personal", version: "0.2.0", source: { type: "personal", revision: 3, contentHash: "cloud" } };
		let referenced = true;
		const gate = startFakeCloudGate((method) => {
			if (method === "createInstructionFragment") return created;
			if (method === "removeInstructionFragment") return referenced
				? new InstructionFragmentError("referenced", "Removal is blocked", created, ["skill/prepare"])
				: { ...created, source: { ...created.source, revision: 4 } };
			return {};
		});
		try {
			await saveSavedLogin({ name: "work", kind: "remote", serviceUrl: gate.url, accessToken: "token-fragments",
				expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" }, credentialStoreOptions);
			handle = await startLiveSite({ credentialStoreOptions, currentWorkingDirectory: projectDirectory, port: 0 });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));
			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const post = (operation: string, value: unknown) => fetch(`http://127.0.0.1:${port}/api/instructions/fragments/${operation}?tenant=another-tenant&project=another-project`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value)
			});
			const response = await post("create", { key: created.key, body: created.body, version: "another-release", userId: "another-user" });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(created);
			const rejected = await post("remove", { key: created.key, expectedRevision: 3, version: "another-release" });
			expect(rejected.status).toBe(400);
			expect(await rejected.json()).toMatchObject({ reason: "referenced", currentSource: created, affectedReferences: ["skill/prepare"] });
			referenced = false;
			const removed = await post("remove", { key: created.key, expectedRevision: 3 });
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({ key: created.key, source: { revision: 4 } });
			expect(gate.requests.filter((request) => request.method === "createInstructionFragment").map((request) => request.params)).toEqual([
				{ key: created.key, body: created.body, version: getInstructionVersion() }
			]);
			const removalRequests = gate.requests.filter((request) => request.method === "removeInstructionFragment");
			expect(removalRequests).toHaveLength(2);
			for (const request of gate.requests) {
				expect(request.authorization).toBe("Bearer token-fragments");
				if (request.method === "removeInstructionFragment") expect(request.params).toEqual({ key: created.key, expectedRevision: 3, version: getInstructionVersion() });
			}
		} finally {
			gate.server.close();
		}
	});

	it("reads personal instruction catalog and source through the active cloud owner without a project", async () => {
		const item = { key: "skill/prepare", kind: "skill", body: "# Cloud prepare", source: { type: "override", revision: 2, contentHash: "cloud-hash", defaultVersion: "0.1.0" } };
		const comparison = { key: item.key, version: "0.2.0", currentSource: { ...item, version: "0.2.0" },
			defaultSource: { ...item, body: "# Official prepare", version: "0.2.0", source: { type: "default", revision: 1, contentHash: "official" } },
			different: true, newerDefaultVersions: ["0.3.0"] };
		const dependencies = { key: item.key, version: "0.2.0", source: item.source,
			dependencies: [{ key: "fragment/rules", direct: true, source: item.source }], modifiedFragments: ["fragment/rules"], affectedInstructions: [] };
		const historical = { ...item, body: "Earlier cloud source", version: "0.2.0", source: { ...item.source, revision: 1 } };
		const gate = startFakeCloudGate((method) => {
			if (method === "listInstructionSources") return { version: "0.2.0", items: [item] };
			if (method === "readInstructionSource") return { ...item, version: "0.2.0" };
			if (method === "compareInstructionSource") return comparison;
			if (method === "inspectInstructionDependencies") return dependencies;
			if (method === "listInstructionHistory") return { key: item.key, version: "0.2.0", revisions: [historical] };
			if (method === "readInstructionRevision") return historical;
			if (method === "restoreInstructionRevision") return { ...historical, source: { ...item.source, revision: 3 } };
			if (method === "saveInstructionSource") return { ...item, body: "# Edited cloud prepare", version: "0.2.0", source: { ...item.source, revision: 3 } };
			return {};
		});
		try {
			await saveSavedLogin({ name: "work", kind: "remote", serviceUrl: gate.url, accessToken: "token-instructions",
				expiresAt: "2099-01-01T00:00:00.000Z", tenantId: "tenant-a", userId: "user-1" }, credentialStoreOptions);
			handle = await startLiveSite({ credentialStoreOptions, currentWorkingDirectory: projectDirectory, port: 0 });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));
			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/catalog?tenant=another-tenant&version=another-release`);
			expect(catalogResponse.status).toBe(200);
			expect(await catalogResponse.json()).toEqual({ version: "0.2.0", items: [item], owner: { type: "cloud", tenantId: "tenant-a", userId: "user-1" } });
			const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/source?key=skill%2Fprepare`);
			expect(sourceResponse.status).toBe(200);
			expect(await sourceResponse.json()).toEqual({ ...item, version: "0.2.0" });
			const comparisonResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/compare?tenant=another-tenant&key=skill%2Fprepare&version=another-release`);
			expect(comparisonResponse.status).toBe(200);
			expect(await comparisonResponse.json()).toEqual(comparison);
			expect(gate.requests.find((request) => request.method === "compareInstructionSource")?.params).toEqual({ key: item.key, version: getInstructionVersion() });
			const dependencyResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/dependencies?tenant=another-tenant&key=skill%2Fprepare&version=another-release`);
			expect(dependencyResponse.status).toBe(200);
			expect(await dependencyResponse.json()).toEqual(dependencies);
			const dependencyRequest = gate.requests.find((request) => request.method === "inspectInstructionDependencies");
			expect(dependencyRequest?.params).toEqual({ key: item.key, version: getInstructionVersion() });
			expect(dependencyRequest?.authorization).toBe("Bearer token-instructions");
			const historyResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/history?key=skill%2Fprepare&tenant=another-tenant&version=another-release`);
			expect(historyResponse.status).toBe(200);
			expect(await historyResponse.json()).toEqual({ key: item.key, version: "0.2.0", revisions: [historical] });
			const revisionResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/revision?key=skill%2Fprepare&revision=1`);
			expect(revisionResponse.status).toBe(200);
			expect(await revisionResponse.json()).toEqual(historical);
			const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/restore?tenant=another-tenant`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: item.key, revision: 1, expectedRevision: 2, version: "another-release", userId: "another-user" })
			});
			expect(restoreResponse.status).toBe(200);
			expect(await restoreResponse.json()).toMatchObject({ body: historical.body, source: { revision: 3 } });
			for (const method of ["listInstructionHistory", "readInstructionRevision", "restoreInstructionRevision"]) {
				const request = gate.requests.find((candidate) => candidate.method === method)!;
				expect(request.authorization).toBe("Bearer token-instructions");
				expect(request.params).toEqual({ key: item.key, version: getInstructionVersion(),
					...(method !== "listInstructionHistory" ? { revision: 1 } : {}),
					...(method === "restoreInstructionRevision" ? { expectedRevision: 2 } : {}) });
			}
			const saveResponse = await fetch(`http://127.0.0.1:${port}/api/instructions/source?tenant=another-tenant`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: item.key, body: "# Edited cloud prepare", expectedRevision: 2, version: "another-release" })
			});
			expect(saveResponse.status).toBe(200);
			expect(await saveResponse.json()).toMatchObject({ body: "# Edited cloud prepare", source: { revision: 3 } });
			expect(gate.requests.find((request) => request.method === "saveInstructionSource")?.params).toEqual({
				key: item.key, body: "# Edited cloud prepare", expectedRevision: 2, version: getInstructionVersion()
			});
			for (const request of gate.requests.filter((request) => request.method === "listInstructionSources" || request.method === "readInstructionSource" || request.method === "saveInstructionSource" || request.method === "compareInstructionSource")) {
				expect(request.authorization).toBe("Bearer token-instructions");
				expect(request.params).toMatchObject({ version: getInstructionVersion() });
			}
		} finally {
			gate.server.close();
		}
	});

	it("serves snapshot/site-config through the active remote saved login", async () => {
		const gate = startFakeCloudGate((method) => {
			if (method === "listTenants") {
				return [{ id: "tenant-a", displayName: "tenant-a", counts: { entities: 0, relations: 0, contexts: 0, contextTerms: 0, handoffs: 0, historyEntries: 0 } }];
			}
			if (method === "getDatabaseSnapshot") {
				return {
					kind: "available",
					snapshot: { entities: [{ id: "iss-1", kind: "initiative", title: "Cloud Viewer" }], relations: [] }
				};
			}
			return {};
		});

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

			handle = await startLiveSite({ credentialStoreOptions, currentWorkingDirectory: projectDirectory, port: 0, tenant: "tenant-a" });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			const configResponse = await fetch(`http://127.0.0.1:${port}/site-config.json`);
			const config = await configResponse.json();
			expect(config.dbPath).toBe(gate.url);
			expect(config.currentTenant).toBe("tenant-a");

			const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/snapshot?project=PROJ1`);
			const snapshot = await snapshotResponse.json();
			expect(snapshot.snapshot.entities.map((entity: { id: string }) => entity.id)).toContain("iss-1");

			expect(gate.requests.every((request) => request.authorization === "Bearer token-a")).toBe(true);
		} finally {
			gate.server.close();
		}
	});

	it("relays snapshot-changed events from the same active remote saved login", async () => {
		const gate = startFakeCloudGate(() => ({}));

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

			handle = await startLiveSite({ credentialStoreOptions, currentWorkingDirectory: projectDirectory, port: 0, tenant: "tenant-a" });
			await new Promise<void>((resolve) => handle?.server.once("listening", resolve));

			const address = handle.server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			const listener = waitForSnapshotChangedEvent(`http://127.0.0.1:${port}/events`);
			await new Promise((resolve) => setTimeout(resolve, 100));

			gate.push({ type: "snapshot-changed", at: "2024-01-01T00:00:00.000Z" });

			const event = await Promise.race([
				listener.event,
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out waiting for relayed event")), 2000))
			]);

			listener.stop();
			expect(event).toEqual({ type: "snapshot-changed", at: "2024-01-01T00:00:00.000Z" });
		} finally {
			gate.server.close();
		}
	});
});
