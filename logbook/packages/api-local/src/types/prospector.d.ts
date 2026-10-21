declare module "@arcmantle/prospector" {
	export type ProspectorOptions = {
		cwd?: string;
		mainBranch?: string | string[];
		tagPrefix?: string;
		enableCommitBumps?: boolean;
		maxCommitScan?: number;
		commitBumpPatterns?: {
			major?: RegExp;
			minor?: RegExp;
			patch?: RegExp;
		};
	};

	export type VersionInfo = {
		version: string;
		branch: string;
		isMainBranch: boolean;
		commitsSinceTag: number;
		lastTag: { tag: string } | null;
		currentCommit: string;
		commitBumps: {
			major: number;
			minor: number;
			patch: number;
			explicitVersion: string | null;
			explicitVersionCommit: string | null;
		};
	};

	export function calculateVersion(options?: ProspectorOptions): Promise<VersionInfo>;
}