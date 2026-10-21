import type { ContextRevisionPatch, ContextTermRevisionPatch } from "../context/context-types.js";
import { computeContextContentHash, computeContextTermContentHash } from "../context/context-types.js";
import type { BodySource, EntityCategory, EntityKind, EntityPriority, EntityRevisionPatch, EntityType } from "../entity-store/domain.js";
import { computeEntityContentHash, isEntityType } from "../entity-store/domain.js";
import type { CompletionObservation } from "../entity-store/store-types.js";
import { materializeContextFromPatches, materializeContextTermFromPatches } from "../context/materialize-context-revision.js";
import { decodeCanonicalReference, shortEntityReference } from "../entity-store/canonical-reference.js";
import { materializeFromPatches } from "../entity-store/materialize-revision.js";
import { computeIssueCommentContentHash, materializeIssueCommentFromPatches, type IssueCommentRevisionPatch } from "../issue-comment/issue-comment-types.js";
import { computePlanEntryContentHash, isPlanEntryRole, isPlanEntryScopeDirection, materializePlanEntryFromPatches, type PlanEntryRevisionPatch } from "../plan-entry/plan-entry-types.js";
import { mergeUserDirectories, type UserDirectoryRecord } from "../user-directory/user-directory.js";

export type CanonicalEntityDelta = EntityRevisionPatch & { id: string };
export type CanonicalContextDelta = ContextRevisionPatch & { id: string };
export type CanonicalContextTermDelta = ContextTermRevisionPatch & { id: string };
export type CanonicalIssueCommentDelta = IssueCommentRevisionPatch & { id: string };
export type CanonicalPlanEntryDelta = PlanEntryRevisionPatch & { id: string };

