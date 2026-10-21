import { createHash } from "node:crypto";

import { materializeRevisionChain } from "../entity-store/materialize-revision-chain.js";
import { applyReverseFieldPatch, PLAN_ENTRY_REVERSE_PATCH_REGISTRY, type ReverseFieldPatchTransition } from "../reverse-field-patch/reverse-field-patch.js";

export const PLAN_ENTRY_ROLES = ["question", "decision", "scope", "constraint", "preference", "consideration"] as const;
export const PLAN_ENTRY_SCOPE_DIRECTIONS = ["included", "excluded"] as const;

export type PlanEntryRole = (typeof PLAN_ENTRY_ROLES)[number];
export type PlanEntryScopeDirection = (typeof PLAN_ENTRY_SCOPE_DIRECTIONS)[number];

export type PlanEntryRecord = {
	id: string;
	reference: string;
	shortReference: string;
	planId: string;
	createdBy: string;
	updatedBy: string;
	role: PlanEntryRole;
	body?: string;
	scopeDirection: PlanEntryScopeDirection | null;
	referencedEntityIds: string[];
	supersededEntryIds: string[];
	tombstone: boolean;
	revision: number;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
};

export type PlanEntrySummary = Omit<PlanEntryRecord, "body">;

export function toPlanEntrySummary(entry: PlanEntryRecord): PlanEntrySummary {
	const { body: _body, ...summary } = entry;
	return summary;
}

export type PlanEntryPage = {
	entries: PlanEntryRecord[];
	total: number;
	nextBefore: string | null;
};

export const PLAN_CURRENT_GROUPS = [
	{ key: "questions", title: "Questions" },
	{ key: "decisions", title: "Decisions" },
	{ key: "includedScope", title: "Included scope" },
	{ key: "excludedScope", title: "Excluded scope" },
	{ key: "constraints", title: "Constraints" },
	{ key: "preferences", title: "Preferences" },
	{ key: "considerations", title: "Considerations" }
] as const;

export type PlanCurrentGroupKey = (typeof PLAN_CURRENT_GROUPS)[number]["key"];

export type PlanCurrentGroup = {
	key: PlanCurrentGroupKey;
	title: string;
	entries: PlanEntryRecord[];
};

export type PlanEntryProjection = {
	current: PlanCurrentGroup[];
	history: PlanEntryRecord[];
};

export type PlanEntryState = {
	role: PlanEntryRole;
	body: string;
	scopeDirection: PlanEntryScopeDirection | null;
	referencedEntityIds: string[];
	supersededEntryIds: string[];
	tombstone: boolean;
};

export type PlanEntryRevisionPatch = ReverseFieldPatchTransition & {
	revision: number;
	author: string;
	createdAt: string;
	restoredFromRevision?: number;
};

export type PlanEntryHistoryEntry = PlanEntryState & {
	entryId: string;
	targetRevision: number;
	headRevision: number;
	author: string;
	createdAt: string;
	restoredFromRevision: number | null;
};

export class PlanEntryConflictError extends Error {
	public constructor(entryId: string, currentRevision: number, currentContentHash: string) {
		super(`Stale edit for Plan entry ${entryId}: current revision is ${currentRevision}.`);
		this.name = "PlanEntryConflictError";
		this.entryId = entryId;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}

	public readonly entryId: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;
}

export function isPlanEntryRole(value: string): value is PlanEntryRole {
	return PLAN_ENTRY_ROLES.includes(value as PlanEntryRole);
}

export function isPlanEntryScopeDirection(value: string): value is PlanEntryScopeDirection {
	return PLAN_ENTRY_SCOPE_DIRECTIONS.includes(value as PlanEntryScopeDirection);
}

export function projectPlanEntries(entries: readonly PlanEntryRecord[]): PlanEntryProjection {
	const history = [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reference.localeCompare(right.reference));
	const supersededEntryIds = new Set(history.flatMap((entry) => entry.supersededEntryIds));
	const activeEntries = history.filter((entry) => !entry.tombstone && !supersededEntryIds.has(entry.id));

	return {
		current: PLAN_CURRENT_GROUPS.map((group) => ({
			key: group.key,
			title: group.title,
			entries: activeEntries.filter((entry) => belongsToCurrentGroup(entry, group.key))
		})),
		history
	};
}

export function getActivePlanReferencedEntityIds(entries: readonly PlanEntryRecord[]): string[] {
	return [...new Set(projectPlanEntries(entries).current.flatMap((group) => group.entries.flatMap((entry) => entry.referencedEntityIds)))];
}

export function computePlanEntryContentHash(input: {
	role: PlanEntryRole;
	body: string;
	scopeDirection: PlanEntryScopeDirection | null;
	referencedEntityIds: string[];
	supersededEntryIds: string[];
	tombstone: boolean;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function materializePlanEntryFromPatches(
	head: PlanEntryState & { revision: number; createdAt: string },
	patches: PlanEntryRevisionPatch[],
	targetRevision: number
): PlanEntryState {
	return materializeRevisionChain({
		recordLabel: "Plan entry",
		headState: {
			role: head.role,
			body: head.body,
			scopeDirection: head.scopeDirection,
			referencedEntityIds: head.referencedEntityIds,
			supersededEntryIds: head.supersededEntryIds,
			tombstone: head.tombstone
		},
		headRevision: head.revision,
		headCreatedAt: head.createdAt,
		patches,
		targetRevision,
		applyReversePatch: (state, patch) => applyReverseFieldPatch(state, patch, PLAN_ENTRY_REVERSE_PATCH_REGISTRY),
		createError: (message) => new Error(message)
	}).state;
}

function belongsToCurrentGroup(entry: PlanEntryRecord, groupKey: PlanCurrentGroupKey): boolean {
	switch (groupKey) {
		case "questions":
			return entry.role === "question";
		case "decisions":
			return entry.role === "decision";
		case "includedScope":
			return entry.role === "scope" && entry.scopeDirection === "included";
		case "excludedScope":
			return entry.role === "scope" && entry.scopeDirection === "excluded";
		case "constraints":
			return entry.role === "constraint";
		case "preferences":
			return entry.role === "preference";
		case "considerations":
			return entry.role === "consideration";
	}
}