import { createHash, randomUUID } from "node:crypto";
import { ALLOWED_RELATIONS, DEFAULT_EPIC_ID, DEFAULT_PROJECT_ID, RESERVED_SYSTEM_AUTHOR, computeEntityContentHash, isStructuralRelationType, isValidStatus } from "../entity-store/domain.js";
import { deriveMigratedEntityIdentity } from "../entity-store/canonical-reference.js";
import { DEFAULT_CONTEXT_KEY, computeContextContentHash, computeContextTermContentHash } from "../context/context-types.js";
import type { CanonicalContextChain } from "../synchronize/canonical-chain.js";
import { computeIssueCommentContentHash } from "../issue-comment/issue-comment-types.js";
import { computePlanEntryContentHash } from "../plan-entry/plan-entry-types.js";
import {
	applyReverseFieldPatch, createReverseFieldPatch,
	CONTEXT_REVERSE_PATCH_REGISTRY, CONTEXT_TERM_REVERSE_PATCH_REGISTRY, ENTITY_REVERSE_PATCH_REGISTRY,
	ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, PLAN_ENTRY_REVERSE_PATCH_REGISTRY,
	type ReversePatchRegistry, type ReverseFieldPatchTransition
} from "../reverse-field-patch/reverse-field-patch.js";
import { assignMigrationAuthorship, compareMigrationRecordCounts, decodeMigrationBundle, encodeMigrationBundle, type MigrationBundle, type MigrationRecordCounts } from "./migration-bundle.js";

export function selectProjectBundle(bundle: MigrationBundle, projectId: string, includeInstructions = false): MigrationBundle {
	const seededIds = new Set([deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId, deriveMigratedEntityIdentity("epic", DEFAULT_EPIC_ID).stableId]);
	const entities = bundle.chains.entities
		.filter((chain) => chain.head.id === projectId || chain.head.projectId === projectId)
		.map((chain) => {
			const bootstrapRecord = seededIds.has(chain.head.id) || (["project", "epic"].includes(chain.head.kind) && chain.head.bodySource === "generated");
			if (!bootstrapRecord || chain.head.revision !== 1 || chain.deltas.length !== 0 || (chain.head.contentHash !== "" && chain.head.contentHash !== archiveHeadContentHash(chain.head))) return chain;
			// Older databases created these bootstrap records without a baseline.
			const head = { ...chain.head, createdBy: chain.head.createdBy ?? RESERVED_SYSTEM_AUTHOR, updatedBy: chain.head.updatedBy ?? RESERVED_SYSTEM_AUTHOR, contentHash: archiveHeadContentHash(chain.head) };
			return { head, deltas: [{ id: randomUUID(), revision: 1, author: head.createdBy, createdAt: head.createdAt, ...createReverseFieldPatch(head, head, ENTITY_REVERSE_PATCH_REGISTRY) }] };
		});
	const ids = new Set(entities.map((chain) => chain.head.id));
	const contexts = bundle.chains.contexts.filter((chain) => isProjectContext(chain.head, projectId, ids));
	const contextKeys = new Set(contexts.map((chain) => chain.head.key));
	const chains = {
		entities,
		contexts,
		contextTerms: bundle.chains.contextTerms.filter((chain) => contextKeys.has(chain.head.contextKey)),
		issueComments: bundle.chains.issueComments.filter((chain) => ids.has(chain.head.issueId)),
		planEntries: bundle.chains.planEntries.filter((chain) => ids.has(chain.head.planId)),
		completionObservations: (bundle.chains.completionObservations ?? []).filter((record) => ids.has(record.issueId)),
		users: bundle.chains.users
	};
	const relations = bundle.relations.filter((record) => ids.has(record.fromId) || ids.has(record.toId));
	const authors = new Set(relations.map((record) => record.createdBy));
	for (const group of [chains.entities, chains.contexts, chains.contextTerms, chains.issueComments, chains.planEntries]) {
		for (const chain of group) {
			authors.add(chain.head.createdBy);
			authors.add(chain.head.updatedBy);
			for (const delta of chain.deltas) authors.add(delta.author);
		}
	}
	const selected = {
		chains: { ...chains, users: chains.users.filter((user) => authors.has(user.id)) },
		relations,
		issueBreakdownDrafts: bundle.issueBreakdownDrafts.filter((record) => ids.has(record.targetId)),
		projectSettings: bundle.projectSettings.filter((record) => record.projectId === projectId),
		instructions: includeInstructions ? bundle.instructions : { overrides: [], personalFragments: [], history: [] }
	};
	const canonical = assignMigrationAuthorship(selected);
	validateProjectBundle(canonical, projectId);
	return canonical;
}