export type CanonicalEntityChain = {
	head: {
		id: string;
		reference: string;
		shortReference?: string;
		createdBy: string;
		updatedBy: string;
		kind: EntityKind;
		title: string;
		body: string;
		bodySource: BodySource;
		category: EntityCategory | null;
		priority: EntityPriority | null;
		type: EntityType | null;
		status: string;
		parentId: string | null;
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalEntityDelta[];
};

export type CanonicalContextChain = {
	head: {
		id: string;
		reference: string;
		shortReference?: string;
		createdBy: string;
		updatedBy: string;
		key: string;
		scopeEntityId: string | null;
		title: string;
		summary: string;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalContextDelta[];
};

export type CanonicalContextTermChain = {
	head: {
		id: string;
		reference: string;
		shortReference?: string;
		createdBy: string;
		updatedBy: string;
		contextKey: string;
		term: string;
		definition: string;
		avoid: string[];
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalContextTermDelta[];
};

export type CanonicalIssueCommentChain = {
	head: {
		id: string;
		reference: string;
		shortReference?: string;
		issueId: string;
		createdBy: string;
		updatedBy: string;
		body: string;
		referencedIssueIds: string[];
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalIssueCommentDelta[];
};

export type CanonicalPlanEntryChain = {
	head: {
		id: string;
		reference: string;
		shortReference?: string;
		planId: string;
		createdBy: string;
		updatedBy: string;
		role: "question" | "decision" | "scope" | "constraint" | "preference" | "consideration";
		body: string;
		scopeDirection: "included" | "excluded" | null;
		referencedEntityIds: string[];
		supersededEntryIds: string[];
		tombstone: boolean;
		revision: number;
		contentHash: string;
		createdAt: string;
		updatedAt: string;
	};
	deltas: CanonicalPlanEntryDelta[];
};

export type CanonicalChainBundle = {
	entities: CanonicalEntityChain[];
	contexts: CanonicalContextChain[];
	contextTerms: CanonicalContextTermChain[];
	issueComments: CanonicalIssueCommentChain[];
	planEntries: CanonicalPlanEntryChain[];
	/** Optional so bundles created before completion observations remain importable. */
	completionObservations?: CompletionObservation[];
	users: UserDirectoryRecord[];
};

export type CanonicalChainWireBundle = Omit<CanonicalChainBundle, "entities" | "contexts" | "contextTerms" | "issueComments" | "planEntries"> & {
	entities: Array<Omit<CanonicalEntityChain, "deltas"> & { deltas: Array<Omit<CanonicalEntityDelta, "reversePatch"> & { reversePatch: string }> }>;
	contexts: Array<Omit<CanonicalContextChain, "deltas"> & { deltas: Array<Omit<CanonicalContextDelta, "reversePatch"> & { reversePatch: string }> }>;
	contextTerms: Array<Omit<CanonicalContextTermChain, "deltas"> & { deltas: Array<Omit<CanonicalContextTermDelta, "reversePatch"> & { reversePatch: string }> }>;
	issueComments: Array<Omit<CanonicalIssueCommentChain, "deltas"> & { deltas: Array<Omit<CanonicalIssueCommentDelta, "reversePatch"> & { reversePatch: string }> }>;
	planEntries: Array<Omit<CanonicalPlanEntryChain, "deltas"> & { deltas: Array<Omit<CanonicalPlanEntryDelta, "reversePatch"> & { reversePatch: string }> }>;
};

export function encodeCanonicalChainBundle(bundle: CanonicalChainBundle): CanonicalChainWireBundle {
	return mapCanonicalChainBundle(bundle, (reversePatch) => Buffer.from(reversePatch).toString("base64"));
}

export function decodeCanonicalChainBundle(bundle: CanonicalChainWireBundle): CanonicalChainBundle {
	const decoded = mapCanonicalChainBundle(bundle, (reversePatch) => Uint8Array.from(Buffer.from(reversePatch, "base64"))) as CanonicalChainBundle;
	assertCanonicalBundle(decoded);
	return decoded;
}

function mapCanonicalChainBundle<Input extends CanonicalChainBundle | CanonicalChainWireBundle, Output>(
	bundle: Input,
	mapPatch: (reversePatch: Input["entities"][number]["deltas"][number]["reversePatch"]) => Output
) {
	const mapChain = <Chain extends { deltas: Array<{ reversePatch: Input["entities"][number]["deltas"][number]["reversePatch"] }> }>(chain: Chain) => ({
		...chain,
		deltas: chain.deltas.map((delta) => ({ ...delta, reversePatch: mapPatch(delta.reversePatch) }))
	});
	return {
		entities: bundle.entities.map((chain) => mapChain(chain as never)),
		contexts: bundle.contexts.map((chain) => mapChain(chain as never)),
		contextTerms: bundle.contextTerms.map((chain) => mapChain(chain as never)),
		issueComments: bundle.issueComments.map((chain) => mapChain(chain as never)),
		planEntries: bundle.planEntries.map((chain) => mapChain(chain as never)),
		completionObservations: bundle.completionObservations,
		users: bundle.users
	};
}

export type CanonicalChainImportResult = {
	entitiesCreated: string[];
	entitiesAdvanced: string[];
	contextsCreated: string[];
	contextsAdvanced: string[];
	contextTermsCreated: string[];
	contextTermsAdvanced: string[];
	issueCommentsCreated: string[];
	issueCommentsAdvanced: string[];
	planEntriesCreated: string[];
	planEntriesAdvanced: string[];
	completionObservationsCreated: string[];
	usersCreated: string[];
	usersUpdated: string[];
};

export type SynchronizeRecordKind = "entity" | "context" | "context-term" | "issue-comment" | "plan-entry";

export class SynchronizeConflictError extends Error {
	public constructor(recordKind: SynchronizeRecordKind, recordId: string, currentRevision: number, currentContentHash: string) {
		super(`Cannot synchronize divergent or stale ${recordKind} ${recordId}: current revision is ${currentRevision}.`);
		this.name = "SynchronizeConflictError";
		this.recordKind = recordKind;
		this.recordId = recordId;
		this.currentRevision = currentRevision;
		this.currentContentHash = currentContentHash;
	}

	public readonly recordKind: SynchronizeRecordKind;
	public readonly recordId: string;
	public readonly currentRevision: number;
	public readonly currentContentHash: string;
}

export class CompletionObservationConflictError extends Error {
	public constructor(observationId: string) {
		super(`Cannot synchronize completion observation ${observationId}: immutable facts differ.`);
		this.name = "CompletionObservationConflictError";
		this.observationId = observationId;
	}

	public readonly observationId: string;
}

export function mergeCanonicalChainBundles(left: CanonicalChainBundle, right: CanonicalChainBundle): CanonicalChainBundle {
	assertBundleReferenceCollisions(left, right);
	assertCanonicalBundle(left);
	assertCanonicalBundle(right);
	return {
		entities: mergeChains(left.entities, right.entities, (chain) => chain.head.id, entityHeadsMatch, assertEntityExtension),
		contexts: mergeChains(left.contexts, right.contexts, (chain) => chain.head.id, contextHeadsMatch, assertContextExtension),
		contextTerms: mergeChains(left.contextTerms, right.contextTerms, (chain) => chain.head.id, contextTermHeadsMatch, assertContextTermExtension),
		issueComments: mergeChains(left.issueComments, right.issueComments, (chain) => chain.head.id, issueCommentHeadsMatch, assertIssueCommentExtension),
		planEntries: mergeChains(left.planEntries, right.planEntries, (chain) => chain.head.id, planEntryHeadsMatch, assertPlanEntryExtension),
			...(left.completionObservations === undefined && right.completionObservations === undefined
				? {}
				: { completionObservations: mergeCompletionObservations(left.completionObservations ?? [], right.completionObservations ?? []) }),
		users: mergeUserDirectories(left.users, right.users)
	};
}

function assertCanonicalBundle(bundle: CanonicalChainBundle): void {
	const entitiesById = new Map(bundle.entities.map((chain) => [chain.head.id, chain.head]));
	const planEntriesById = new Map(bundle.planEntries.map((chain) => [chain.head.id, chain.head]));
	for (const chain of bundle.entities) {
		assertCanonicalHead(chain.head.reference, chain.head.id, chain.head.kind);
		if (chain.head.parentId !== null && !entitiesById.has(chain.head.parentId)) {
			throw new Error(`Missing canonical parent ${chain.head.parentId} for ${chain.head.id}.`);
		}
		if (chain.head.type !== null && !isEntityType(chain.head.kind, chain.head.type)) {
			throw new Error(`Invalid canonical entity type ${chain.head.type} for ${chain.head.id}.`);
		}
		const parent = chain.head.parentId === null ? null : entitiesById.get(chain.head.parentId) ?? null;
		if (chain.head.kind === "plan" && parent !== null && parent.kind !== "initiative") {
			throw new Error(`Plan ${chain.head.id} requires an initiative parent.`);
		}
		if (chain.head.type === "pioneer-map" && parent?.kind !== "initiative") {
			throw new Error(`pioneer-map ${chain.head.id} requires an initiative parent.`);
		}
		if (chain.head.type === "pioneer-ticket" && (parent?.kind !== "issue" || parent.type !== "pioneer-map")) {
			throw new Error(`pioneer-ticket ${chain.head.id} requires a pioneer-map parent.`);
		}
	}
	for (const chain of bundle.contexts) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "context");
		if (chain.head.scopeEntityId !== null && !entitiesById.has(chain.head.scopeEntityId)) {
			throw new Error(`Missing canonical context scope ${chain.head.scopeEntityId} for ${chain.head.id}.`);
		}
	}
	for (const chain of bundle.contextTerms) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "contextTerm");
	}
	for (const chain of bundle.issueComments) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "issueComment");
		const issue = entitiesById.get(chain.head.issueId);
		if (issue?.kind !== "issue") {
			throw new Error(`Missing canonical issue ${chain.head.issueId} for comment ${chain.head.id}.`);
		}
		if (chain.head.body.trim().length === 0) {
			throw new Error(`Issue comment ${chain.head.id} must have a body.`);
		}
		if (new Set(chain.head.referencedIssueIds).size !== chain.head.referencedIssueIds.length) {
			throw new Error(`Issue comment ${chain.head.id} has duplicate referenced issue IDs.`);
		}
		for (const referencedIssueId of chain.head.referencedIssueIds) {
			if (entitiesById.get(referencedIssueId)?.kind !== "issue") {
				throw new Error(`Missing canonical referenced issue ${referencedIssueId} for comment ${chain.head.id}.`);
			}
		}
	}
	for (const chain of bundle.planEntries) {
		assertCanonicalHead(chain.head.reference, chain.head.id, "planEntry");
		const plan = entitiesById.get(chain.head.planId);
		if (plan?.kind !== "plan") {
			throw new Error(`Missing canonical Plan ${chain.head.planId} for Plan entry ${chain.head.id}.`);
		}
		if (!isPlanEntryRole(chain.head.role)) {
			throw new Error(`Invalid canonical Plan entry role ${chain.head.role} for ${chain.head.id}.`);
		}
		if (chain.head.body.trim().length === 0) {
			throw new Error(`Plan entry ${chain.head.id} must have a body.`);
		}
		if (chain.head.role === "scope" && chain.head.scopeDirection === null) {
			throw new Error(`Scope Plan entry ${chain.head.id} requires a scope direction.`);
		}
		if (chain.head.scopeDirection !== null && !isPlanEntryScopeDirection(chain.head.scopeDirection)) {
			throw new Error(`Invalid canonical Plan entry scope direction ${chain.head.scopeDirection} for ${chain.head.id}.`);
		}
		if (chain.head.role !== "scope" && chain.head.scopeDirection !== null) {
			throw new Error(`Only scope Plan entries can have a scope direction: ${chain.head.id}.`);
		}
		if (new Set(chain.head.referencedEntityIds).size !== chain.head.referencedEntityIds.length) {
			throw new Error(`Plan entry ${chain.head.id} has duplicate referenced entity IDs.`);
		}
		for (const entityId of chain.head.referencedEntityIds) {
			if (!entitiesById.has(entityId)) {
				throw new Error(`Missing canonical referenced entity ${entityId} for Plan entry ${chain.head.id}.`);
			}
		}
		if (new Set(chain.head.supersededEntryIds).size !== chain.head.supersededEntryIds.length) {
			throw new Error(`Plan entry ${chain.head.id} has duplicate superseded entry IDs.`);
		}
		for (const supersededEntryId of chain.head.supersededEntryIds) {
			const supersededEntry = planEntriesById.get(supersededEntryId);
			if (!supersededEntry || supersededEntry.planId !== chain.head.planId || supersededEntry.tombstone) {
				throw new Error(`Missing canonical superseded Plan entry ${supersededEntryId} for Plan entry ${chain.head.id}.`);
			}
			if (chain.head.role === "decision" && supersededEntry.role !== "question" && supersededEntry.role !== "decision") {
				throw new Error(`Decision Plan entry ${chain.head.id} can supersede only question or decision Plan entries.`);
			}
		}
	}
	for (const observation of bundle.completionObservations ?? []) {
		if (entitiesById.get(observation.issueId)?.kind !== "issue") {
			throw new Error(`Missing canonical issue ${observation.issueId} for completion observation ${observation.id}.`);
		}
		if (observation.completionOrdinal < 1 || !Number.isInteger(observation.completionOrdinal)) {
			throw new Error(`Invalid completion ordinal for completion observation ${observation.id}.`);
		}
	}
}

