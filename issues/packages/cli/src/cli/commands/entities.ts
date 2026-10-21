import { Option } from "clipanion";

import { ALLOWED_RELATIONS, computeContextContentHash, computeContextTermContentHash, computeEntityContentHash, isEntityKind, isValidStatus, projectPlanEntries, type EntityRecord, type EntitySummary, type RelationDirection, type RelationType, type StorageDriver } from "@agent-issues/core";

import {
	toCompactCreateAcknowledgement,
	toCompactContextRestoreAcknowledgement,
	toCompactContextTermRestoreAcknowledgement,
	toCompactDeleteAcknowledgement,
	toCompactEditAcknowledgement,
	toCompactEntityDetails,
	toCompactEntityList,
	toCompactEntityRestoreAcknowledgement,
	toCompactLinkAcknowledgement,
	toCompactMoveAcknowledgement,
	toCompactNextWork,
	toCompactStatusAcknowledgement
} from "../../context/entity-projection.js";
import { renderEntityDetails, renderEntityList, renderInitiativeBundle, renderOptionalEntityList, renderPlanDetails } from "../renderers.js";
import { BodyTenantCommand, TenantCommand, parseCsvOption, parseEntityView, parsePositiveIntegerOption, requireOption, requirePositional, withStore } from "../shared.js";

abstract class PositionalsTenantCommand extends TenantCommand {
	public positionals = Option.Rest();
}

function parseRevision(value: string): number {
	const revision = Number(value);
	if (!Number.isInteger(revision) || revision < 1) {
		throw new Error(`Revision must be a positive integer: ${value}`);
	}
	return revision;
}

export class CreateCommand extends BodyTenantCommand {
	public static paths = [["create"]];

	public category = Option.String("--category");
	public links = Option.Array("--link", { arity: 2 });
	public parent = Option.String("--parent");
	public positionals = Option.Rest();
	public priority = Option.String("--priority");
	public statusValue = Option.String("--status");
	public title = Option.String("--title");
	public entityType = Option.String("--type");

	public async execute(): Promise<number> {
		const kind = requirePositional(this.positionals, 0, "create <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}

		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entity = await store.createEntity({
				body: await this.resolveBody(),
				category: this.category,
				kind,
				links: this.links?.map(([relationType, targetId]) => ({ relationType, targetId })),
				parentId: this.parent,
				priority: this.priority,
				status: this.statusValue,
				title: requireOption(this.title, "--title is required for create."),
				type: this.entityType
			});

			this.print(this.asJson ? toCompactCreateAcknowledgement(entity) : entity, `${entity.reference} ${entity.kind} ${entity.status} ${entity.title}`);
			return 0;
		});
	}
}

export class EditCommand extends BodyTenantCommand {
	public static paths = [["edit"]];

	public category = Option.String("--category");
	public positionals = Option.Rest();
	public priority = Option.String("--priority");
	public title = Option.String("--title");
	public entityType = Option.String("--type");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "edit <id> (--title <text> | --body-file <path|->)");
			const body = await this.resolveBody();
			if (this.title === undefined && body === undefined && this.category === undefined && this.priority === undefined && this.entityType === undefined) {
				throw new Error("--title, --body-file, --category, --priority, or --type is required for edit.");
			}
			const { entity: current } = await store.getEntityDetails(entityId);
			const entity = await store.updateEntity({ body, category: this.category, entityId, priority: this.priority, title: this.title, type: this.entityType, expectedRevision: current.revision, expectedContentHash: current.contentHash });

			this.print(this.asJson ? toCompactEditAcknowledgement(entity) : entity, `Updated ${entity.id} ${entity.kind} ${entity.title}`);
			return 0;
		});
	}
}

export class HistoryCommand extends TenantCommand {
	public static paths = [["history"]];

