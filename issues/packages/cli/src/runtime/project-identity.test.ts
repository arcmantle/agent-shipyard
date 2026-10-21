import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	PROJECT_IDENTITY_ENVIRONMENT_VARIABLE,
	PROJECT_IDENTITY_FILENAME,
	PROJECT_IDENTITY_FILENAME_WITHOUT_JSON,
	resolveProjectIdentity
} from "./project-identity.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createWorkspace(folderName: string): string {
	const tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-project-identity-"));
	tempDirs.push(tempDir);

	const workspaceRoot = path.join(tempDir, folderName);
	mkdirSync(workspaceRoot, { recursive: true });
	return workspaceRoot;
}

function writeGitRemote(workspaceRoot: string, url: string): void {
	mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
	writeFileSync(
		path.join(workspaceRoot, ".git", "config"),
		`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
	);
}

function writeGitWorktreeRemote(workspaceRoot: string, url: string): void {
	const gitDirectory = path.join(workspaceRoot, "git-directory", "worktrees", "checkout");
	const commonGitDirectory = path.join(workspaceRoot, "git-directory");
	mkdirSync(gitDirectory, { recursive: true });
	writeFileSync(path.join(workspaceRoot, ".git"), "gitdir: git-directory/worktrees/checkout\n");
	writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
	writeFileSync(
		path.join(commonGitDirectory, "config"),
		`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
	);
}

describe("project identity resolution", () => {
	it("falls back to the sanitized folder name for a non-git, override-free workspace", () => {
		const workspaceRoot = createWorkspace("My Cool App");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "my-cool-app",
			source: "folder-name"
		});
	});

	it("derives the identity from the git remote origin repository name, overriding the folder name", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("parses an SSH-style git remote origin url the same way as an HTTPS one", () => {
		const workspaceRoot = createWorkspace("another-checkout-name");
		writeGitRemote(workspaceRoot, "git@github.com:arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("derives the identity from a worktree Git directory", () => {
		const workspaceRoot = createWorkspace("worktree-checkout");
		writeGitWorktreeRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("prefers the git repository name over a package.json workspace label", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");
		writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "agent-issues-workspace" }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("does not inspect .code-workspace files when resolving identity directly", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "My Package Name" }));
		writeFileSync(
			path.join(workspaceRoot, "eye-share-demo.code-workspace"),
			JSON.stringify({ folders: [], settings: { "agentIssues.projectIdentity": "ClientFlex" } })
		);

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "my-package-name",
			source: "package-json"
		});
	});

	it("prefers the .agent-issues.json file over workspace and package metadata", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "My Package Name" }));
		writeFileSync(path.join(workspaceRoot, ".agent-issues.json"), JSON.stringify({ projectIdentity: "ClientFlex" }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "clientflex",
			source: "project-file"
		});
	});

	it("supports the .agent-issues project file without the .json extension", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME_WITHOUT_JSON), JSON.stringify({ projectIdentity: "Extensionless Project" }));

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "extensionless-project",
			source: "project-file"
		});
	});

	it("uses an explicit environment project identity instead of workspace discovery", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME), JSON.stringify({ projectIdentity: "Repository project" }));
		writeFileSync(
			path.join(workspaceRoot, "eye-share-demo.code-workspace"),
			JSON.stringify({ folders: [], settings: { "agentIssues.projectIdentity": "ClientFlex" } })
		);

		expect(resolveProjectIdentity(workspaceRoot, { [PROJECT_IDENTITY_ENVIRONMENT_VARIABLE]: "Workspace project" })).toEqual({
			identity: "workspace-project",
			source: "environment"
		});
	});

	it("never surfaces extra fields from the dedicated project file, only identity and source", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeFileSync(
			path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME),
			JSON.stringify({ projectIdentity: "Explicit Name", cloudUrl: "https://example.test", token: "super-secret" })
		);

		expect(Object.keys(resolveProjectIdentity(workspaceRoot)).sort()).toEqual(["identity", "source"]);
	});

	it("resolves the same identity for the same git repository checked out at two different absolute paths", () => {
		const firstCheckout = createWorkspace("checkout-one");
		const secondCheckout = createWorkspace("checkout-two");
		writeGitRemote(firstCheckout, "https://github.com/arcmantle/agent-issues.git");
		writeGitRemote(secondCheckout, "https://github.com/arcmantle/agent-issues.git");

		expect(firstCheckout).not.toBe(secondCheckout);
		expect(resolveProjectIdentity(firstCheckout)).toEqual(resolveProjectIdentity(secondCheckout));
	});

	it("falls through to the next source when the dedicated project file is malformed JSON", () => {
		const workspaceRoot = createWorkspace("checkout-dir-name-does-not-matter");
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");
		writeFileSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME), "{ not valid json");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});

	it("skips a .agent-issues directory instead of reading it as a project file", () => {
		const workspaceRoot = createWorkspace("home-directory");
		mkdirSync(path.join(workspaceRoot, PROJECT_IDENTITY_FILENAME_WITHOUT_JSON));
		writeGitRemote(workspaceRoot, "https://github.com/arcmantle/agent-issues.git");

		expect(resolveProjectIdentity(workspaceRoot)).toEqual({
			identity: "agent-issues",
			source: "git-repository"
		});
	});
});