function mergeCompletionObservations(left: CompletionObservation[], right: CompletionObservation[]): CompletionObservation[] {
	const merged = new Map<string, CompletionObservation>();
	for (const observation of [...left, ...right]) {
		const current = merged.get(observation.id);
		if (current !== undefined && !completionObservationsMatch(current, observation)) {
			throw new CompletionObservationConflictError(observation.id);
		}
		merged.set(observation.id, observation);
	}
	return [...merged.values()].sort((leftObservation, rightObservation) =>
		leftObservation.issueId.localeCompare(rightObservation.issueId) || leftObservation.completionOrdinal - rightObservation.completionOrdinal || leftObservation.id.localeCompare(rightObservation.id)
	);
}

function completionObservationsMatch(left: CompletionObservation, right: CompletionObservation): boolean {
	return left.issueId === right.issueId &&
		left.completionOrdinal === right.completionOrdinal &&
		left.repositoryIdentity === right.repositoryIdentity &&
		left.commitSha === right.commitSha &&
		left.branch === right.branch &&
		left.dirty === right.dirty &&
		left.capturedAt === right.capturedAt &&
		left.calculatedVersionState === right.calculatedVersionState &&
		left.calculatedVersion === right.calculatedVersion &&
		JSON.stringify(left.diagnostics) === JSON.stringify(right.diagnostics);
}