	public contextScope = Option.String("--context");
	public positionals = Option.Rest();
	public revisionValue = Option.String("--revision", { required: true });
	public term = Option.String("--term");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const revision = parseRevision(this.revisionValue);
			if (this.contextScope) {
				if (this.positionals.length > 0) {
					throw new Error("History accepts either an entity id or --context, not both.");
				}
				if (this.term) {
					const materialized = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision });
					this.print(materialized, `${materialized.contextKey} term ${materialized.term} revision ${materialized.targetRevision}/${materialized.headRevision}${materialized.tombstone ? " tombstoned" : ""}\n${materialized.definition}\nAvoid: ${materialized.avoid.join(", ") || "none"}`);
					return 0;
				}

				const materialized = await store.materializeContextRevision({ scopeRef: this.contextScope, revision });
				this.print(materialized, `${materialized.contextKey} context revision ${materialized.targetRevision}/${materialized.headRevision} ${materialized.title}\n${materialized.summary}`);
				return 0;
			}
			if (this.term) {
				throw new Error("--term requires --context <scope>.");
			}

			const entityId = requirePositional(this.positionals, 0, "history <id> --revision <revision>");
			const materialized = await store.materializeEntityRevision({ entityId, revision });
			this.print(
				materialized,
				`${materialized.entityId} revision ${materialized.targetRevision}/${materialized.headRevision} ${materialized.status} ${materialized.title}\n${materialized.body}`
			);
			return 0;
		});
	}
}

export class RestoreCommand extends PositionalsTenantCommand {
	public static paths = [["restore"]];

	public contextScope = Option.String("--context");
	public revisionValue = Option.String("--revision", { required: true });
	public term = Option.String("--term");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		if (!this.contextScope && this.view !== undefined) {
			throw new Error("--view is only valid for context restore.");
		}
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const revision = parseRevision(this.revisionValue);
			if (this.contextScope) {
				const view = parseEntityView(this.view);
				if (this.positionals.length > 0) {
					throw new Error("Restore accepts either an entity id or --context, not both.");
				}
				if (this.term) {
					const source = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision });
					const head = await store.materializeContextTermRevision({ scopeRef: this.contextScope, term: this.term, revision: source.headRevision });
					const restored = await store.restoreContextTermRevision({
						scopeRef: this.contextScope,
						term: this.term,
						revision,
						expectedRevision: head.headRevision,
						expectedContentHash: computeContextTermContentHash(head.term, head.definition, head.avoid, head.tombstone)
					});
					this.print(this.asJson && view === "compact" ? toCompactContextTermRestoreAcknowledgement(restored) : restored, `Restored ${restored.contextKey} term ${restored.term} revision ${revision} as revision ${restored.headRevision}`);
					return 0;
				}

				const source = await store.materializeContextRevision({ scopeRef: this.contextScope, revision });
				const head = await store.materializeContextRevision({ scopeRef: this.contextScope, revision: source.headRevision });
				const restored = await store.restoreContextRevision({
					scopeRef: this.contextScope,
					revision,
					expectedRevision: head.headRevision,
					expectedContentHash: computeContextContentHash(head.title, head.summary)
				});
				this.print(this.asJson && view === "compact" ? toCompactContextRestoreAcknowledgement(restored) : restored, `Restored ${restored.contextKey} context revision ${revision} as revision ${restored.headRevision}`);
				return 0;
			}
			if (this.term) {
				throw new Error("--term requires --context <scope>.");
			}

			const entityId = requirePositional(this.positionals, 0, "restore <id> --revision <revision>");
			const source = await store.materializeEntityRevision({ entityId, revision });
			const head = await store.materializeEntityRevision({ entityId, revision: source.headRevision });
			const restored = await store.restoreEntityRevision({
				entityId,
				revision,
				expectedRevision: head.headRevision,
				expectedContentHash: computeEntityContentHash(head.title, head.body)
			});
			this.print(this.asJson ? toCompactEntityRestoreAcknowledgement(restored) : restored, `Restored ${entityId} revision ${revision} as revision ${restored.headRevision}`);
			return 0;
		});
	}
}

