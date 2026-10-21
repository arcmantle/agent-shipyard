import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { deleteCredential, getCredential, setCredential, type RunCredentialCommand } from "./os-credential-store.js";

const execFileAsync = promisify(execFile);

describe("os-credential-store dispatch (ISS184)", () => {
	function recordingRunner(): { runCommand: RunCredentialCommand; calls: Array<{ file: string; args: string[]; input?: string; windowsHide?: boolean }> } {
		const calls: Array<{ file: string; args: string[]; input?: string; windowsHide?: boolean }> = [];
		const runCommand: RunCredentialCommand = async (command) => {
			calls.push(command);
			return { stdout: "", exitCode: 0 };
		};
		return { runCommand, calls };
	}

	it("shells out to macOS `security` to store a credential", async () => {
		const { runCommand, calls } = recordingRunner();

		await setCredential("agent-issues-daemon", "local-daemon-token", "s3cr3t", { platform: "darwin", runCommand });

		expect(calls).toEqual([
			{
				file: "security",
				args: ["add-generic-password", "-a", "local-daemon-token", "-s", "agent-issues-daemon", "-w", "s3cr3t", "-U"]
			}
		]);
	});

	it("shells out to Linux `secret-tool` to store a credential, piping the secret via stdin", async () => {
		const { runCommand, calls } = recordingRunner();

		await setCredential("agent-issues-daemon", "local-daemon-token", "s3cr3t", { platform: "linux", runCommand });

		expect(calls).toEqual([
			{
				file: "secret-tool",
				args: ["store", "--label", "agent-issues-daemon (local-daemon-token)", "service", "agent-issues-daemon", "account", "local-daemon-token"],
				input: "s3cr3t"
			}
		]);
	});

	it("hides PowerShell for every Windows credential operation", async () => {
		const { runCommand, calls } = recordingRunner();

		await setCredential("agent-issues-daemon", "local-daemon-token", "s3cr3t", { platform: "win32", runCommand });
		await getCredential("agent-issues-daemon", "local-daemon-token", { platform: "win32", runCommand });
		await deleteCredential("agent-issues-daemon", "local-daemon-token", { platform: "win32", runCommand });

		expect(calls).toHaveLength(3);
		expect(calls[0].file).toBe("powershell.exe");
		expect(calls[0].args).toContain("-EncodedCommand");
		expect(calls.every(({ windowsHide }) => windowsHide === true)).toBe(true);
	});

	it("reads back a stored credential via the injected runner", async () => {
		const runCommand: RunCredentialCommand = async () => ({ stdout: "s3cr3t\n", exitCode: 0 });

		await expect(getCredential("agent-issues-daemon", "local-daemon-token", { platform: "darwin", runCommand })).resolves.toBe("s3cr3t");
	});

	it("resolves undefined when the credential does not exist (macOS exit code 44)", async () => {
		const runCommand: RunCredentialCommand = async () => ({ stdout: "", exitCode: 44 });

		await expect(getCredential("agent-issues-daemon", "local-daemon-token", { platform: "darwin", runCommand })).resolves.toBeUndefined();
	});

	it("does not throw when deleting a credential that does not exist", async () => {
		const runCommand: RunCredentialCommand = async () => ({ stdout: "", exitCode: 44 });

		await expect(deleteCredential("agent-issues-daemon", "local-daemon-token", { platform: "darwin", runCommand })).resolves.toBeUndefined();
	});

	it("throws a clear, actionable error when the platform's credential tool binary is missing", async () => {
		const runCommand: RunCredentialCommand = async () => {
			const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		};

		await expect(getCredential("agent-issues-daemon", "local-daemon-token", { platform: "linux", runCommand })).rejects.toThrow(
			/secret-tool.*not (found|available|installed)/i
		);
	});

	it("throws when the tool exits non-zero for a reason other than not-found", async () => {
		const runCommand: RunCredentialCommand = async () => ({ stdout: "", exitCode: 1, stderr: "keychain locked" });

		await expect(setCredential("agent-issues-daemon", "local-daemon-token", "s3cr3t", { platform: "darwin", runCommand })).rejects.toThrow(
			/keychain locked/
		);
	});
});

describe("os-credential-store real macOS keychain round trip (ISS184)", () => {
	// Scoped to a throwaway temp keychain (never the user's real login keychain) so this
	// integration test cannot disrupt real credentials or depend on a keychain being unlocked.
	const runningOnDarwin = process.platform === "darwin";
	let keychainPath: string;

	afterEach(async () => {
		if (!runningOnDarwin) return;
		await execFileAsync("security", ["delete-keychain", keychainPath]).catch(() => undefined);
		rmSync(keychainPath, { force: true });
	});

	it.runIf(runningOnDarwin)("stores, reads, and deletes a real credential in an isolated temp keychain", async () => {
		keychainPath = path.join("/tmp", `agent-issues-test-${randomUUID()}.keychain-db`);
		await execFileAsync("security", ["create-keychain", "-p", randomUUID(), keychainPath]);

		const service = "agent-issues-daemon-test";
		const account = `local-daemon-token-${randomUUID()}`;

		await setCredential(service, account, "real-secret-value", { darwinKeychainPath: keychainPath });
		await expect(getCredential(service, account, { darwinKeychainPath: keychainPath })).resolves.toBe("real-secret-value");

		await deleteCredential(service, account, { darwinKeychainPath: keychainPath });
		await expect(getCredential(service, account, { darwinKeychainPath: keychainPath })).resolves.toBeUndefined();
	});
});
