import { calculateVersion } from "@arcmantle/prospector";

import type { ProspectorProjectSettings, RepositoryVersionCalculation } from "@agent-issues/core";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export async function calculateRepositoryVersion(repositoryPath: string, settings: ProspectorProjectSettings = {}): Promise<RepositoryVersionCalculation> {
	try {
		const versionInfo = await calculateVersion({
			cwd: repositoryPath,
			mainBranch: settings.trunkBranches,
			tagPrefix: settings.tagPrefix,
			enableCommitBumps: settings.enableCommitBumps,
			maxCommitScan: settings.maxCommitScan,
			commitBumpPatterns: compileCommitBumpPatterns(settings.commitBumpPatterns)
		});

		if (!COMMIT_SHA_PATTERN.test(versionInfo.currentCommit) || versionInfo.branch === "unknown") {
			return unknownCalculation("Prospector could not resolve the current Git branch and commit.");
		}

		return {
			state: "available",
			version: versionInfo.version,
			branch: versionInfo.branch,
			currentCommit: versionInfo.currentCommit,
			isTrunkBranch: versionInfo.isMainBranch,
			commitsSinceTag: versionInfo.commitsSinceTag,
			lastTag: versionInfo.lastTag?.tag,
			commitBumps: {
				major: versionInfo.commitBumps.major,
				minor: versionInfo.commitBumps.minor,
				patch: versionInfo.commitBumps.patch,
				explicitVersion: versionInfo.commitBumps.explicitVersion ?? undefined,
				explicitVersionCommit: versionInfo.commitBumps.explicitVersionCommit ?? undefined
			}
		};
	} catch {
		return unknownCalculation("Could not calculate the repository version.");
	}
}

function compileCommitBumpPatterns(patterns: ProspectorProjectSettings["commitBumpPatterns"]): { major?: RegExp; minor?: RegExp; patch?: RegExp } | undefined {
	if (patterns === undefined) return undefined;

	return {
		major: patterns.major === undefined ? undefined : new RegExp(patterns.major, "i"),
		minor: patterns.minor === undefined ? undefined : new RegExp(patterns.minor, "i"),
		patch: patterns.patch === undefined ? undefined : new RegExp(patterns.patch, "i")
	};
}

function unknownCalculation(message: string): RepositoryVersionCalculation {
	return {
		state: "unknown",
		diagnostics: [{ code: "prospector-calculation-failed", message }]
	};
}