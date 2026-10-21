import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunCredentialCommand } from "@agent-issues/core";
import type { SavedLoginStoreOptions } from "./auth-session.js";
import { runCli, type AgentIssuesContext } from "../cli.js";

type RpcRequest = {
	authorization: string | undefined;
	method: string;
	projectIdentity: string | undefined;
};

type FakeRemoteGate = {
	clientId: string;
	close: () => Promise<void>;
	requests: RpcRequest[];
	tenantId: string;
	url: string;
};

function fakeCredentialStore(): SavedLoginStoreOptions {
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

async function startFakeRemoteGate(name: string): Promise<FakeRemoteGate> {
	const tenantId = `discovered-${name}-tenant`;
	const clientId = `discovered-${name}-client`;
	const requests: RpcRequest[] = [];
	let entitySequence = 0;
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		if (request.method === "GET" && request.url === "/.well-known/agent-issues") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ auth: { provider: "entra", tenantId, clientId } }));
			return;
		}

		if (request.method !== "POST" || request.url !== "/rpc") {
			response.writeHead(404).end();
			return;
		}

		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string };
			requests.push({
				authorization: request.headers.authorization,
				method: body.method,
				projectIdentity: request.headers["x-agent-issues-project-identity"] as string | undefined
			});
			entitySequence += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				id: body.id,
				jsonrpc: "2.0",
				result: {
					body: "",
					bodySource: "manual",
					createdAt: "2026-01-01T00:00:00.000Z",
					id: `${name}-entity-${entitySequence}`,
					kind: "initiative",
					status: "open",
					title: `${name} result`,
					updatedAt: "2026-01-01T00:00:00.000Z"
				}
			}));
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Fake remote gate did not bind to a TCP port.");
	}

	return {
		clientId,
		close: () => closeServer(server),
		requests,
		tenantId,
		url: `http://127.0.0.1:${address.port}`
	};
}

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

describe("login-driven routing end to end", () => {
	let credentialStoreOptions: SavedLoginStoreOptions;
	let homeDirectory: string;
	let originalHome: string | undefined;
	let projectDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-login-routing-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		projectDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-login-routing-project-"));
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
		rmSync(projectDirectory, { force: true, recursive: true });
	});

	it("discovers two remotes and routes the full switch and logout lifecycle without exposing credentials", async () => {
		const first = await startFakeRemoteGate("first");
		const second = await startFakeRemoteGate("second");
		const accessTokens = [`token-for-${first.tenantId}`, `token-for-${second.tenantId}`];
		const deviceCodeLogin = vi.fn<NonNullable<NonNullable<AgentIssuesContext["authLoginDependencies"]>["deviceCodeLogin"]>>(
			async ({ tenantId, clientId }) => ({
				accessToken: `token-for-${tenantId}`,
				displayName: `User for ${clientId}`,
				expiresAt: "2099-01-01T00:00:00.000Z",
				tenantId: `credential-${tenantId}`,
				userId: `user-for-${clientId}`
			})
		);

		const invoke = async (args: string[]) => {
			const stdout = createCapture();
			const stderr = createCapture();
			const exitCode = await runCli(args, {
				authLoginDependencies: { deviceCodeLogin, fetch, interactive: false },
				credentialStoreOptions,
				cwd: projectDirectory,
				stderr: stderr.stream,
				stdout: stdout.stream
			});
			expect(exitCode).toBe(0);
			expect(stderr.read()).toBe("");
			for (const accessToken of accessTokens) {
				expect(stdout.read()).not.toContain(accessToken);
			}
			return stdout.read();
		};

		try {
			const firstLogin = await invoke(["auth", "login", "--name", "first", "--url", first.url]);
			expect(firstLogin).toContain(`Logged in as User for ${first.clientId}`);
			const secondLogin = JSON.parse(await invoke(["auth", "login", "--name", "second", "--url", second.url, "--json"]));
			expect(secondLogin.login).toMatchObject({ name: "second", tenantId: `credential-${second.tenantId}` });
			expect(deviceCodeLogin).toHaveBeenNthCalledWith(1, {
				clientId: first.clientId,
				onDeviceCode: expect.any(Function),
				tenantId: first.tenantId
			});
			expect(deviceCodeLogin).toHaveBeenNthCalledWith(2, {
				clientId: second.clientId,
				onDeviceCode: expect.any(Function),
				tenantId: second.tenantId
			});

			expect(await invoke(["auth", "switch", "local"])).toContain("Switched to saved login local.");
			const list = JSON.parse(await invoke(["auth", "list", "--json"]));
			expect(list.logins.map((entry: { active: boolean; login: { name: string } }) => [entry.login.name, entry.active])).toEqual([
				["local", true],
				["first", false],
				["second", false]
			]);
			expect(await invoke(["auth", "status"])).toContain("Active saved login: local");

			expect(await invoke(["auth", "switch"])).toContain("Switched to saved login first.");
			const firstStatus = JSON.parse(await invoke(["auth", "status", "--json"]));
			expect(firstStatus.login).toMatchObject({ name: "first", tenantId: `credential-${first.tenantId}` });
			const firstResult = JSON.parse(await invoke([
				"create", "initiative", "--title", "Route to first", "--json"
			]));
			expect(firstResult.id).toBe("first-entity-1");

			expect(await invoke(["auth", "switch"])).toContain("Switched to saved login second.");
			expect(await invoke(["auth", "switch"])).toContain("Switched to saved login local.");
			expect(await invoke(["auth", "switch", "second"])).toContain("Switched to saved login second.");
			const secondResult = JSON.parse(await invoke([
				"create", "initiative", "--title", "Route to second", "--json"
			]));
			expect(secondResult.id).toBe("second-entity-1");

			const projectIdentity = path.basename(projectDirectory).toLowerCase();
			expect(first.requests).toEqual([{
				authorization: `Bearer token-for-${first.tenantId}`,
				method: "createEntity",
				projectIdentity
			}]);
			expect(second.requests).toEqual([{
				authorization: `Bearer token-for-${second.tenantId}`,
				method: "createEntity",
				projectIdentity
			}]);

			const logout = JSON.parse(await invoke(["auth", "logout", "--json"]));
			expect(logout).toMatchObject({ command: "auth-logout", name: "second" });
			expect(await invoke(["auth", "status"])).toBe("Active saved login: local\nDestination: local\n");
		} finally {
			await Promise.allSettled([first.close(), second.close()]);
		}
	});
});