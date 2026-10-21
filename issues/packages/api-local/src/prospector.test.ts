import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { calculateRepositoryVersion } from "./prospector.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createGitRepository(): string {
	const repositoryPath = mkdtempSync(path.join(tmpdir(), "agent-issues-prospector-"));
	tempDirs.push(repositoryPath);

	git(repositoryPath, "init", "--initial-branch=main");
	git(repositoryPath, "config", "user.email", "agent-issues@example.test");
	git(repositoryPath, "config", "user.name", "Agent Issues");
	writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
	git(repositoryPath, "add", "README.md");
	git(repositoryPath, "commit", "-m", "Initial commit");

	return repositoryPath;
}

function git(repositoryPath: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}

describe("calculateRepositoryVersion", () => {
	it("returns the semantic version and repository facts for a Git repository", async () => {
		const repositoryPath = createGitRepository();

		await expect(calculateRepositoryVersion(repositoryPath)).resolves.toMatchObject({
			state: "available",
			version: "0.0.1",
			branch: "main",
			currentCommit: git(repositoryPath, "rev-parse", "HEAD"),
			isTrunkBranch: true,
			commitsSinceTag: 1,
			commitBumps: { major: 0, minor: 0, patch: 0 }
		});
	});

	it("returns an unknown result with diagnostics when Git facts cannot be calculated", async () => {
		const directoryPath = mkdtempSync(path.join(tmpdir(), "agent-issues-prospector-non-git-"));
		tempDirs.push(directoryPath);

		await expect(calculateRepositoryVersion(directoryPath)).resolves.toEqual({
			state: "unknown",
			diagnostics: [{ code: "prospector-calculation-failed", message: "Prospector could not resolve the current Git branch and commit." }]
		});
	});
});