export class ArchiveCommand extends PositionalsTenantCommand {
	public static paths = [["archive"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "archive <id>");
			const result = await store.archiveEntity({ entityId });

			this.print(this.asJson ? toCompactStatusAcknowledgement("archive", result) : result, `Archived ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

export class DeleteCommand extends PositionalsTenantCommand {
	public static paths = [["delete"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "delete <id>");
			const result = await store.deleteEntity({ entityId });

			this.print(this.asJson ? toCompactDeleteAcknowledgement(result) : result, `Deleted ${result.entity.id} ${result.entity.kind} ${result.entity.title}`);
			return 0;
		});
	}
}

export class MoveCommand extends PositionalsTenantCommand {
	public static paths = [["move"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "move <id> <newParentId>");
			const newParentId = requirePositional(this.positionals, 1, "move <id> <newParentId>");
			const result = await store.moveEntity({ entityId, newParentId });

			this.print(
				this.asJson ? toCompactMoveAcknowledgement(result) : result,
				`Moved ${result.entity.id} from ${result.previousParentId ?? "none"} to ${result.newParentId} as ${result.relationType}`
			);
			return 0;
		});
	}
}

export class LinkCommand extends PositionalsTenantCommand {
	public static paths = [["link"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "link <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "link <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "link <fromId> <relationType> <toId>");
			const planEntry = await findPlanEntry(store, fromId);
			if (planEntry) {
				if (relationType !== "informs") {
					throw new Error("Plan entries can link to entities only as informs. Valid relation types: informs.");
				}

				const result = await store.linkPlanEntryEntity({ entryId: planEntry.id, targetId: toId });
				this.print(
					this.asJson ? toCompactLinkAcknowledgement("link", result) : result,
					result.created
						? `Linked ${fromId} -> ${toId} as ${relationType}`
						: `Relation already existed: ${fromId} -> ${toId} as ${relationType}`
				);
				return 0;
			}

			const result = await store.linkEntities({ fromId, relationType, toId });

			this.print(
				this.asJson ? toCompactLinkAcknowledgement("link", result) : result,
				result.created
					? `Linked ${fromId} -> ${toId} as ${relationType}`
					: `Relation already existed: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		});
	}
}

export class UnlinkCommand extends PositionalsTenantCommand {
	public static paths = [["unlink"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const fromId = requirePositional(this.positionals, 0, "unlink <fromId> <relationType> <toId>");
			const relationType = requirePositional(this.positionals, 1, "unlink <fromId> <relationType> <toId>");
			const toId = requirePositional(this.positionals, 2, "unlink <fromId> <relationType> <toId>");
			const planEntry = await findPlanEntry(store, fromId);
			if (planEntry) {
				if (relationType !== "informs") {
					throw new Error("Plan entries can link to entities only as informs. Valid relation types: informs.");
				}

				const result = await store.unlinkPlanEntryEntity({ entryId: planEntry.id, targetId: toId });
				this.print(
					this.asJson ? toCompactLinkAcknowledgement("unlink", result) : result,
					result.removed
						? `Unlinked ${fromId} -> ${toId} as ${relationType}`
						: `Relation did not exist: ${fromId} -> ${toId} as ${relationType}`
				);
				return 0;
			}

			const result = await store.unlinkEntities({ fromId, relationType, toId });

			this.print(
				this.asJson ? toCompactLinkAcknowledgement("unlink", result) : result,
				result.removed
					? `Unlinked ${fromId} -> ${toId} as ${relationType}`
					: `Relation did not exist: ${fromId} -> ${toId} as ${relationType}`
			);
			return 0;
		});
	}
}

async function findPlanEntry(store: { getPlanEntry(input: { entryId: string }): Promise<{ id: string }> }, entryId: string): Promise<{ id: string } | null> {
	try {
		return await store.getPlanEntry({ entryId });
	} catch (error) {
		if (error instanceof Error && error.message === `Plan entry not found: ${entryId}`) {
			return null;
		}
		throw error;
	}
}

