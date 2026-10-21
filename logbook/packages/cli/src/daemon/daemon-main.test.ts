import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readBuildContentHash, readDaemonToken } from "@agent-issues/api-local";
import { HttpStore, resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { runDaemonProcess } from "./daemon-main.js";

it("starts the CLI daemon with token auth and imports its selected bundle into the database", async () => {
	const { version } = JSON.parse(readFileSync(new URL("../../dist/plugin/instruction-defaults.json", import.meta.url), "utf8")) as { version: string };
	vi.stubGlobal("__AGENT_ISSUES_INSTRUCTION_VERSION__", version);
	const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-entrypoint-"));
	const dbPath = path.join(directory, "instructions.db");
	const credentials = new Map<string, string>();
	const runCommand: RunCredentialCommand = async (command) => {
		const [action, , account, , service] = command.args;
		const key = `${service}:${account}`;
		if (action === "add-generic-password") {
			credentials.set(key, command.args[6]);
			return { stdout: "", exitCode: 0 };
		}
		if (action === "find-generic-password") {
			const value = credentials.get(key);
			return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: value, exitCode: 0 };
		}
		credentials.delete(key);
		return { stdout: "", exitCode: 0 };
	};
	const credentialStoreOptions = { platform: "darwin" as const, runCommand };
	const originalArgv = process.argv;
	process.argv = [...originalArgv.slice(0, 2), "--spawn-daemon", "--db", dbPath];
	const handle = runDaemonProcess({ credentialStoreOptions, homeDirectory: directory, idleTimeoutMs: 0 });
	try {
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const bearerToken = await readDaemonToken({ ...credentialStoreOptions, dbPath });
		expect(bearerToken).toBeTruthy();
		const address = handle.server.address() as AddressInfo;
		const client = new HttpStore({ baseUrl: `http://127.0.0.1:${address.port}`, bearerToken: bearerToken!, tenantId: resolveWellKnownLocalTenantId(), buildHash: readBuildContentHash(), dbPath });
		expect(await client.retrieveInstruction({ version, key: "skill/prepare" })).toMatchObject({
			version, body: expect.stringContaining("# Prepare"), source: { type: "default", revision: 1 }
		});
	} finally {
		process.argv = originalArgv;
		await handle.close();
		rmSync(directory, { recursive: true, force: true });
		vi.unstubAllGlobals();
	}
});
