import { spawn as spawnChildProcess } from "node:child_process";

/**
 * Hidden argv flag a self-respawned daemon process recognizes (ISS190): the
 * runs the daemon instead of a normal command. Exported so core and the CLI
 * entrypoint agree on the exact same literal without either hardcoding it
 * independently.
 */
export const LOCAL_DAEMON_SPAWN_FLAG = "--spawn-daemon";

/**
 * Default `spawn` for the local daemon (ISS190, ADR44): re-invokes this
 * exact running script (`process.argv[1]`) as a detached, unref'd child
 * with the hidden daemon flag appended. Core has no knowledge of which
 * package's entrypoint is actually running - it doesn't need to, since
 * "this same install, running itself again in daemon mode" always resolves
 * correctly regardless of which CLI/site-server process happened to invoke
 * it. When `dbPath` is supplied (a client requesting a different `--db`
 * than the currently-running daemon serves), it's appended so the freshly
 * spawned daemon opens that db instead of the default.
 */
export function spawnLocalDaemon(options?: { dbPath?: string; platform?: NodeJS.Platform }): void {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot spawn the local daemon: no process entrypoint (process.argv[1]) is available.");
	}

	const args = [entrypoint, LOCAL_DAEMON_SPAWN_FLAG];
	if (options?.dbPath !== undefined) {
		args.push("--db", options.dbPath);
	}

	spawnChildProcess(process.execPath, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: (options?.platform ?? process.platform) === "win32"
	}).unref();
}