export class StatusCommand extends PositionalsTenantCommand {
	public static paths = [["status"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "status <id> <status>");
			const status = requirePositional(this.positionals, 1, "status <id> <status>");
			const { entity } = await store.getEntityDetails(entityId);
			const workspaceObservation = entity.kind === "issue" && entity.status !== "done" && status === "done"
				? await resolveWorkspaceCompletionObservation(this.context.cwd, await store.getProspectorSettings())
				: undefined;
			const result = await store.updateEntityStatus({ entityId, status, workspaceObservation });

			this.print(this.asJson ? toCompactStatusAcknowledgement("status", result) : result, `Updated ${result.entity.id} from ${result.previousStatus} to ${result.entity.status}`);
			return 0;
		});
	}
}

async function resolveWorkspaceCompletionObservation(workspaceRoot: string, settings: Parameters<StorageDriver["setProspectorSettings"]>[0]) {
	const { resolveWorkspaceObservation } = await import("@agent-issues/api-local");
	return resolveWorkspaceObservation(workspaceRoot, settings);
}

type NextWorkItem = {
	issue: EntityRecord;
	blockers: string[];
	unblocks: string[];
};

type NextWorkResult = {
	initiative: EntityRecord;
	available: NextWorkItem[];
	blocked: NextWorkItem[];
};

const STRUCTURAL_PARENT_RELATION_TYPES: RelationType[] = ["contains", "owns", "records", "tracks", "creates", "decomposes"];

export class NextWorkCommand extends PositionalsTenantCommand {
	public static paths = [["next-work"]];

	public async execute(): Promise<number> {
		const scopeId = requirePositional(this.positionals, 0, "next-work <initiativeOrDescendantId>");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const initiative = await resolveContainingInitiative(store, scopeId);
			const bundle = await store.getInitiativeBundle(initiative.id);
			const allIssues = await store.queryEntities({ kind: "issue" });
			const result = deriveNextWork(bundle, allIssues.openBlockers ?? {});

			this.print(this.asJson ? toCompactNextWork(result) : result, renderNextWork(result));
			return 0;
		});
	}
}

async function resolveContainingInitiative(
	store: { queryEntityRelations(input: { entityId: string; direction: RelationDirection; types: RelationType[] }): Promise<{ entity: EntitySummary; incoming: Array<{ relationType: RelationType; entity: EntitySummary }> }> },
	scopeId: string
): Promise<EntitySummary> {
	let details = await store.queryEntityRelations({ entityId: scopeId, direction: "incoming", types: STRUCTURAL_PARENT_RELATION_TYPES });
	const visited = new Set<string>();
	while (details.entity.kind !== "initiative") {
		if (visited.has(details.entity.id)) {
			throw new Error(`Structural parent cycle found while resolving initiative: ${scopeId}`);
		}
		visited.add(details.entity.id);
		const parent = details.incoming[0]?.entity;
		if (!parent) {
			throw new Error(`No initiative contains: ${scopeId}`);
		}
		details = await store.queryEntityRelations({ entityId: parent.id, direction: "incoming", types: STRUCTURAL_PARENT_RELATION_TYPES });
	}

	return details.entity;
}

function deriveNextWork(
	bundle: { initiative: EntityRecord; issues: EntityRecord[]; subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }> },
	openBlockers: Record<string, string[]>
): NextWorkResult {
	const unfinishedIssues = bundle.issues.filter((issue) => issue.status !== "done" && issue.status !== "deferred");
	const blockersByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set(openBlockers[issue.reference] ?? [])]));
	for (const { parent, issue } of bundle.subIssueLinks) {
		if (parent.status !== "done" && parent.status !== "deferred" && issue.status !== "done" && issue.status !== "deferred") {
			blockersByReference.get(parent.reference)?.add(issue.reference);
		}
	}

	const unblocksByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set<string>()]));
	for (const issue of unfinishedIssues) {
		for (const blocker of blockersByReference.get(issue.reference) ?? []) {
			unblocksByReference.get(blocker)?.add(issue.reference);
		}
	}

	const toItem = (issue: EntityRecord): NextWorkItem => ({
		issue,
		blockers: Array.from(blockersByReference.get(issue.reference) ?? []).sort(),
		unblocks: Array.from(unblocksByReference.get(issue.reference) ?? []).sort()
	});
	const items = unfinishedIssues.map(toItem);
	return {
		initiative: bundle.initiative,
		available: items.filter((item) => item.blockers.length === 0),
		blocked: items.filter((item) => item.blockers.length > 0)
	};
}

