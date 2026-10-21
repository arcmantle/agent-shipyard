import type { RepositoryVersionCalculation } from "../project-settings/prospector-settings.js";

export type WorkspaceObservationDiagnostic = {
	code: "workspace-observation-failed" | "prospector-calculation-failed";
	message: string;
};

export type WorkspaceGitFingerprint = {
	repositoryIdentity: string;
	commitSha: string;
	branch: string;
	refsHash: string;
};

export type AvailableWorkspaceObservation = {
	state: "available";
	repositoryIdentity: string;
	commitSha: string;
	branch: string;
	dirty: boolean;
	capturedAt: string;
	calculatedVersion: RepositoryVersionCalculation;
	fingerprint: WorkspaceGitFingerprint;
};

export type UnknownWorkspaceObservation = {
	state: "unknown";
	capturedAt: string;
	diagnostics: WorkspaceObservationDiagnostic[];
};

export type WorkspaceObservation = AvailableWorkspaceObservation | UnknownWorkspaceObservation;

export type WorkspaceRetrievalContext = {
	repositoryIdentity?: string;
	commitSha?: string;
	calculatedVersion?: string;
	diagnostics: WorkspaceObservationDiagnostic[];
};

export type CodeCompatibility = "exact-commit" | "exact-version" | "same-minor-version" | "same-major-version" | "different-major-version" | "unknown";

export type CompletionObservationCompatibilitySource = {
	repositoryIdentity: string | null;
	commitSha: string | null;
	calculatedVersionState: "available" | "unknown";
	calculatedVersion: string | null;
};

export function getCodeCompatibility(
	observation: CompletionObservationCompatibilitySource,
	context: WorkspaceRetrievalContext
): CodeCompatibility {
	if (context.diagnostics.length > 0) {
		return "unknown";
	}
	if (context.repositoryIdentity === undefined || observation.repositoryIdentity !== context.repositoryIdentity) {
		return "unknown";
	}
	if (context.commitSha !== undefined && observation.commitSha === context.commitSha) {
		return "exact-commit";
	}
	if (context.calculatedVersion === undefined || observation.calculatedVersionState !== "available" || observation.calculatedVersion === null) {
		return "unknown";
	}
	if (observation.calculatedVersion === context.calculatedVersion) {
		return "exact-version";
	}
	const observedVersion = parseSemanticVersion(observation.calculatedVersion);
	const currentVersion = parseSemanticVersion(context.calculatedVersion);
	if (observedVersion === undefined || currentVersion === undefined) {
		return "unknown";
	}
	if (observedVersion.major !== currentVersion.major) {
		return "different-major-version";
	}
	return observedVersion.minor === currentVersion.minor ? "same-minor-version" : "same-major-version";
}

export function compareCodeCompatibility(left: CodeCompatibility, right: CodeCompatibility): number {
	return codeCompatibilityRank(left) - codeCompatibilityRank(right);
}

function codeCompatibilityRank(compatibility: CodeCompatibility): number {
	return ["exact-commit", "exact-version", "same-minor-version", "same-major-version", "different-major-version", "unknown"].indexOf(compatibility);
}

function parseSemanticVersion(value: string): { major: number; minor: number } | undefined {
	const match = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
	if (match?.groups?.major === undefined || match.groups.minor === undefined) {
		return undefined;
	}
	return { major: Number(match.groups.major), minor: Number(match.groups.minor) };
}

export function toWorkspaceRetrievalContext(observation: WorkspaceObservation): WorkspaceRetrievalContext {
	if (observation.state === "unknown") {
		return { diagnostics: observation.diagnostics };
	}

	return {
		repositoryIdentity: observation.repositoryIdentity,
		commitSha: observation.commitSha,
		calculatedVersion: observation.calculatedVersion.state === "available" ? observation.calculatedVersion.version : undefined,
		diagnostics: observation.calculatedVersion.state === "unknown" ? observation.calculatedVersion.diagnostics : []
	};
}