function assertCanonicalHead(reference: string, id: string, expectedKind: EntityKind | "context" | "contextTerm" | "issueComment" | "planEntry"): void {
	const decoded = decodeCanonicalReference(reference);
	if (decoded.kind !== expectedKind || decoded.stableId !== id) {
		throw new Error(`Canonical reference ${reference} does not match ${expectedKind} Stable identity ${id}.`);
	}
}

function assertBundleReferenceCollisions(left: CanonicalChainBundle, right: CanonicalChainBundle): void {
	assertUniqueAcrossBundles(left.entities, right.entities, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.entities, right.entities, (chain) => shortEntityReference(chain.head), (chain) => chain.head.id, "short-reference");
	assertUniqueAcrossBundles(left.contexts, right.contexts, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.contexts, right.contexts, (chain) => shortEntityReference({ id: chain.head.id, kind: "context", shortReference: chain.head.shortReference }), (chain) => chain.head.id, "short-reference");
	assertUniqueAcrossBundles(left.contexts, right.contexts, (chain) => chain.head.key, (chain) => chain.head.id, "context-key");
	assertUniqueAcrossBundles(left.contextTerms, right.contextTerms, (chain) => shortEntityReference({ id: chain.head.id, kind: "contextTerm", shortReference: chain.head.shortReference }), (chain) => chain.head.id, "short-reference");
	assertUniqueAcrossBundles(left.contextTerms, right.contextTerms, (chain) => `${chain.head.contextKey}\0${chain.head.term.toLocaleLowerCase()}`, (chain) => chain.head.id, "term-name");
	assertUniqueAcrossBundles(left.issueComments, right.issueComments, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.issueComments, right.issueComments, (chain) => shortEntityReference({ id: chain.head.id, kind: "issueComment", shortReference: chain.head.shortReference }), (chain) => chain.head.id, "short-reference");
	assertUniqueAcrossBundles(left.planEntries, right.planEntries, (chain) => chain.head.reference, (chain) => chain.head.id, "canonical-reference");
	assertUniqueAcrossBundles(left.planEntries, right.planEntries, (chain) => shortEntityReference({ id: chain.head.id, kind: "planEntry", shortReference: chain.head.shortReference }), (chain) => chain.head.id, "short-reference");
}

