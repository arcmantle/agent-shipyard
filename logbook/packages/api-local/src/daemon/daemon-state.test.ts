import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDaemonState, clearDaemonStateIfOwned, readDaemonState, saveDaemonState } from "./daemon-state.js";

describe("daemon state file (ISS189)", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-state-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("saves a daemon state and reads it back", () => {
		saveDaemonState({ pid: 12345, port: 4123 }, { homeDirectory });

		expect(readDaemonState({ homeDirectory })).toEqual({ pid: 12345, port: 4123 });
	});

	it("returns undefined when no state has ever been saved", () => {
		expect(readDaemonState({ homeDirectory })).toBeUndefined();
	});

	it("returns undefined after the state has been cleared", () => {
		saveDaemonState({ pid: 12345, port: 4123 }, { homeDirectory });

		clearDaemonState({ homeDirectory });

		expect(readDaemonState({ homeDirectory })).toBeUndefined();
	});

	it("does not throw when clearing state that was never saved", () => {
		expect(() => clearDaemonState({ homeDirectory })).not.toThrow();
	});

	it("clears state only when the caller still owns the daemon slot", () => {
		saveDaemonState({ pid: 42, port: 1234 }, { homeDirectory });

		expect(clearDaemonStateIfOwned(41, { homeDirectory })).toBe(false);
		expect(readDaemonState({ homeDirectory })).toEqual({ pid: 42, port: 1234 });
		expect(clearDaemonStateIfOwned(42, { homeDirectory })).toBe(true);
		expect(readDaemonState({ homeDirectory })).toBeUndefined();
	});

	it("treats a corrupt state file as absent rather than throwing", () => {
		mkdirSync(homeDirectory, { recursive: true });
		writeFileSync(path.join(homeDirectory, "daemon.json"), "{ not valid json", "utf8");

		expect(readDaemonState({ homeDirectory })).toBeUndefined();
	});

	it("treats a state file missing required fields as absent rather than throwing", () => {
		mkdirSync(homeDirectory, { recursive: true });
		writeFileSync(path.join(homeDirectory, "daemon.json"), JSON.stringify({ pid: 123 }), "utf8");

		expect(readDaemonState({ homeDirectory })).toBeUndefined();
	});

	it("overwrites a prior saved state with the latest one", () => {
		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory });
		saveDaemonState({ pid: 222, port: 2222 }, { homeDirectory });

		expect(readDaemonState({ homeDirectory })).toEqual({ pid: 222, port: 2222 });
	});

	it("never touches the real ~/.agent-issues home directory in tests (uses the injected homeDirectory)", () => {
		saveDaemonState({ pid: 1, port: 1 }, { homeDirectory });

		expect(existsSync(homeDirectory)).toBe(true);
	});
});

describe("daemon state file keyed per db path (ISS192)", () => {
	let homeDirectory: string;

	beforeEach(() => {
		homeDirectory = mkdtempSync(path.join(tmpdir(), "agent-issues-daemon-state-per-db-"));
	});

	afterEach(() => {
		rmSync(homeDirectory, { recursive: true, force: true });
	});

	it("keeps two different db paths' saved state fully separate", () => {
		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory, dbPath: "/tmp/repo-a.db" });
		saveDaemonState({ pid: 222, port: 2222 }, { homeDirectory, dbPath: "/tmp/repo-b.db" });

		expect(readDaemonState({ homeDirectory, dbPath: "/tmp/repo-a.db" })).toEqual({ pid: 111, port: 1111 });
		expect(readDaemonState({ homeDirectory, dbPath: "/tmp/repo-b.db" })).toEqual({ pid: 222, port: 2222 });
	});

	it("reuses the same state for the same db path across separate calls", () => {
		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory, dbPath: "/tmp/repo-a.db" });

		expect(readDaemonState({ homeDirectory, dbPath: "/tmp/repo-a.db" })).toEqual({ pid: 111, port: 1111 });
	});

	it("clearing one db path's state does not affect another db path's state", () => {
		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory, dbPath: "/tmp/repo-a.db" });
		saveDaemonState({ pid: 222, port: 2222 }, { homeDirectory, dbPath: "/tmp/repo-b.db" });

		clearDaemonState({ homeDirectory, dbPath: "/tmp/repo-a.db" });

		expect(readDaemonState({ homeDirectory, dbPath: "/tmp/repo-a.db" })).toBeUndefined();
		expect(readDaemonState({ homeDirectory, dbPath: "/tmp/repo-b.db" })).toEqual({ pid: 222, port: 2222 });
	});

	it("treats a relative and its equivalent absolute db path as the same slot", () => {
		const relativeDbPath = path.relative(process.cwd(), path.join(homeDirectory, "repo-a.db"));
		const absoluteDbPath = path.resolve(relativeDbPath);

		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory, dbPath: absoluteDbPath });

		expect(readDaemonState({ homeDirectory, dbPath: relativeDbPath })).toEqual({ pid: 111, port: 1111 });
	});

	it("falls back to the same default slot as an omitted dbPath when no dbPath is given (unchanged single-db behavior)", () => {
		saveDaemonState({ pid: 111, port: 1111 }, { homeDirectory });

		expect(readDaemonState({ homeDirectory })).toEqual({ pid: 111, port: 1111 });
	});
});