function isProjectContext(head: CanonicalContextChain["head"], projectId: string, entityIds: ReadonlySet<string>): boolean {
	if (head.scopeEntityId !== null) return entityIds.has(head.scopeEntityId);
	if (head.key === `${DEFAULT_CONTEXT_KEY}:${projectId}`) return true;
	const seededProjectId = deriveMigratedEntityIdentity("project", DEFAULT_PROJECT_ID).stableId;
	return projectId === seededProjectId && (head.key === DEFAULT_CONTEXT_KEY || head.key === `${DEFAULT_CONTEXT_KEY}:${DEFAULT_PROJECT_ID}`);
}

export function validateProjectBundle(bundle: MigrationBundle, projectId: string): void {
	decodeMigrationBundle(encodeMigrationBundle(bundle));
	const entities = new Map(bundle.chains.entities.map((chain) => [chain.head.id, chain.head]));
	if (bundle.chains.entities.filter((chain) => chain.head.kind === "project").length !== 1 || entities.get(projectId)?.kind !== "project") {
		throw new Error("A project archive must contain exactly one project.");
	}
	for (const chain of bundle.chains.entities) {
		if (chain.head.id !== projectId && chain.head.projectId !== projectId) throw new Error(`Record ${chain.head.reference} belongs to another project.`);
		if (!isValidStatus(chain.head.kind, chain.head.status)) throw new Error(`Invalid archive status: ${chain.head.reference}.`);
		const visited = new Set<string>();
		let head = chain.head;
		while (head.parentId !== null) {
			if (visited.has(head.id)) throw new Error(`Archive parent cycle: ${chain.head.reference}.`);
			visited.add(head.id);
			head = entities.get(head.parentId)!;
		}
	}
	for (const relation of bundle.relations) {
		const from = entities.get(relation.fromId);
		const to = entities.get(relation.toId);
		if (!ALLOWED_RELATIONS.some((allowed) => allowed.fromKind === from?.kind && allowed.toKind === to?.kind && allowed.type === relation.type)) {
			throw new Error(`Invalid or external project relation: ${relation.fromId} ${relation.type} ${relation.toId}.`);
		}
		if (isStructuralRelationType(relation.type) && to?.parentId !== relation.fromId) throw new Error("Archive structural relations do not match parent metadata.");
	}
	const contextKeys = new Set(bundle.chains.contexts.map((chain) => chain.head.key));
	const entityIds = new Set(entities.keys());
	if (bundle.chains.contexts.some((chain) => !isProjectContext(chain.head, projectId, entityIds)) || bundle.chains.contextTerms.some((chain) => !contextKeys.has(chain.head.contextKey))) {
		throw new Error("Archive context has an invalid project scope.");
	}
	for (const group of [bundle.chains.entities, bundle.chains.contexts, bundle.chains.contextTerms, bundle.chains.issueComments, bundle.chains.planEntries]) {
		if (new Set(group.map((chain) => chain.head.id)).size !== group.length) throw new Error("Duplicate archive record ID.");
	}
	for (const chain of bundle.chains.entities) validateChain(chain, ENTITY_REVERSE_PATCH_REGISTRY, archiveHeadContentHash(chain.head));
	for (const chain of bundle.chains.contexts) validateChain(chain, CONTEXT_REVERSE_PATCH_REGISTRY, archiveHeadContentHash(chain.head));
	for (const chain of bundle.chains.contextTerms) validateChain(chain, CONTEXT_TERM_REVERSE_PATCH_REGISTRY, archiveHeadContentHash(chain.head));
	for (const chain of bundle.chains.issueComments) validateChain(chain, ISSUE_COMMENT_REVERSE_PATCH_REGISTRY, archiveHeadContentHash(chain.head));
	for (const chain of bundle.chains.planEntries) validateChain(chain, PLAN_ENTRY_REVERSE_PATCH_REGISTRY, archiveHeadContentHash(chain.head));
	if (bundle.projectSettings.some((record) => record.projectId !== projectId) || bundle.issueBreakdownDrafts.some((record) => !entities.has(record.targetId))) {
		throw new Error("Archive settings or drafts belong to another project.");
	}
	for (const records of Object.values(bundle.instructions)) for (const record of records) {
		if (createHash("sha256").update(record.body).digest("hex") !== record.contentHash) throw new Error(`Archive instruction hash mismatch: ${record.itemKey}.`);
	}
}