function assertUniqueAcrossBundles<Chain>(left: Chain[], right: Chain[], keyOf: (chain: Chain) => string, identityOf: (chain: Chain) => string, collisionClass: string): void {
	const identities = new Map<string, string>();
	for (const chain of [...left, ...right]) {
		const key = keyOf(chain);
		const identity = identityOf(chain);
		const existing = identities.get(key);
		if (existing !== undefined && existing !== identity) {
			throw new Error(`Synchronization preflight ${collisionClass} collision: ${key}.`);
		}
		identities.set(key, identity);
	}
}

function mergeChains<Chain extends { head: { revision: number; contentHash: string } }>(
	left: Chain[],
	right: Chain[],
	keyOf: (chain: Chain) => string,
	headsMatch: (left: Chain, right: Chain) => boolean,
	assertExtension: (candidate: Chain, current: Chain) => void
): Chain[] {
	const merged = new Map(left.map((chain) => [keyOf(chain), chain]));
	for (const candidate of right) {
		const key = keyOf(candidate);
		const current = merged.get(key);
		if (!current) {
			merged.set(key, candidate);
			continue;
		}
		if (candidate.head.revision === current.head.revision && headsMatch(candidate, current)) {
			continue;
		}
		if (candidate.head.revision > current.head.revision) {
			assertExtension(candidate, current);
			merged.set(key, candidate);
			continue;
		}
		if (candidate.head.revision < current.head.revision) {
			assertExtension(current, candidate);
			continue;
		}
		throwConflict(current);
	}
	return [...merged.values()];
}

