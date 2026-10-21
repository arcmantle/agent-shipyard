import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceObservation, WorkspaceObservationResolver } from "./workspace-observation.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createGitRepository(): string {
	const repositoryPath = mkdtempSync(path.join(tmpdir(), "agent-issues-workspace-observation-"));
	tempDirs.push(repositoryPath);

	git(repositoryPath, "init", "--initial-branch=main");
	git(repositoryPath, "config", "user.email", "agent-issues@example.test");
	git(repositoryPath, "config", "user.name", "Agent Issues");
	git(repositoryPath, "remote", "add", "origin", "https://example.test/acme/repository.git");
	writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
	git(repositoryPath, "add", "README.md");
	git(repositoryPath, "commit", "-m", "Initial commit");

	return repositoryPath;
}

function git(repositoryPath: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}

describe("resolveWorkspaceObservation", () => {
	it("returns a privacy-safe deterministic observation for the current Git workspace", async () => {
		const repositoryPath = createGitRepository();
		const capturedAt = "2026-09-22T12:00:00.000Z";

		await expect(resolveWorkspaceObservation(repositoryPath, {}, () => capturedAt)).resolves.toMatchObject({
			state: "available",
			repositoryIdentity: "21642ff80cb07496284b9ffc6e0810588216880dc50de1eaf8fb58af34ede6fd",
			commitSha: git(repositoryPath, "rev-parse", "HEAD"),
			branch: "main",
			dirty: false,
			capturedAt,
			calculatedVersion: expect.objectContaining({ state: "available", version: "0.0.1" }),
			fingerprint: expect.objectContaining({
				branch: "main",
				commitSha: git(repositoryPath, "rev-parse", "HEAD")
			})
		});
	});

	it("reuses the calculated version until Git facts or project settings change", async () => {
		const repositoryPath = createGitRepository();
		let calculationCount = 0;
		const resolver = new WorkspaceObservationResolver({
			calculateVersion: async () => {
				calculationCount += 1;
				return {
					state: "available",
					version: `0.0.${calculationCount}`,
					branch: "main",
					currentCommit: git(repositoryPath, "rev-parse", "HEAD"),
					isTrunkBranch: true,
					commitsSinceTag: 1,
					commitBumps: { major: 0, minor: 0, patch: 0 }
				};
			}
		});

		const first = await resolver.resolve(repositoryPath);
		const repeated = await resolver.resolve(repositoryPath);
		const changedSettings = await resolver.resolve(repositoryPath, { tagPrefix: "v" });
		git(repositoryPath, "tag", "v0.0.1");
		const changedRefs = await resolver.resolve(repositoryPath, { tagPrefix: "v" });
		git(repositoryPath, "checkout", "-b", "feature");
		const changedBranch = await resolver.resolve(repositoryPath, { tagPrefix: "v" });
		writeFileSync(path.join(repositoryPath, "README.md"), "updated fixture\n");
		git(repositoryPath, "add", "README.md");
		git(repositoryPath, "commit", "-m", "Update fixture");
		const changedCommit = await resolver.resolve(repositoryPath, { tagPrefix: "v" });

		expect(first).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.1" } });
		expect(repeated).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.1" } });
		expect(changedSettings).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.2" } });
		expect(changedRefs).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.3" } });
		expect(changedBranch).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.4" } });
		expect(changedCommit).toMatchObject({ state: "available", calculatedVersion: { state: "available", version: "0.0.5" } });
	});

	it("returns an explicit unknown observation for a non-Git workspace", async () => {
		const workspacePath = mkdtempSync(path.join(tmpdir(), "agent-issues-non-git-workspace-"));
		tempDirs.push(workspacePath);

		await expect(resolveWorkspaceObservation(workspacePath, {}, () => "2026-09-22T12:00:00.000Z")).resolves.toEqual({
			state: "unknown",
			capturedAt: "2026-09-22T12:00:00.000Z",
			diagnostics: [expect.objectContaining({ code: "workspace-observation-failed" })]
		});
	});

	it("returns an explicit unknown observation for a Git workspace without an origin", async () => {
		const repositoryPath = createGitRepository();
		git(repositoryPath, "remote", "remove", "origin");

		const observation = await resolveWorkspaceObservation(repositoryPath);

		expect(observation).toMatchObject({
			state: "unknown",
			diagnostics: [expect.objectContaining({ code: "workspace-observation-failed" })]
		});
		expect(JSON.stringify(observation)).not.toContain(repositoryPath);
	});

	it("observes a detached Git HEAD without exposing the workspace path", async () => {
		const repositoryPath = createGitRepository();
		git(repositoryPath, "checkout", "--detach");

		await expect(resolveWorkspaceObservation(repositoryPath)).resolves.toMatchObject({
			state: "available",
			branch: "detached"
		});
	});

	it("resolves repository facts from a linked worktree", async () => {
		const repositoryPath = createGitRepository();
		const worktreePath = `${repositoryPath}-worktree`;
		tempDirs.push(worktreePath);
		git(repositoryPath, "worktree", "add", "--detach", worktreePath, "HEAD");
		const resolver = new WorkspaceObservationResolver({
			calculateVersion: async () => ({
				state: "unknown",
				diagnostics: [{ code: "prospector-calculation-failed", message: "Not part of this Git fixture." }]
			})
		});

		await expect(resolver.resolve(worktreePath)).resolves.toMatchObject({
			state: "available",
			commitSha: git(repositoryPath, "rev-parse", "HEAD"),
			branch: "detached"
		});
	});

	it("resolves repository facts from a shallow clone", async () => {
		const repositoryPath = createGitRepository();
		const shallowClonePath = `${repositoryPath}-shallow`;
		tempDirs.push(shallowClonePath);
		execFileSync("git", ["clone", "--depth", "1", `file://${repositoryPath}`, shallowClonePath], { encoding: "utf8" });
		const resolver = new WorkspaceObservationResolver({
			calculateVersion: async () => ({
				state: "unknown",
				diagnostics: [{ code: "prospector-calculation-failed", message: "Not part of this Git fixture." }]
			})
		});

		expect(git(shallowClonePath, "rev-parse", "--is-shallow-repository")).toBe("true");
		await expect(resolver.resolve(shallowClonePath)).resolves.toMatchObject({
			state: "available",
			commitSha: git(repositoryPath, "rev-parse", "HEAD"),
			branch: "main"
		});
	});

	it("returns a privacy-safe unknown observation when Prospector calculation fails", async () => {
		const repositoryPath = createGitRepository();
		const resolver = new WorkspaceObservationResolver({
			calculateVersion: async () => {
				throw new Error(`Prospector cannot calculate a version from ${repositoryPath}.`);
			}
		});

		const observation = await resolver.resolve(repositoryPath);

		expect(observation).toMatchObject({
			state: "unknown",
			diagnostics: [expect.objectContaining({ code: "prospector-calculation-failed", message: "Could not calculate the repository version." })]
		});
		expect(JSON.stringify(observation)).not.toContain(repositoryPath);
	});

	it("removes workspace paths from unavailable Prospector diagnostics", async () => {
		const repositoryPath = createGitRepository();
		const resolver = new WorkspaceObservationResolver({
			calculateVersion: async () => ({
				state: "unknown",
				diagnostics: [{ code: "prospector-calculation-failed", message: `Cannot read ${repositoryPath}/package.json.` }]
			})
		});

		const observation = await resolver.resolve(repositoryPath);

		expect(observation).toMatchObject({
			state: "available",
			calculatedVersion: {
				state: "unknown",
				diagnostics: [expect.objectContaining({ code: "prospector-calculation-failed", message: "Could not calculate the repository version." })]
			}
		});
		expect(JSON.stringify(observation)).not.toContain(repositoryPath);
	});
});