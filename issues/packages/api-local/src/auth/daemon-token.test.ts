import { describe, expect, it } from "vitest";

import type { CredentialCommand, RunCredentialCommand } from "@agent-issues/core";
import { clearDaemonToken, mintDaemonToken, readDaemonToken, saveDaemonToken } from "./daemon-token.js";

/** Fake in-memory credential store standing in for a real OS credential tool, keyed the same way `os-credential-store.ts` addresses a real one. */
function fakeCredentialStore(): { runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();

	const runCommand: RunCredentialCommand = async (command: CredentialCommand) => {
		const [, , account, , service] = command.args; // <action> "-a" <account> "-s" <service> ...
		const key = `${service}:${account}`;

		if (command.args[0] === "add-generic-password") {
			store.set(key, command.args[6]);
			return { stdout: "", exitCode: 0 };
		}
		if (command.args[0] === "find-generic-password") {
			const value = store.get(key);
			return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
		}
		// delete-generic-password
		const existed = store.delete(key);
		return { stdout: "", exitCode: existed ? 0 : 44 };
	};

	return { runCommand };
}

describe("daemon token (ISS184)", () => {
	it("mints a token that looks like a long random hex string", () => {
		const token = mintDaemonToken();

		expect(token).toMatch(/^[0-9a-f]{48,}$/);
	});

	it("mints a different token on every call", () => {
		expect(mintDaemonToken()).not.toBe(mintDaemonToken());
	});

	it("saves a token and reads it back via the OS credential store", async () => {
		const { runCommand } = fakeCredentialStore();
		const options = { platform: "darwin" as const, runCommand };

		await saveDaemonToken("my-daemon-token", options);

		await expect(readDaemonToken(options)).resolves.toBe("my-daemon-token");
	});

	it("keeps tokens for different database daemon slots independent", async () => {
		const { runCommand } = fakeCredentialStore();
		const sharedOptions = { platform: "darwin" as const, runCommand };
		const firstOptions = { ...sharedOptions, dbPath: "/tmp/first.db" };
		const secondOptions = { ...sharedOptions, dbPath: "/tmp/second.db" };

		await saveDaemonToken("first-token", firstOptions);
		await saveDaemonToken("second-token", secondOptions);

		await expect(readDaemonToken(firstOptions)).resolves.toBe("first-token");
		await expect(readDaemonToken(secondOptions)).resolves.toBe("second-token");
		await clearDaemonToken(firstOptions);
		await expect(readDaemonToken(firstOptions)).resolves.toBeUndefined();
		await expect(readDaemonToken(secondOptions)).resolves.toBe("second-token");
	});

	it("returns undefined when no token has ever been saved", async () => {
		const { runCommand } = fakeCredentialStore();

		await expect(readDaemonToken({ platform: "darwin", runCommand })).resolves.toBeUndefined();
	});

	it("returns undefined after the token has been cleared", async () => {
		const { runCommand } = fakeCredentialStore();
		const options = { platform: "darwin" as const, runCommand };

		await saveDaemonToken("my-daemon-token", options);
		await clearDaemonToken(options);

		await expect(readDaemonToken(options)).resolves.toBeUndefined();
	});

	it("does not throw when clearing a token that was never saved", async () => {
		const { runCommand } = fakeCredentialStore();

		await expect(clearDaemonToken({ platform: "darwin", runCommand })).resolves.toBeUndefined();
	});
});
