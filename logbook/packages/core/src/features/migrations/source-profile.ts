export type SourceProfile = "empty" | "legacy-sqlite-v7" | "legacy-postgres-v7" | "current-final";

export type SourceProfileEvidence = {
	dialect: "postgres" | "sqlite";
	ledgerIds: string[];
	schemaSignature: string;
};

export type AcceptedSourceProfileResult = {
	profile: SourceProfile;
	supported: true;
	evidence: SourceProfileEvidence;
};

export type UnsupportedSourceProfileResult = {
	profile: "unsupported";
	supported: false;
	evidence: SourceProfileEvidence;
	reasons: string[];
	recoveryPaths: string[];
};

export type SourceProfileResult = AcceptedSourceProfileResult | UnsupportedSourceProfileResult;

export function formatUnsupportedSourceProfile(result: UnsupportedSourceProfileResult): string {
	return [
		"Unsupported source profile.",
		...result.reasons.map((reason) => `Evidence: ${reason}`),
		...result.recoveryPaths.map((recoveryPath) => `Recovery: ${recoveryPath}`)
	].join(" ");
}