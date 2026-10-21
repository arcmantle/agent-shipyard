import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getActiveSavedLogin,
	listSavedLogins,
	removeSavedLogin,
	saveSavedLogin,
	setActiveSavedLogin,
	toSavedLoginView,
	type SavedLoginStoreOptions
} from "./auth-session.js";
import { getCredential, setCredential, type CredentialCommand, type RunCredentialCommand } from "@agent-issues/core";

/** Fake in-memory credential store standing in for a real OS credential tool, keyed the same way `os-credential-store.ts` addresses a real one (mirrors `daemon-token.test.ts`'s helper). */
function fakeCredentialStore(): { runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();

	const runCommand: RunCredentialCommand = async (command: CredentialCommand) => {
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
		// delete-generic-password
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
	};

	return { runCommand };
}

describe("auth-session storage (ISS185)", () => {
	let homeDirectory: string;
	let options: SavedLoginStoreOptions;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-auth-session-"));
		options = { homeDirectory, platform: "darwin", ...fakeCredentialStore() };
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("synthesizes local as the first and active saved login by default", async () => {
		await expect(listSavedLogins(options)).resolves.toEqual([{ name: "local", kind: "local" }]);
		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("rejects activating an unknown saved-login name without changing the active login", async () => {
		await expect(setActiveSavedLogin("missing", options)).rejects.toThrow(/No saved login named/);
		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("lists uniquely named remote logins in creation order even when they share a service URL", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://agent-issues.example.com",
				tenantId: "tenant-a",
				userId: "user-a",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			options
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://agent-issues.example.com",
				tenantId: "tenant-b",
				userId: "user-b",
				accessToken: "token-b",
				expiresAt: "2099-01-02T00:00:00.000Z"
			},
			options
		);

		expect((await listSavedLogins(options)).map(({ name }) => name)).toEqual(["local", "work", "personal"]);
	});

	it("persists exactly one globally active saved-login name", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://agent-issues.example.com",
				tenantId: "tenant-a",
				userId: "user-a",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			options
		);
		await expect(getActiveSavedLogin(options)).resolves.toMatchObject({ name: "work", kind: "remote" });

		await setActiveSavedLogin("local", options);

		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("rejects local as a remote saved-login name", async () => {
		await expect(
			saveSavedLogin(
				{
					name: "local",
					kind: "remote",
					serviceUrl: "https://agent-issues.example.com",
					tenantId: "tenant-a",
					userId: "user-a",
					accessToken: "token-a",
					expiresAt: "2099-01-01T00:00:00.000Z"
				},
				options
			)
		).rejects.toThrow(/reserved/);
		await expect(listSavedLogins(options)).resolves.toEqual([{ name: "local", kind: "local" }]);
	});

	it("rejects removing the permanent local login", async () => {
		await expect(removeSavedLogin("local", options)).rejects.toThrow(/cannot be removed/);
		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
	});

	it("falls back to local when the active remote login is removed", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://agent-issues.example.com",
				tenantId: "tenant-a",
				userId: "user-a",
				accessToken: "token-a",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			options
		);

		await removeSavedLogin("work", options);

		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
		await expect(listSavedLogins(options)).resolves.toEqual([{ name: "local", kind: "local" }]);
	});

	it("refreshes an existing remote name without changing its order", async () => {
		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://old.example.com",
				tenantId: "tenant-old",
				userId: "user-old",
				accessToken: "token-old",
				expiresAt: "2099-01-01T00:00:00.000Z"
			},
			options
		);
		await saveSavedLogin(
			{
				name: "personal",
				kind: "remote",
				serviceUrl: "https://personal.example.com",
				tenantId: "tenant-personal",
				userId: "user-personal",
				accessToken: "token-personal",
				expiresAt: "2099-01-02T00:00:00.000Z"
			},
			options
		);

		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://new.example.com",
				tenantId: "tenant-new",
				userId: "user-new",
				displayName: "Ada Lovelace",
				accessToken: "token-new",
				expiresAt: "2099-02-01T00:00:00.000Z"
			},
			options
		);

		const logins = await listSavedLogins(options);
		expect(logins.map(({ name }) => name)).toEqual(["local", "work", "personal"]);
		expect(logins[1]).toEqual({
			name: "work",
			kind: "remote",
			serviceUrl: "https://new.example.com",
			tenantId: "tenant-new",
			userId: "user-new",
			displayName: "Ada Lovelace",
			accessToken: "token-new",
			expiresAt: "2099-02-01T00:00:00.000Z"
		});
	});

	it("redacts access tokens from printable saved-login views", () => {
		const view = toSavedLoginView({
			name: "work",
			kind: "remote",
			serviceUrl: "https://agent-issues.example.com",
			tenantId: "tenant-a",
			userId: "user-a",
			displayName: "Ada Lovelace",
			accessToken: "super-secret-token",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});

		expect(view).toEqual({
			name: "work",
			kind: "remote",
			serviceUrl: "https://agent-issues.example.com",
			tenantId: "tenant-a",
			userId: "user-a",
			displayName: "Ada Lovelace",
			expiresAt: "2099-01-01T00:00:00.000Z"
		});
		expect(view).not.toHaveProperty("accessToken");
	});

	it("scrubs legacy routing state to a versioned local login exactly once", async () => {
		const legacyAuthFilePath = path.join(homeDirectory, "auth.json");
		const legacyBindingsFilePath = path.join(homeDirectory, "cloud-bindings.json");
		writeFileSync(legacyAuthFilePath, JSON.stringify({ accessToken: "plain-auth-secret" }), "utf8");
		writeFileSync(legacyBindingsFilePath, JSON.stringify({ project: { accessToken: "plain-binding-secret" } }), "utf8");
		await setCredential(
			"agent-issues-auth",
			"sessions",
			JSON.stringify({
				currentTenantId: "tenant-a",
				sessions: {
					"tenant-a": {
						tenantId: "tenant-a",
						userId: "user-a",
						accessToken: "credential-secret",
						expiresAt: "2099-01-01T00:00:00.000Z"
					}
				}
			}),
			options
		);

		await expect(getActiveSavedLogin(options)).resolves.toEqual({ name: "local", kind: "local" });
		expect(existsSync(legacyAuthFilePath)).toBe(false);
		expect(existsSync(legacyBindingsFilePath)).toBe(false);

		const migratedCredential = await getCredential("agent-issues-auth", "sessions", options);
		expect(JSON.parse(migratedCredential ?? "null")).toEqual({ version: 1, activeName: "local", remoteLogins: [] });
		expect(migratedCredential).not.toContain("credential-secret");

		await saveSavedLogin(
			{
				name: "work",
				kind: "remote",
				serviceUrl: "https://agent-issues.example.com",
				tenantId: "tenant-b",
				userId: "user-b",
				accessToken: "current-secret",
				expiresAt: "2099-01-02T00:00:00.000Z"
			},
			options
		);

		await expect(getActiveSavedLogin(options)).resolves.toMatchObject({ name: "work", kind: "remote" });
		expect(await getCredential("agent-issues-auth", "sessions", options)).toContain("current-secret");
	});

	it("scrubs a corrupt cached credential to the local saved login", async () => {
		await setCredential("agent-issues-auth", "sessions", "{ not valid json", options);

		await expect(listSavedLogins(options)).resolves.toEqual([{ name: "local", kind: "local" }]);
		expect(JSON.parse((await getCredential("agent-issues-auth", "sessions", options)) ?? "null")).toEqual({
			version: 1,
			activeName: "local",
			remoteLogins: []
		});
	});
});
