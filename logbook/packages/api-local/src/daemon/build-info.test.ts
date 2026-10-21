import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeBuildContentHash, readBuildContentHash, writeBuildInfoFile } from "./build-info.js";

describe("build-info (ISS188, ADR45)", () => {
	let distDir: string;

	beforeEach(() => {
		distDir = mkdtempSync(path.join(tmpdir(), "agent-issues-build-info-"));
		writeFileSync(path.join(distDir, "cli.js"), "console.log('hello');\n");
		mkdirSync(path.join(distDir, "daemon"));
		writeFileSync(path.join(distDir, "daemon", "local-daemon-server.js"), "export const x = 1;\n");
	});

	afterEach(() => {
		rmSync(distDir, { recursive: true, force: true });
	});

	it("computes the same hash for the same dist contents", () => {
		expect(computeBuildContentHash(distDir)).toBe(computeBuildContentHash(distDir));
	});

	it("computes a different hash when a file's content changes", () => {
		const before = computeBuildContentHash(distDir);
		writeFileSync(path.join(distDir, "cli.js"), "console.log('changed');\n");

		expect(computeBuildContentHash(distDir)).not.toBe(before);
	});

	it("computes a different hash when a file is added", () => {
		const before = computeBuildContentHash(distDir);
		writeFileSync(path.join(distDir, "new-file.js"), "export const y = 2;\n");

		expect(computeBuildContentHash(distDir)).not.toBe(before);
	});

	it("ignores an existing build-info.json when computing the hash, so writing it is idempotent", () => {
		const before = computeBuildContentHash(distDir);
		writeBuildInfoFile(distDir);

		expect(computeBuildContentHash(distDir)).toBe(before);
	});

	it("writes a build-info.json carrying the computed hash", () => {
		writeBuildInfoFile(distDir);

		const written = JSON.parse(readFileSync(path.join(distDir, "build-info.json"), "utf8"));
		expect(written).toEqual({ buildHash: computeBuildContentHash(distDir) });
	});

	it("reads back the hash written by writeBuildInfoFile", () => {
		writeBuildInfoFile(distDir);

		expect(readBuildContentHash({ distDir })).toBe(computeBuildContentHash(distDir));
	});

	it("returns a stable placeholder when no build-info.json exists yet (e.g. running from source)", () => {
		expect(readBuildContentHash({ distDir })).toBe("dev");
	});
});