export function verifyProjectRestoreCounts(bundle: MigrationBundle, actual: MigrationRecordCounts): void {
	const { chains, instructions } = bundle;
	const expected: MigrationRecordCounts = {
		entities: chains.entities.length, relations: bundle.relations.length, contexts: chains.contexts.length,
		contextTerms: chains.contextTerms.length, issueComments: chains.issueComments.length, planEntries: chains.planEntries.length,
		completionObservations: (chains.completionObservations ?? []).length,
		revisionEntries: [chains.entities, chains.contexts, chains.contextTerms, chains.issueComments, chains.planEntries].reduce((total, group) => total + group.reduce((count, chain) => count + chain.deltas.length, 0), 0),
		issueBreakdownDrafts: bundle.issueBreakdownDrafts.length, projectSettings: bundle.projectSettings.length,
		instructionOverrides: instructions.overrides.length, instructionPersonalFragments: instructions.personalFragments.length, instructionHistory: instructions.history.length
	};
	const mismatched = compareMigrationRecordCounts(expected, actual);
	if (mismatched.length > 0) throw new Error(`Project restore record counts differ: ${mismatched.join(", ")}.`);
}

export function archiveHeadContentHash(head: MigrationBundle["chains"]["entities" | "contexts" | "contextTerms" | "issueComments" | "planEntries"][number]["head"]): string {
	if ("kind" in head) return computeEntityContentHash(head.title, head.body);
	if ("summary" in head) return computeContextContentHash(head.title, head.summary);
	if ("definition" in head) return computeContextTermContentHash(head.term, head.definition, head.avoid, head.tombstone);
	if ("role" in head) {
		const { role, body, scopeDirection, referencedEntityIds, supersededEntryIds, tombstone } = head;
		return computePlanEntryContentHash({ role, body, scopeDirection, referencedEntityIds, supersededEntryIds, tombstone });
	}
	return computeIssueCommentContentHash(head.body, head.referencedIssueIds, head.tombstone);
}

function validateChain(chain: { head: { reference: string; revision: number; contentHash: string }; deltas: Array<ReverseFieldPatchTransition & { revision: number }> }, registry: ReversePatchRegistry, contentHash: string): void {
	if (chain.head.contentHash !== contentHash) throw new Error(`Archive content hash mismatch: ${chain.head.reference}.`);
	let state: object = chain.head;
	let revision = chain.head.revision;
	for (const delta of [...chain.deltas].sort((left, right) => right.revision - left.revision)) {
		if (delta.revision !== revision--) throw new Error(`Archive revision gap: ${chain.head.reference}.`);
		state = applyReverseFieldPatch(state, delta, registry);
	}
	if (revision !== 0) throw new Error(`Archive history is incomplete: ${chain.head.reference}.`);
}
