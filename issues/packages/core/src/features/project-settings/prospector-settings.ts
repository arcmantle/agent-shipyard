export type ProspectorCommitBumpPatterns = {
	major?: string;
	minor?: string;
	patch?: string;
};

export type ProspectorProjectSettings = {
	trunkBranches?: string[];
	tagPrefix?: string;
	enableCommitBumps?: boolean;
	commitBumpPatterns?: ProspectorCommitBumpPatterns;
	maxCommitScan?: number;
};

export type VersionCalculationDiagnostic = {
	code: "prospector-calculation-failed";
	message: string;
};

export type CalculatedRepositoryVersion = {
	state: "available";
	version: string;
	branch: string;
	currentCommit: string;
	isTrunkBranch: boolean;
	commitsSinceTag: number;
	lastTag?: string;
	commitBumps: {
		major: number;
		minor: number;
		patch: number;
		explicitVersion?: string;
		explicitVersionCommit?: string;
	};
};

export type UnknownRepositoryVersion = {
	state: "unknown";
	diagnostics: VersionCalculationDiagnostic[];
};

export type RepositoryVersionCalculation = CalculatedRepositoryVersion | UnknownRepositoryVersion;