function entityHeadsMatch(left: CanonicalEntityChain, right: CanonicalEntityChain): boolean {
	return left.head.reference === right.head.reference && shortEntityReference(left.head) === shortEntityReference(right.head) && left.head.createdBy === right.head.createdBy && left.head.updatedBy === right.head.updatedBy && left.head.contentHash === right.head.contentHash && left.head.kind === right.head.kind && left.head.title === right.head.title && left.head.body === right.head.body && left.head.bodySource === right.head.bodySource && left.head.category === right.head.category && left.head.priority === right.head.priority && left.head.type === right.head.type && left.head.status === right.head.status && left.head.parentId === right.head.parentId && left.head.tombstone === right.head.tombstone;
}

function contextHeadsMatch(left: CanonicalContextChain, right: CanonicalContextChain): boolean {
	return left.head.reference === right.head.reference && shortEntityReference({ id: left.head.id, kind: "context", shortReference: left.head.shortReference }) === shortEntityReference({ id: right.head.id, kind: "context", shortReference: right.head.shortReference }) && left.head.createdBy === right.head.createdBy && left.head.updatedBy === right.head.updatedBy && left.head.key === right.head.key && left.head.contentHash === right.head.contentHash && left.head.scopeEntityId === right.head.scopeEntityId && left.head.title === right.head.title && left.head.summary === right.head.summary;
}

function contextTermHeadsMatch(left: CanonicalContextTermChain, right: CanonicalContextTermChain): boolean {
	return left.head.reference === right.head.reference && shortEntityReference({ id: left.head.id, kind: "contextTerm", shortReference: left.head.shortReference }) === shortEntityReference({ id: right.head.id, kind: "contextTerm", shortReference: right.head.shortReference }) && left.head.createdBy === right.head.createdBy && left.head.updatedBy === right.head.updatedBy && left.head.contentHash === right.head.contentHash && left.head.contextKey === right.head.contextKey && left.head.term === right.head.term && left.head.definition === right.head.definition && JSON.stringify(left.head.avoid) === JSON.stringify(right.head.avoid) && left.head.tombstone === right.head.tombstone;
}

function issueCommentHeadsMatch(left: CanonicalIssueCommentChain, right: CanonicalIssueCommentChain): boolean {
	return left.head.reference === right.head.reference && shortEntityReference({ id: left.head.id, kind: "issueComment", shortReference: left.head.shortReference }) === shortEntityReference({ id: right.head.id, kind: "issueComment", shortReference: right.head.shortReference }) && left.head.issueId === right.head.issueId && left.head.createdBy === right.head.createdBy && left.head.updatedBy === right.head.updatedBy && left.head.contentHash === right.head.contentHash && left.head.body === right.head.body && JSON.stringify(left.head.referencedIssueIds) === JSON.stringify(right.head.referencedIssueIds) && left.head.tombstone === right.head.tombstone;
}

