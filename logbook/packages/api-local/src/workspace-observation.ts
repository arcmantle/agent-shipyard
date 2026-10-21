import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { calculateRepositoryVersion } from "./prospector.js";

import type { ProspectorProjectSettings, RepositoryVersionCalculation, WorkspaceObservation, WorkspaceGitFingerprint } from "@agent-issues/core";

const execFileAsync = promisify(execFile);

export type WorkspaceObservationResolverOptions = {
	calculateVersion?: (workspaceRoot: string, settings: ProspectorProjectSettings) => Promise<RepositoryVersionCalculation>;
	now?: () => string;
};

type WorkspaceGitFacts = {
	repositoryIdentity: string;
	commitSha: string;
	branch: string;
	dirty: boolean;
	fingerprint: WorkspaceGitFingerprint;
};

type CachedCalculation = {
	fingerprint: WorkspaceGitFingerprint;
	settingsHash: string;
	calculatedVersion: RepositoryVersionCalculation;
};

export async function resolveWorkspaceObservation(
	workspaceRoot: string,
	settings: ProspectorProjectSettings = {},
	now: () => string = () => new Date().toISOString()
): Promise<WorkspaceObservation> {
	return new WorkspaceObservationResolver({ now }).resolve(workspaceRoot, settings);
}


export class WorkspaceObservationResolver {
	public constructor(options: WorkspaceObservationResolverOptions = {}) {
		this.calculateVersion = options.calculateVersion ?? calculateRepositoryVersion;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	protected calculateVersion: (workspaceRoot: string, settings: ProspectorProjectSettings) => Promise<RepositoryVersionCalculation>;
	protected cachedCalculation: CachedCalculation | undefined;
	protected now: () => string;

	public async resolve(workspaceRoot: string, settings: ProspectorProjectSettings = {}): Promise<WorkspaceObservation> {
		const capturedAt = this.now();
		let gitFacts: WorkspaceGitFacts | undefined;

		try {
			gitFacts = await resolveWorkspaceGitFacts(workspaceRoot);
		} catch {
			return unknownObservation(capturedAt, "Could not inspect the current workspace Git repository.");
		}
		if (gitFacts === undefined) {
			return unknownObservation(capturedAt, "Git origin remote is required to identify the current repository.");
		}

		const settingsHash = sha256(stableJson(settings));
		try {
			const calculatedVersion = this.canReuseCalculation(gitFacts.fingerprint, settingsHash)
				? this.cachedCalculation.calculatedVersion
				: await this.calculateAndCache(workspaceRoot, settings, gitFacts.fingerprint, settingsHash);

			return { state: "available", ...gitFacts, capturedAt, calculatedVersion };
		} catch {
			return unknownObservation(capturedAt, "Could not calculate the repository version.", "prospector-calculation-failed");
		}
	}

	protected canReuseCalculation(fingerprint: WorkspaceGitFingerprint, settingsHash: string): this is this & { cachedCalculation: CachedCalculation } {
		return this.cachedCalculation !== undefined
			&& this.cachedCalculation.settingsHash === settingsHash
			&& sameFingerprint(this.cachedCalculation.fingerprint, fingerprint);
	}

	protected async calculateAndCache(
		workspaceRoot: string,
		settings: ProspectorProjectSettings,
		fingerprint: WorkspaceGitFingerprint,
		settingsHash: string
	): Promise<RepositoryVersionCalculation> {
		const calculatedVersion = await sanitizeCalculation(this.calculateVersion(workspaceRoot, settings));
		this.cachedCalculation = { fingerprint, settingsHash, calculatedVersion };
		return calculatedVersion;
	}
}

async function resolveWorkspaceGitFacts(workspaceRoot: string): Promise<WorkspaceGitFacts | undefined> {
	const [originUrl, commitSha, branch, status, refs] = await Promise.all([
		runGit(workspaceRoot, ["config", "--get", "remote.origin.url"]),
		runGit(workspaceRoot, ["rev-parse", "HEAD"]),
		runGit(workspaceRoot, ["branch", "--show-current"]),
		runGit(workspaceRoot, ["status", "--porcelain"]),
		runGit(workspaceRoot, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
	]);
	const repositoryIdentity = repositoryIdentityFromOrigin(originUrl);
	if (repositoryIdentity === undefined) return undefined;

	const normalizedBranch = branch || "detached";
	const fingerprint: WorkspaceGitFingerprint = {
		repositoryIdentity,
		commitSha,
		branch: normalizedBranch,
		refsHash: sha256(refs)
	};
	return { repositoryIdentity, commitSha, branch: normalizedBranch, dirty: status.length > 0, fingerprint };
}

function sameFingerprint(left: WorkspaceGitFingerprint, right: WorkspaceGitFingerprint): boolean {
	return left.repositoryIdentity === right.repositoryIdentity
		&& left.commitSha === right.commitSha
		&& left.branch === right.branch
		&& left.refsHash === right.refsHash;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function sanitizeCalculation(calculation: Promise<RepositoryVersionCalculation>): Promise<RepositoryVersionCalculation> {
	const calculatedVersion = await calculation;
	if (calculatedVersion.state === "available") return calculatedVersion;

	return {
		state: "unknown",
		diagnostics: calculatedVersion.diagnostics.map((diagnostic) => ({
			code: diagnostic.code,
			message: "Could not calculate the repository version."
		}))
	};
}

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd: workspaceRoot, encoding: "utf8" });
	return stdout.trim();
}

function repositoryIdentityFromOrigin(originUrl: string): string | undefined {
	const normalizedOrigin = normalizeOriginUrl(originUrl);
	return normalizedOrigin === undefined ? undefined : sha256(normalizedOrigin);
}

function normalizeOriginUrl(originUrl: string): string | undefined {
	const trimmedOrigin = originUrl.trim();
	if (!trimmedOrigin) return undefined;

	const sshMatch = trimmedOrigin.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
	const parsedOrigin = sshMatch === null
		? (() => {
			try {
				return new URL(trimmedOrigin);
			} catch {
				return undefined;
			}
		})()
		: undefined;
	const hostname = sshMatch?.[1] ?? parsedOrigin?.hostname;
	const pathname = sshMatch?.[2] ?? parsedOrigin?.pathname;
	if (!hostname || !pathname) return undefined;

	const normalizedPath = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	return normalizedPath ? `${hostname.toLowerCase()}/${normalizedPath}` : undefined;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function unknownObservation(
	capturedAt: string,
	message: string,
	code: "workspace-observation-failed" | "prospector-calculation-failed" = "workspace-observation-failed"
): WorkspaceObservation {
	return {
		state: "unknown",
		capturedAt,
		diagnostics: [{ code, message }]
	};
}