function renderNextWork(result: NextWorkResult): string {
	const renderItem = (item: NextWorkItem) => `${item.issue.reference} ${item.issue.status} ${item.issue.title}${item.blockers.length > 0 ? ` (blocked by ${item.blockers.join(", ")})` : ""}${item.unblocks.length > 0 ? ` (unblocks ${item.unblocks.join(", ")})` : ""}`;
	return [
		`${result.initiative.reference} next work`,
		"Available",
		...result.available.map(renderItem),
		"Blocked",
		...result.blocked.map(renderItem)
	].join("\n");
}

export class RelationsCommand extends PositionalsTenantCommand {
	public static paths = [["relations"]];
	public directionValue = Option.String("--direction");
	public typeValues = Option.String("--type");

	public async execute(): Promise<number> {
		const direction = this.directionValue ?? "both";
		if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
			throw new Error(`Unknown relation direction: ${direction}`);
		}
		const types = parseCsvOption(this.typeValues);
		const allowedTypes = new Set<string>(ALLOWED_RELATIONS.map(({ type }) => type));
		const invalidType = types.find((type) => !allowedTypes.has(type));
		if (invalidType) {
			throw new Error(`Unknown relation type: ${invalidType}`);
		}
		const entityId = requirePositional(this.positionals, 0, "relations <id>");
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const details = await store.queryEntityRelations({
				entityId,
				direction: direction as RelationDirection,
				types: types as RelationType[]
			});

			this.print(this.asJson ? toCompactEntityDetails(details) : details, renderEntityDetails(details));
			return 0;
		});
	}
}

export class OrphansCommand extends PositionalsTenantCommand {
	public static paths = [["orphans"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const kind = this.positionals[0];
			const entities = kind ? await store.listOrphans(kind) : await store.listOrphans();

			this.print(entities, renderOptionalEntityList("orphaned", entities));
			return 0;
		});
	}
}

export class ShowCommand extends PositionalsTenantCommand {
	public static paths = [["show"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entityId = requirePositional(this.positionals, 0, "show <id>");
			const details = await store.getEntityDetails(entityId);

			if (details.entity.kind === "initiative") {
				const bundle = await store.getInitiativeBundle(entityId);
				this.print(bundle, renderInitiativeBundle(bundle));
				return 0;
			}

			if (details.entity.kind === "plan") {
				const projection = projectPlanEntries(await store.listPlanEntries({ planId: details.entity.id }));
				const planDetails = { ...details, ...projection };
				this.print(planDetails, renderPlanDetails(planDetails));
				return 0;
			}

			this.print(details, renderEntityDetails(details));
			return 0;
		});
	}
}

export class ListCommand extends PositionalsTenantCommand {
	public static paths = [["list"]];
	public limit = Option.String("--limit");
	public parent = Option.String("--parent");
	public statusValues = Option.String("--status");

	public async execute(): Promise<number> {
		const limit = parsePositiveIntegerOption(this.limit, "--limit");
		const kind = requirePositional(this.positionals, 0, "list <kind>");
		if (!isEntityKind(kind)) {
			throw new Error(`Unknown entity kind: ${kind}`);
		}
		const statuses = parseCsvOption(this.statusValues);
		const invalidStatus = statuses.find((status) => !isValidStatus(kind, status));
		if (invalidStatus) {
			throw new Error(`Invalid ${kind} status: ${invalidStatus}`);
		}
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const result = await store.queryEntities({ kind, statuses, parentId: this.parent, limit });

			this.print(
				this.asJson
					? toCompactEntityList(result.entities, result.total, result.openBlockers, result.parentGroups)
					: result.entities,
				renderEntityList(kind, result.entities, result.openBlockers, result.parentGroups)
			);
			return 0;
		});
	}
}
