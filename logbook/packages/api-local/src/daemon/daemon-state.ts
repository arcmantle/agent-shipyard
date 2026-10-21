import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentIssuesHomeDirectory, resolveDefaultDatabasePath } from "@agent-issues/core";

/** Discovery record for an already-running local daemon (ADR44). */
export type DaemonState = {
	pid: number;
	port: number;
};

export type DaemonStateStoreOptions = {
	/**
	 * Overrides the directory the state file lives under. Production
	 * defaults to `resolveAgentIssuesHomeDirectory()` (`~/.agent-issues`);
	 * tests inject a temp directory so no real user state is touched.
	 */
	homeDirectory?: string;
	/**
	 * The db path this discovery record's daemon fronts (ISS192), so
	 * different `--db` targets each get their own state/lock slot instead
	 * of colliding on one machine-wide file. Omitted (or a path that
	 * resolves to the same absolute path as the default db) keys to the
	 * same well-known slot every prior version of this file used, so the
	 * common single-db case is unaffected.
	 */
	dbPath?: string;
};

/**
 * Turns a (possibly relative, possibly omitted) db path into a stable
 * filename suffix so two different db paths never collide on the same
 * discovery slot, while the default db path keeps its original plain
 * filename unchanged (ISS192). Shared with `daemon-lifecycle.ts`'s spawn
 * lock so the state file and its lock always agree on which slot a given
 * db path maps to.
 */
export function resolveDaemonSlotKey(dbPath?: string): string {
	const resolved = path.resolve(dbPath ?? resolveDefaultDatabasePath());
	const defaultResolved = path.resolve(resolveDefaultDatabasePath());
	if (resolved === defaultResolved) return "default";

	return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

/**
 * Resolves a per-db-path-keyed filename under `homeDirectory` for a given
 * `filenamePrefix`/`extension` pair (e.g. `daemon`/`.json` for the state
 * file, `daemon`/`.lock` for the spawn lock) - exported so
 * `daemon-lifecycle.ts`'s spawn lock resolves to the exact same slot this
 * module's state file does for a given db path.
 */
export function resolveDaemonFilePath(filenamePrefix: string, extension: string, options?: DaemonStateStoreOptions): string {
	const homeDirectory = options?.homeDirectory ?? resolveAgentIssuesHomeDirectory();
	const key = resolveDaemonSlotKey(options?.dbPath);
	const filename = key === "default" ? `${filenamePrefix}${extension}` : `${filenamePrefix}-${key}${extension}`;
	return path.join(homeDirectory, filename);
}

function resolveDaemonStateFilePath(options?: DaemonStateStoreOptions): string {
	return resolveDaemonFilePath("daemon", ".json", options);
}

/** Persists the currently-running daemon's discovery record. */
export function saveDaemonState(state: DaemonState, options?: DaemonStateStoreOptions): void {
	const filePath = resolveDaemonStateFilePath(options);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Reads back the last-saved daemon discovery record, or `undefined` if none
 * has ever been saved or the file is unreadable/corrupt - a missing or
 * malformed state file just means "no daemon known to be running", not an
 * error, since callers use this purely to decide whether to spawn one.
 */
export function readDaemonState(options?: DaemonStateStoreOptions): DaemonState | undefined {
	const filePath = resolveDaemonStateFilePath(options);
	if (!existsSync(filePath)) return undefined;

	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const { pid, port } = parsed as Partial<DaemonState>;
		if (typeof pid !== "number" || typeof port !== "number") return undefined;

		return { pid, port };
	} catch {
		return undefined;
	}
}

/** Removes the daemon discovery record, e.g. as part of the daemon's own idle-timeout shutdown. Safe to call even if no state file exists. */
export function clearDaemonState(options?: DaemonStateStoreOptions): void {
	const filePath = resolveDaemonStateFilePath(options);
	if (existsSync(filePath)) {
		unlinkSync(filePath);
	}
}

export function clearDaemonStateIfOwned(pid: number, options?: DaemonStateStoreOptions): boolean {
	if (readDaemonState(options)?.pid !== pid) {
		return false;
	}
	clearDaemonState(options);
	return true;
}
