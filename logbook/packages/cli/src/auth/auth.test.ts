import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";
import { performRemoteLogin, type DeviceCodeLoginFn } from "../cli/commands/auth.js";
import {
	getActiveSavedLogin,
	listSavedLogins,
	saveSavedLogin,
	setActiveSavedLogin,
	type SavedLoginStoreOptions
} from "./auth-session.js";
import type { RunCredentialCommand } from "@agent-issues/core";

/** Fake in-memory credential store, mirroring `daemon-token.test.ts`'s helper, so this suite never shells out to a real native OS credential tool. */
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

function fakeDeviceCodeLogin(result: {
	tenantId: string;
	userId: string;
	displayName?: string;
	accessToken: string;
	expiresAt: string;
}): DeviceCodeLoginFn {
	return async () => result;
}

describe("performRemoteLogin", () => {
	it("discovers Entra configuration and saves a complete active remote login", async () => {
		const options: SavedLoginStoreOptions = {
			homeDirectory: `/tmp/does-not-matter-${Math.random()}`,
			...fakeCredentialStore()
		};
		const fetch = async () => new Response(
			JSON.stringify({ auth: { provider: "entra", tenantId: "discovered-tenant", clientId: "discovered-client" } }),
			{ status: 200 }
		);
		const deviceCodeLogin = vi.fn(fakeDeviceCodeLogin({
			tenantId: "resolved-tenant",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		}));

		const login = await performRemoteLogin(
			{ name: "work", serviceUrl: " HTTPS://API.Example.com/// " },
			{ deviceCodeLogin, fetch, onDeviceCode: () => {}, storeOptions: options }
		);

		expect(deviceCodeLogin).toHaveBeenCalledWith({
			tenantId: "discovered-tenant",
			clientId: "discovered-client",
			onDeviceCode: expect.any(Function)
		});
		expect(login).toEqual({
			name: "work",
			kind: "remote",
			serviceUrl: "https://api.example.com",
			tenantId: "resolved-tenant",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		await expect(getActiveSavedLogin(options)).resolves.toEqual(login);
	});

	it("refreshes an existing name without changing saved-login order", async () => {
		const options: SavedLoginStoreOptions = {
			homeDirectory: `/tmp/does-not-matter-${Math.random()}`,
			...fakeCredentialStore()
		};
		await saveSavedLogin({
			name: "work",
			kind: "remote",
			serviceUrl: "https://old.example.com",
			tenantId: "old-tenant",
			userId: "old-user",
			accessToken: "old-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		}, options);
		await saveSavedLogin({
			name: "personal",
			kind: "remote",
			serviceUrl: "https://personal.example.com",
			tenantId: "personal-tenant",
			userId: "personal-user",
			accessToken: "personal-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		}, options);

		await performRemoteLogin(
			{ name: "work", serviceUrl: "https://new.example.com" },
			{
				deviceCodeLogin: fakeDeviceCodeLogin({
					tenantId: "new-tenant",
					userId: "new-user",
					accessToken: "new-token",
					expiresAt: "2099-02-01T00:00:00.000Z"
				}),
				fetch: async () => new Response(JSON.stringify({
					auth: { provider: "entra", tenantId: "discovered-tenant", clientId: "discovered-client" }
				})),
				onDeviceCode: () => {},
				storeOptions: options
			}
		);

		expect((await listSavedLogins(options)).map(({ name }) => name)).toEqual(["local", "work", "personal"]);
		await expect(getActiveSavedLogin(options)).resolves.toMatchObject({
			name: "work",
			serviceUrl: "https://new.example.com",
			accessToken: "new-token"
		});
	});

	it("rejects the permanent local name before discovery or device login", async () => {
		const fetch = vi.fn();
		const deviceCodeLogin = vi.fn();

		await expect(performRemoteLogin(
			{ name: "local", serviceUrl: "https://api.example.com" },
			{ deviceCodeLogin, fetch, onDeviceCode: () => {} }
		)).rejects.toThrow('Saved-login name "local" is reserved.');
		expect(fetch).not.toHaveBeenCalled();
		expect(deviceCodeLogin).not.toHaveBeenCalled();
	});
});

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

describe("auth CLI commands", () => {
	let homeDirectory: string;
	let originalHome: string | undefined;
	let credentialStoreOptions: SavedLoginStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-cli-"));
		originalHome = process.env.HOME;
		process.env.HOME = homeDirectory;
		credentialStoreOptions = fakeCredentialStore();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		rmSync(homeDirectory, { force: true, recursive: true });
	});

	it("reports the built-in local saved login as active by default", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status", "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-status",
			login: { name: "local", kind: "local" }
		});
	});

	it("renders the built-in local saved login as active by default", async () => {
		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status"], { stdout: stdout.stream, stderr: stderr.stream, credentialStoreOptions });

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toBe("Active saved login: local\nDestination: local\n");
	});

	it("reports the active remote saved login without leaking the accessToken", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "status", "--json"], { stdout: stdout.stream, stderr: stderr.stream, credentialStoreOptions });

		expect(exitCode).toBe(0);
		expect(stdout.read()).not.toContain("super-secret-token");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-status",
			login: {
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				expiresAt: "2099-01-01T00:00:00.000Z"
			}
		});
	});

	it("renders the active remote destination, identity, and expiry without exposing its token", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "status"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toBe([
			"Active saved login: work",
			"Destination: remote",
			"Remote URL: https://work.example.test",
			"Identity: Ada Lovelace (tenant tenant-a)",
			"Session expires: 2099-01-01T00:00:00.000Z",
			""
		].join("\n"));
		expect(stdout.read()).not.toContain("super-secret-token");
	});

	it("lists saved logins in switching order and marks the active login without exposing tokens", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.test",
				tenantId: "tenant-b",
				userId: "user-2",
				accessToken: "another-secret-token",
				expiresAt: "2099-02-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await setActiveSavedLogin("work", credentialStoreOptions);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "list", "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).not.toContain("super-secret-token");
		expect(stdout.read()).not.toContain("another-secret-token");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-list",
			logins: [
				{ login: { name: "local", kind: "local" }, active: false },
				{
					login: {
						name: "work",
						kind: "remote",
						serviceUrl: "https://work.example.test",
						tenantId: "tenant-a",
						userId: "user-1",
						expiresAt: "2099-01-01T00:00:00.000Z"
					},
					active: true
				},
				{
					login: {
						name: "personal",
						kind: "remote",
						serviceUrl: "https://personal.example.test",
						tenantId: "tenant-b",
						userId: "user-2",
						expiresAt: "2099-02-01T00:00:00.000Z"
					},
					active: false
				}
			]
		});
	});

	it("renders saved logins in switching order with the active marker", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "list"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toBe("- local (local)\n* work (remote https://work.example.test)\n");
		expect(stdout.read()).not.toContain("super-secret-token");
	});

	it("switches directly to a named saved login without exposing its access token", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				accessToken: "super-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.test",
				tenantId: "tenant-b",
				userId: "user-2",
				accessToken: "another-secret-token",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();

		const exitCode = await runCli(["auth", "switch", "work", "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stdout.read()).not.toContain("super-secret-token");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-switch",
			login: {
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				displayName: "Ada Lovelace",
				expiresAt: "2099-01-01T00:00:00.000Z"
			}
		});
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "work" });
	});

	it("switches directly to the built-in local saved login", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "switch", "local"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Switched to saved login local.");
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("cycles from local to the first remote saved login", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.test",
				tenantId: "tenant-b",
				userId: "user-2",
				accessToken: "token-b",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await setActiveSavedLogin("local", credentialStoreOptions);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "switch"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stdout.read()).toContain("Switched to saved login work.");
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "work" });
	});

	it("cycles through remote saved logins in creation order and wraps to local", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.test",
				tenantId: "tenant-b",
				userId: "user-2",
				accessToken: "token-b",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await setActiveSavedLogin("work", credentialStoreOptions);

		expect(await runCli(["auth", "switch"], { credentialStoreOptions })).toBe(0);
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "personal" });

		expect(await runCli(["auth", "switch"], { credentialStoreOptions })).toBe(0);
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("rejects an unknown saved-login name without changing the active login", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		await expect(runCli(["auth", "switch", "unknown"], { credentialStoreOptions })).rejects.toThrow(
			'No saved login named "unknown".'
		);
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "work" });
	});

	it("logs out an inactive remote saved login without changing the active login", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.test",
				tenantId: "tenant-b",
				userId: "user-2",
				accessToken: "token-b",
				expiresAt: "2099-02-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);
		await setActiveSavedLogin("work", credentialStoreOptions);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "logout", "personal", "--json"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(JSON.parse(stdout.read())).toEqual({ command: "auth-logout", name: "personal" });
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "work" });
		expect((await listSavedLogins(credentialStoreOptions)).map(({ name }) => name)).toEqual(["local", "work"]);
	});

	it("logs out the active remote by default and atomically activates local", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		const stdout = createCapture();
		const stderr = createCapture();
		const exitCode = await runCli(["auth", "logout"], {
			stdout: stdout.stream,
			stderr: stderr.stream,
			credentialStoreOptions
		});

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(stdout.read()).toBe("Removed saved login work.\n");
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toEqual({ name: "local", kind: "local" });
		await expect(listSavedLogins(credentialStoreOptions)).resolves.toEqual([{ name: "local", kind: "local" }]);
	});

	it.each([
		["by name", ["auth", "logout", "local"]],
		["when active", ["auth", "logout"]]
	])("rejects logout of the permanent local saved login %s", async (_case, command) => {
		await expect(runCli(command, { credentialStoreOptions })).rejects.toThrow("The local saved login cannot be removed.");
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("rejects logout of an unknown saved login without changing the active login", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://work.example.test",
				tenantId: "tenant-a",
				userId: "user-1",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			credentialStoreOptions
		);

		await expect(runCli(["auth", "logout", "unknown"], { credentialStoreOptions })).rejects.toThrow(
			'No saved login named "unknown".'
		);
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({ name: "work" });
	});

	it("logs in remotely with a name and service URL without tenant or client flags", async () => {
		const stdout = createCapture();
		const stderr = createCapture();
		const fetch = vi.fn(async () => new Response(
			JSON.stringify({ auth: { provider: "entra", tenantId: "discovered-tenant", clientId: "discovered-client" } }),
			{ status: 200 }
		));
		const deviceCodeLogin = vi.fn(fakeDeviceCodeLogin({
			tenantId: "resolved-tenant",
			userId: "user-1",
			displayName: "Ada Lovelace",
			accessToken: "secret-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		}));

		const exitCode = await runCli(
			["auth", "login", "--name", "work", "--url", "HTTPS://API.Example.com///", "--json"],
			{
				authLoginDependencies: { deviceCodeLogin, fetch, interactive: false },
				credentialStoreOptions,
				stderr: stderr.stream,
				stdout: stdout.stream
			}
		);

		expect(exitCode).toBe(0);
		expect(stderr.read()).toBe("");
		expect(deviceCodeLogin).toHaveBeenCalledWith({
			tenantId: "discovered-tenant",
			clientId: "discovered-client",
			onDeviceCode: expect.any(Function)
		});
		expect(stdout.read()).not.toContain("secret-token");
		expect(JSON.parse(stdout.read())).toEqual({
			command: "auth-login",
			login: {
				name: "work",
				kind: "remote",
				serviceUrl: "https://api.example.com",
				tenantId: "resolved-tenant",
				userId: "user-1",
				displayName: "Ada Lovelace",
				expiresAt: "2099-01-01T00:00:00.000Z"
			}
		});
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({
			name: "work",
			serviceUrl: "https://api.example.com"
		});
	});

	it("requires automation-safe name and service URL arguments with --json", async () => {
		await expect(runCli(["auth", "login", "--json"], { credentialStoreOptions })).rejects.toThrow(
			/--json.*--name/
		);
		await expect(runCli(["auth", "login", "--name", "work", "--json"], { credentialStoreOptions })).rejects.toThrow(
			/--json.*--url/
		);
	});

	it("rejects positional names", async () => {
		await expect(runCli(["auth", "login", "work"], { credentialStoreOptions })).rejects.toThrow(/Extraneous positional argument/);
	});

	it("prompts for an omitted name and service URL in an interactive terminal", async () => {
		const answers = ["work", " HTTPS://API.Example.com/// "];
		const prompt = vi.fn(async () => answers.shift() ?? "");
		const fetch = vi.fn(async () => new Response(
			JSON.stringify({ auth: { provider: "entra", tenantId: "discovered-tenant", clientId: "discovered-client" } }),
			{ status: 200 }
		));
		const deviceCodeLogin = vi.fn(fakeDeviceCodeLogin({
			tenantId: "resolved-tenant",
			userId: "user-1",
			accessToken: "secret-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		}));

		const exitCode = await runCli(["auth", "login"], {
			authLoginDependencies: { deviceCodeLogin, fetch, interactive: true, prompt },
			credentialStoreOptions,
			stdout: createCapture().stream
		});

		expect(exitCode).toBe(0);
		expect(prompt).toHaveBeenNthCalledWith(1, "Saved login name: ");
		expect(prompt).toHaveBeenNthCalledWith(2, "Service URL: ");
		await expect(getActiveSavedLogin(credentialStoreOptions)).resolves.toMatchObject({
			name: "work",
			serviceUrl: "https://api.example.com"
		});
	});

	it("rejects the removed local login option and its legacy companion options", async () => {
		await expect(
			runCli(["auth", "login", "--local", "--user-id", "dev-user", "--secret", "test-secret"], { credentialStoreOptions })
		).rejects.toThrow(/Unsupported option name/);
	});
});
