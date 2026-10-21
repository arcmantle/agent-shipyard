import type { EntityRecord, StorageDriver } from "@agent-issues/core";

export const BACKFILLABLE_BODY_KINDS = ["project", "epic", "version", "initiative", "issue", "prd", "userStory", "adr"] as const;
const DERIVED_CONTENT_MARKER = "Not derived from tracker metadata.";

export type BackfillableBodyKind = (typeof BACKFILLABLE_BODY_KINDS)[number];

export type BackfillBodiesKindResult = {
	kind: BackfillableBodyKind;
	considered: number;
	updated: number;
	skipped: number;
};

export type BackfillBodiesResult = {
	tenantId: string;
	dryRun: boolean;
	force: boolean;
	kinds: BackfillableBodyKind[];
	considered: number;
	updated: number;
	skipped: number;
	byKind: BackfillBodiesKindResult[];
};

export function isBackfillableBodyKind(value: string): value is BackfillableBodyKind {
	return BACKFILLABLE_BODY_KINDS.includes(value as BackfillableBodyKind);
}

export function parseBackfillableBodyKinds(values: string[]): BackfillableBodyKind[] {
	if (values.length === 0) {
		return [...BACKFILLABLE_BODY_KINDS];
	}

	const kinds: BackfillableBodyKind[] = [];
	const invalid: string[] = [];

	for (const value of values) {
		if (!isBackfillableBodyKind(value)) {
			invalid.push(value);
			continue;
		}

		if (!kinds.includes(value)) {
			kinds.push(value);
		}
	}

	if (invalid.length > 0) {
		throw new Error(
			`Unsupported backfill kinds: ${invalid.join(", ")}. Supported kinds: ${BACKFILLABLE_BODY_KINDS.join(", ")}.`
		);
	}

	return kinds;
}

export async function backfillBodies(
	store: StorageDriver,
	input: { dryRun?: boolean; force?: boolean; kinds?: BackfillableBodyKind[] } = {}
): Promise<BackfillBodiesResult> {
	const snapshot = await store.getDatabaseSnapshot();
	const kinds = input.kinds ?? [...BACKFILLABLE_BODY_KINDS];
	const byKind: BackfillBodiesKindResult[] = [];

	for (const kind of kinds) {
		const entities = sortEntities(snapshot.entities.filter((entity) => entity.kind === kind));
		let updated = 0;
		let skipped = 0;

		for (const entity of entities) {
			const body = buildBody(kind);
			if (body.trim().length === 0) {
				skipped += 1;
				continue;
			}

			const hasStoredBody = entity.body.trim().length > 0;
			const matchesGeneratedBody = hasStoredBody && entity.body === body;

			if (!input.force && hasStoredBody && !matchesGeneratedBody) {
				skipped += 1;
				continue;
			}

			if (!input.force && matchesGeneratedBody && entity.bodySource === "generated") {
				skipped += 1;
				continue;
			}

			if (!input.dryRun) {
				await store.setEntityBody({ entityId: entity.id, body, bodySource: "generated", expectedRevision: entity.revision, expectedContentHash: entity.contentHash });
			}
			updated += 1;
		}

		byKind.push({
			kind,
			considered: entities.length,
			updated,
			skipped
		});
	}

	return {
		tenantId: store.tenantId,
		dryRun: input.dryRun ?? false,
		force: input.force ?? false,
		kinds,
		considered: byKind.reduce((sum, item) => sum + item.considered, 0),
		updated: byKind.reduce((sum, item) => sum + item.updated, 0),
		skipped: byKind.reduce((sum, item) => sum + item.skipped, 0),
		byKind
	};
}

function buildBody(kind: BackfillableBodyKind): string {
	switch (kind) {
		case "project":
			return buildManagementBody();
		case "epic":
			return buildManagementBody();
		case "version":
			return buildVersionBody();
		case "initiative":
			return buildInitiativeBody();
		case "issue":
			return buildIssueBody();
		case "prd":
			return buildPrdBody();
		case "userStory":
			return buildUserStoryBody();
		case "adr":
			return buildAdrBody();
	}
}

function buildManagementBody(): string {
	return [
		"## Purpose",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Scope",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Success Conditions",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Non-Goals",
		"",
		`- ${DERIVED_CONTENT_MARKER}`
	].join("\n");
}

function buildVersionBody(): string {
	return [
		"## Release Intent",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Compatibility and Migration Notes",
		"",
		`- ${DERIVED_CONTENT_MARKER}`
	].join("\n");
}

function buildInitiativeBody(): string {
	return buildManagementBody();
}

function buildIssueBody(): string {
	return [
		"## Work Mode",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Outcome",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Scope",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Work Plan",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Acceptance Criteria",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Verification",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Notes",
		"",
		DERIVED_CONTENT_MARKER
	].join("\n");
}

function buildPrdBody(): string {
	return [
		"## Problem Statement",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Solution",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Implementation Decisions",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Testing Decisions",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Out of Scope",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Further Notes",
		"",
		DERIVED_CONTENT_MARKER
	].join("\n");
}

function buildUserStoryBody(): string {
	return [
		`As an actor, I want ${DERIVED_CONTENT_MARKER}, so that ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Acceptance Criteria",
		"",
		`- ${DERIVED_CONTENT_MARKER}`,
		"",
		"## Boundaries",
		"",
		`- ${DERIVED_CONTENT_MARKER}`
	].join("\n");
}

function buildAdrBody(): string {
	return [
		"## Status",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Context",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Decision",
		"",
		DERIVED_CONTENT_MARKER,
		"",
		"## Consequences",
		"",
		`- ${DERIVED_CONTENT_MARKER}`
	].join("\n");
}

function sortEntities<T extends EntityRecord>(entities: T[]): T[] {
	return [...entities].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}