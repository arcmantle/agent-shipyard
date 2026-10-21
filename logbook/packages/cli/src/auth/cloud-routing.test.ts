import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunCredentialCommand } from "@agent-issues/core";
import { saveSavedLogin, type SavedLoginStoreOptions } from "./auth-session.js";

import { runCli } from "../cli.js";

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

type RpcRequestLog = { method: string; params: unknown; authorization: string | undefined; projectIdentity: string | undefined };

/** A minimal fake JSON-RPC gate, standing in for the real cloud API (proven separately in packages/api-pg/src/http-store-contract.test.ts) so this suite can verify CLI-level plumbing without a Postgres dependency. */
function startFakeRpcGate(handleMethod: (method: string, params: unknown) => unknown): {
	requests: RpcRequestLog[];
	server: Server;
	url: string;
} {
	const requests: RpcRequestLog[] = [];

	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: unknown };
			requests.push({
				authorization: request.headers.authorization,
				method: body.method,
				params: body.params,
				projectIdentity: request.headers["x-agent-issues-project-identity"] as string | undefined
			});

			try {
				const result = handleMethod(body.method, body.params);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { code: -32000, message }, id: body.id, jsonrpc: "2.0" }));
			}
		});
	});

	server.listen(0);
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return { requests, server, url: `http://127.0.0.1:${port}` };
}

/**
 * Proves the seam ISS55 wires up: an ordinary entity command
 * routes through `withStore` -> `openStorageDriver` -> `HttpStore` and hits
 * the globally active remote saved login with no behavior change to the
 * command itself.
 */
describe("CLI commands route through the active remote saved login", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;
	let credentialStoreOptions: SavedLoginStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-routing-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-cloud-routing-project-"));
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("creates an entity using the saved URL, bearer token, tenant, and resolved project identity", async () => {
		const gate = startFakeRpcGate((method, params) => {
			expect(method).toBe("createEntity");
			expect(params).toEqual({ kind: "initiative", title: "Ship it" });
			return {
				body: "",
				bodySource: "manual",
				createdAt: "2024-01-01T00:00:00.000Z",
				id: "iss-1",
				kind: "initiative",
				status: "open",
				title: "Ship it",
				updatedAt: "2024-01-01T00:00:00.000Z"
			};
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

			const stdout = createCapture();
			const stderr = createCapture();
			const exitCode = await runCli(["create", "initiative", "--title", "Ship it", "--json"], {
				credentialStoreOptions,
				cwd: projectDirectory,
				stderr: stderr.stream,
				stdout: stdout.stream
			});

			expect(stderr.read()).toBe("");
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout.read())).toMatchObject({ id: "iss-1" });
			expect(gate.requests).toHaveLength(1);
			expect(gate.requests[0]?.authorization).toBe("Bearer token-a");
			expect(gate.requests[0]?.projectIdentity).toBe(path.basename(projectDirectory).toLowerCase());
		} finally {
			gate.server.close();
		}
	});

	it("surfaces the named refresh command before HTTP when the active saved login is expired", async () => {
		const gate = startFakeRpcGate(() => ({}));

		try {
			await saveSavedLogin(
				{
					name: "work",
					kind: "remote",
					serviceUrl: gate.url,
					accessToken: "token-a",
					expiresAt: "2000-01-01T00:00:00.000Z",
					tenantId: "tenant-a",
					userId: "user-1"
				},
				credentialStoreOptions
			);

			await expect(
				runCli(["create", "initiative", "--title", "Ship it"], { credentialStoreOptions, cwd: projectDirectory })
			).rejects.toThrow(/auth login --name work --url http:\/\/127\.0\.0\.1:/);
			expect(gate.requests).toHaveLength(0);
		} finally {
			gate.server.close();
		}
	});
});
