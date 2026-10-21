import { createLocalDaemonServer, type LocalDaemonServerHandle, type LocalDaemonServerOptions } from "@agent-issues/api-local";
import type { InstructionBundle } from "@agent-issues/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInstructionVersion } from "../runtime/instruction-version.js";

/**
 * Parses an optional `--db <path>` out of argv (appended by `spawnLocalDaemon`
 * when a client requested a different db than the currently-running daemon
 * serves, ISS190) so a respawned daemon opens the newly-requested db from its
 * very first request instead of the default.
 */
function parseDbPathArg(argv: string[]): string | undefined {
	const flagIndex = argv.indexOf("--db");
	if (flagIndex === -1) return undefined;
	return argv[flagIndex + 1];
}

/**
 * The real entrypoint a self-respawned daemon process runs (ISS190,
 * ADR44): `spawnLocalDaemon` (`local-daemon-store.ts`) re-invokes this same
 * installed CLI with a hidden flag, and `cli.ts` recognizes that flag and
 * calls this instead of dispatching a normal command. `createLocalDaemonServer`
 * itself lives in `@agent-issues/api-local` - the daemon server implementation,
 * not the CLI's own concern. No `authProvider` override, so the daemon mints
 * and persists its own token (ISS184); no explicit `buildHash`, so it reads
 * its own `dist/build-info.json` (ISS188). The process stays alive because
 * the daemon's own listening HTTP server keeps the event loop open - it only
 * exits via the daemon's own idle-timeout or version/db-path-mismatch
 * drain-then-exit.
 */
export function runDaemonProcess(options: Pick<LocalDaemonServerOptions, "credentialStoreOptions" | "homeDirectory" | "idleTimeoutMs"> = {}): LocalDaemonServerHandle {
	const directory = path.dirname(fileURLToPath(import.meta.url));
	const distDirectory = path.basename(directory) === "dist" ? directory : path.resolve(directory, "../../dist");
	const instructionBundle = JSON.parse(readFileSync(path.join(distDirectory, "plugin/instruction-defaults.json"), "utf8")) as InstructionBundle;
	if (instructionBundle.version !== getInstructionVersion()) {
		throw new Error(`Official instruction bundle does not match CLI instruction version: ${getInstructionVersion()}`);
	}
	return createLocalDaemonServer({ ...options, dbPath: parseDbPathArg(process.argv), instructionBundle });
}