function planEntryHeadsMatch(left: CanonicalPlanEntryChain, right: CanonicalPlanEntryChain): boolean {
	return left.head.reference === right.head.reference && shortEntityReference({ id: left.head.id, kind: "planEntry", shortReference: left.head.shortReference }) === shortEntityReference({ id: right.head.id, kind: "planEntry", shortReference: right.head.shortReference }) && left.head.planId === right.head.planId && left.head.createdBy === right.head.createdBy && left.head.updatedBy === right.head.updatedBy && left.head.contentHash === right.head.contentHash && left.head.role === right.head.role && left.head.body === right.head.body && left.head.scopeDirection === right.head.scopeDirection && JSON.stringify(left.head.referencedEntityIds) === JSON.stringify(right.head.referencedEntityIds) && JSON.stringify(left.head.supersededEntryIds) === JSON.stringify(right.head.supersededEntryIds) && left.head.tombstone === right.head.tombstone;
}

function assertEntityExtension(candidate: CanonicalEntityChain, current: CanonicalEntityChain): void {
	const materialized = materializeFromPatches(candidate.head.id, candidate.head, candidate.deltas, current.head.revision);
	const expected = current.head;
	if (materialized.title !== expected.title || materialized.body !== expected.body || materialized.bodySource !== expected.bodySource || materialized.category !== expected.category || materialized.priority !== expected.priority || materialized.type !== expected.type || materialized.status !== expected.status || materialized.parentId !== expected.parentId || materialized.tombstone !== expected.tombstone || computeEntityContentHash(materialized.title, materialized.body) !== expected.contentHash) {
		throwConflict(current);
	}
}

function assertContextExtension(candidate: CanonicalContextChain, current: CanonicalContextChain): void {
	const materialized = materializeContextFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (materialized.title !== current.head.title || materialized.summary !== current.head.summary || candidate.head.scopeEntityId !== current.head.scopeEntityId || computeContextContentHash(materialized.title, materialized.summary) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function assertContextTermExtension(candidate: CanonicalContextTermChain, current: CanonicalContextTermChain): void {
	const materialized = materializeContextTermFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (candidate.head.contextKey !== current.head.contextKey || materialized.id !== current.head.id || materialized.term !== current.head.term || materialized.definition !== current.head.definition || JSON.stringify(materialized.avoid) !== JSON.stringify(current.head.avoid) || materialized.tombstone !== current.head.tombstone || computeContextTermContentHash(materialized.term, materialized.definition, materialized.avoid, materialized.tombstone) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function assertIssueCommentExtension(candidate: CanonicalIssueCommentChain, current: CanonicalIssueCommentChain): void {
	const materialized = materializeIssueCommentFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (candidate.head.issueId !== current.head.issueId || materialized.body !== current.head.body || JSON.stringify(materialized.referencedIssueIds) !== JSON.stringify(current.head.referencedIssueIds) || materialized.tombstone !== current.head.tombstone || computeIssueCommentContentHash(materialized.body, materialized.referencedIssueIds, materialized.tombstone) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function assertPlanEntryExtension(candidate: CanonicalPlanEntryChain, current: CanonicalPlanEntryChain): void {
	const materialized = materializePlanEntryFromPatches(candidate.head, candidate.deltas, current.head.revision);
	if (candidate.head.planId !== current.head.planId || materialized.role !== current.head.role || materialized.body !== current.head.body || materialized.scopeDirection !== current.head.scopeDirection || JSON.stringify(materialized.referencedEntityIds) !== JSON.stringify(current.head.referencedEntityIds) || JSON.stringify(materialized.supersededEntryIds) !== JSON.stringify(current.head.supersededEntryIds) || materialized.tombstone !== current.head.tombstone || computePlanEntryContentHash(materialized) !== current.head.contentHash) {
		throwConflict(current);
	}
}

function throwConflict(chain: { head: { revision: number; contentHash: string; id?: string; key?: string; kind?: EntityKind; term?: string; issueId?: string; planId?: string } }): never {
	const recordKind: SynchronizeRecordKind = "kind" in chain.head ? "entity" : "term" in chain.head ? "context-term" : "issueId" in chain.head ? "issue-comment" : "planId" in chain.head ? "plan-entry" : "context";
	const recordId = recordKind === "context" ? chain.head.key! : chain.head.id!;
	throw new SynchronizeConflictError(recordKind, recordId, chain.head.revision, chain.head.contentHash);
}