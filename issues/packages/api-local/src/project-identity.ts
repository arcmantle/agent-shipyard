import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { sanitizePathSegment } from "@agent-issues/core";

import { resolveTenantRootPath } from "./db/database.js";

export type ProjectIdentitySource = "environment" | "folder-name" | "git-repository" | "package-json" | "project-file";

export type ProjectIdentityResolution = {
	identity: string;
	source: ProjectIdentitySource;
};

export const PROJECT_IDENTITY_FILENAME = ".agent-issues.json";
export const PROJECT_IDENTITY_FILENAME_WITHOUT_JSON = ".agent-issues";
export const PROJECT_IDENTITY_ENVIRONMENT_VARIABLE = "AGENT_ISSUES_PROJECT_IDENTITY";

export function resolveProjectIdentity(
	currentWorkingDirectory: string = process.cwd(),
	environment: NodeJS.ProcessEnv = process.env
): ProjectIdentityResolution {
	const root = resolveTenantRootPath(currentWorkingDirectory);

	return (
		resolveFromEnvironment(environment) ??
		resolveFromProjectFile(root) ??
		resolveFromGitRepository(root) ??
		resolveFromPackageJson(root) ??
		resolveFromFolderName(root)
	);
}

function resolveFromEnvironment(environment: NodeJS.ProcessEnv): ProjectIdentityResolution | undefined {
	const project = environment[PROJECT_IDENTITY_ENVIRONMENT_VARIABLE];
	if (!project) return undefined;

	const identity = sanitizePathSegment(project);
	if (!identity) return undefined;

	return { identity, source: "environment" };
}

function resolveFromProjectFile(root: string): ProjectIdentityResolution | undefined {
	for (const projectIdentityFilename of [PROJECT_IDENTITY_FILENAME, PROJECT_IDENTITY_FILENAME_WITHOUT_JSON]) {
		const projectFilePath = path.join(root, projectIdentityFilename);
		if (!isRegularFile(projectFilePath)) continue;

		const projectIdentity = parseJsonStringField(readFileSync(projectFilePath, "utf8"), "projectIdentity");
		if (!projectIdentity) continue;

		const identity = sanitizePathSegment(projectIdentity);
		if (!identity) continue;

		return { identity, source: "project-file" };
	}

	return undefined;
}

function resolveFromPackageJson(root: string): ProjectIdentityResolution | undefined {
	const packageJsonPath = path.join(root, "package.json");
	if (!isRegularFile(packageJsonPath)) return undefined;

	const name = parseJsonStringField(readFileSync(packageJsonPath, "utf8"), "name");
	if (!name) return undefined;

	const identity = sanitizePathSegment(name);
	if (!identity) return undefined;

	return { identity, source: "package-json" };
}

function isRegularFile(filePath: string): boolean {
	return existsSync(filePath) && statSync(filePath).isFile();
}

function parseJsonStringField(contents: string, field: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(contents);
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const value = (parsed as Record<string, unknown>)[field];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function resolveFromGitRepository(root: string): ProjectIdentityResolution | undefined {
	const gitConfigPath = resolveGitConfigPath(root);
	if (!existsSync(gitConfigPath)) return undefined;

	const repositoryName = extractOriginRepositoryName(readFileSync(gitConfigPath, "utf8"));
	if (!repositoryName) return undefined;

	const identity = sanitizePathSegment(repositoryName);
	if (!identity) return undefined;

	return { identity, source: "git-repository" };
}

function resolveGitConfigPath(root: string): string {
	const gitPath = path.join(root, ".git");
	if (!existsSync(gitPath) || statSync(gitPath).isDirectory()) {
		return path.join(gitPath, "config");
	}

	const gitDirectory = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
	const resolvedGitDirectory = gitDirectory ? path.resolve(root, gitDirectory) : gitPath;
	const worktreeConfigPath = path.join(resolvedGitDirectory, "config");
	if (existsSync(worktreeConfigPath)) {
		return worktreeConfigPath;
	}

	const commonDirectoryPath = path.join(resolvedGitDirectory, "commondir");
	if (!existsSync(commonDirectoryPath)) {
		return worktreeConfigPath;
	}

	return path.join(path.resolve(resolvedGitDirectory, readFileSync(commonDirectoryPath, "utf8").trim()), "config");
}

function extractOriginRepositoryName(gitConfigContents: string): string | undefined {
	const originSectionMatch = gitConfigContents.match(/\[remote "origin"]([\s\S]*?)(?:\n\[|$)/);
	if (!originSectionMatch) return undefined;

	const urlMatch = originSectionMatch[1].match(/^\s*url\s*=\s*(.+)$/m);
	if (!urlMatch) return undefined;

	const url = urlMatch[1].trim();
	const lastSegment = url.split(/[/:]/).pop() ?? "";
	return lastSegment.replace(/\.git$/, "");
}

function resolveFromFolderName(root: string): ProjectIdentityResolution {
	const identity = sanitizePathSegment(path.basename(root)) || "workspace";
	return { identity, source: "folder-name" };
}