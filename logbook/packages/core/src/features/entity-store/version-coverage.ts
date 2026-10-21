import type { CompletionObservation, VersionCoverage } from "./store-types.js";

export function deriveVersionCoverage(observations: readonly CompletionObservation[]): VersionCoverage[] {
	const groups = new Map<string, VersionCoverage & { issueIds: Set<string> }>();

	for (const observation of observations) {
		const key = `${observation.calculatedVersionState}\u0000${observation.calculatedVersion ?? ""}`;
		const group = groups.get(key) ?? {
			calculatedVersionState: observation.calculatedVersionState,
			calculatedVersion: observation.calculatedVersion,
			issueCount: 0,
			latestCapturedAt: observation.capturedAt,
			issueIds: new Set<string>()
		};
		group.issueIds.add(observation.issueId);
		if (observation.capturedAt > group.latestCapturedAt) group.latestCapturedAt = observation.capturedAt;
		groups.set(key, group);
	}

	return [...groups.values()]
		.map(({ issueIds, ...coverage }) => ({ ...coverage, issueCount: issueIds.size }))
		.sort((left, right) =>
			left.calculatedVersionState.localeCompare(right.calculatedVersionState) ||
			(left.calculatedVersion ?? "").localeCompare(right.calculatedVersion ?? "")
		);
}