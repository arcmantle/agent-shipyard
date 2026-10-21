import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { RunCredentialCommand } from "@agent-issues/core";
import { saveSavedLogin, type SavedLoginStoreOptions } from "../../auth/auth-session.js";
import { runCli } from "../index.js";

let tempDirectory: string | undefined;

function createTempDirectory(): string {
	tempDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-sql-command-"));
	return tempDirectory;
}

function createCapture() {
	const stream = new PassThrough();
	let text = "";
	stream.on("data", (chunk) => {
		text += chunk.toString();
	});
	return { stream, read: () => text };
}

function fakeCredentialStore(): SavedLoginStoreOptions {
	const store = new Map<string, string>();
	const runCommand: RunCredentialCommand = async (command) => {
		const [action, , account, , service] = command.args;
		const key = `${service}:${account}`;

		if (action === "add-generic-password") {
			store.set(key, command.args[6]);
			return { exitCode: 0, stdout: "" };
		}
		if (action === "find-generic-password") {
			const value = store.get(key);
			return value === undefined ? { exitCode: 44, stdout: "" } : { exitCode: 0, stdout: `${value}\n` };
		}

		store.delete(key);
		return { exitCode: 0, stdout: "" };
	};
	return { platform: "darwin", runCommand };
}

afterEach(() => {
	if (tempDirectory) {
		rmSync(tempDirectory, { force: true, recursive: true });
		tempDirectory = undefined;
	}
});

describe("sql command", () => {
	it("runs a query against the active local SQLite database", async () => {
		const root = createTempDirectory();
		const output = createCapture();

		expect(await runCli(["sql", "SELECT 1 AS value", "--db", path.join(root, "agent-issues.db"), "--json"], {
			credentialStoreOptions: fakeCredentialStore(),
			cwd: root,
			stderr: createCapture().stream,
			stdout: output.stream
		})).toBe(0);

		expect(JSON.parse(output.read())).toEqual({ rows: [{ value: 1 }] });
	});

	it("requires a SQL statement", async () => {
		const root = createTempDirectory();

		await expect(runCli(["sql"], {
			credentialStoreOptions: fakeCredentialStore(),
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		})).rejects.toThrow("Missing argument. Usage: sql <statement>");
	});

	it("does not allow writes to the local SQLite database", async () => {
		const root = createTempDirectory();

		await expect(runCli(["sql", "DELETE FROM entities RETURNING id", "--db", path.join(root, "agent-issues.db")], {
			credentialStoreOptions: fakeCredentialStore(),
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		})).rejects.toThrow(/readonly database/);
	});

	it("rejects a direct SQL query when a remote saved login is active", async () => {
		const root = createTempDirectory();
		const credentialStoreOptions = fakeCredentialStore();
		await saveSavedLogin({
			accessToken: "token-a",
			expiresAt: "2099-01-01T00:00:00.000Z",
			kind: "remote",
			name: "work",
			serviceUrl: "https://api.example.com",
			tenantId: "tenant-a",
			userId: "user-a"
		}, credentialStoreOptions);

		await expect(runCli(["sql", "SELECT 1"], {
			credentialStoreOptions,
			cwd: root,
			stderr: createCapture().stream,
			stdout: createCapture().stream
		})).rejects.toThrow("Direct SQL is available only when the active saved login is local");
	});
});