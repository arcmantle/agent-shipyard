import type {
	DeleteResult,
	DefineContextTermResult,
	EntityDetails,
	EntityKind,
	EntityRecord,
	EntityRelations,
	EntitySummary,
	LinkResult,
	MaterializedContextRevision,
	MaterializedContextTermRevision,
	MaterializedEntityRevision,
	MoveResult,
	QueryEntityParentGroup,
	RelationType,
	StatusUpdateResult,
	ContextDetails,
	ContextWriteResult,
	DefineContextTermAcknowledgement,
	ForgetContextTermResult,
	UnlinkResult
} from "@agent-issues/core";

export type CompactEntity = {
	id: string;
	reference: string;
	kind: EntityKind;
	status: string;
	title: string;
};

export type CompactRelation = {
	type: RelationType;
	entity: CompactEntity;
};

export type CompactEntityDetails = {
	entity: CompactEntity;
	incoming: CompactRelation[];
	outgoing: CompactRelation[];
	planEntries: EntityDetails["planEntries"];
};

export type CompactEntityList = {
	items: CompactEntity[];
	total: number;
	parentGroups?: Array<{ parent: CompactEntity; items: CompactEntity[] }>;
	/** Only present for issue lists; see `QueryEntitiesResult.openBlockers`. */
	openBlockers?: Record<string, string[]>;
};

export type CompactNextWorkItem = {
	issue: CompactEntity;
	blockers: string[];
	unblocks: string[];
};

export type CompactNextWork = {
	initiative: CompactEntity;
	available: CompactNextWorkItem[];
	blocked: CompactNextWorkItem[];
};

export type CompactCreateAcknowledgement = {
	operation: "create";
	id: string;
	reference: string;
	status: string;
	revision: number;
};

export type CompactEditAcknowledgement = {
	operation: "edit";
	reference: string;
	revision: number;
};

export function toCompactEntity(entity: EntitySummary): CompactEntity {
	return {
		id: entity.id,
		reference: entity.reference,
		kind: entity.kind,
		status: entity.status,
		title: entity.title
	};
}

export function toCompactCreateAcknowledgement(entity: EntitySummary): CompactCreateAcknowledgement {
	return {
		operation: "create",
		id: entity.id,
		reference: entity.reference,
		status: entity.status,
		revision: entity.revision
	};
}

export function toCompactEditAcknowledgement(entity: EntityRecord): CompactEditAcknowledgement {
	return {
		operation: "edit",
		reference: entity.reference,
		revision: entity.revision
	};
}

export function toCompactStatusAcknowledgement(operation: "archive" | "status", result: StatusUpdateResult) {
	return {
		operation,
		reference: result.entity.reference,
		previousStatus: result.previousStatus,
		status: result.entity.status,
		revision: result.entity.revision
	};
}

export function toCompactDeleteAcknowledgement(result: DeleteResult) {
	return {
		operation: "delete" as const,
		reference: result.entity.reference,
		removed: result.removed
	};
}

export function toCompactMoveAcknowledgement(result: MoveResult) {
	return {
		operation: "move" as const,
		reference: result.entity.reference,
		previousParentId: result.previousParentId,
		newParentId: result.newParentId,
		type: result.relationType,
		revision: result.entity.revision
	};
}

export function toCompactLinkAcknowledgement(operation: "link" | "unlink", result: LinkResult | UnlinkResult) {
	return {
		operation,
		fromId: result.relation.fromId,
		toId: result.relation.toId,
		type: result.relation.type,
		...(operation === "link" ? { created: (result as LinkResult).created } : { removed: (result as UnlinkResult).removed })
	};
}

export function toCompactEntityRestoreAcknowledgement(result: MaterializedEntityRevision) {
	return {
		operation: "restore" as const,
		id: result.entityId,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactContextSetAcknowledgement(result: ContextWriteResult) {
	return {
		operation: "context-set" as const,
		reference: result.context.reference ?? result.context.key,
		revision: result.context.revision
	};
}

export function toCompactContextDefineAcknowledgement(result: DefineContextTermAcknowledgement) {
	return {
		operation: "context-define" as const,
		reference: result.term.reference,
		contextReference: result.context.reference ?? result.context.key,
		term: result.term.term,
		created: result.created,
		revision: result.term.revision
	};
}

export function toCompactContextForgetAcknowledgement(result: ForgetContextTermResult) {
	return {
		operation: "context-forget" as const,
		reference: result.context.reference ?? result.context.key,
		term: result.term,
		removed: result.removed,
		...(result.currentRevision === undefined ? {} : { revision: result.currentRevision })
	};
}

export function toCompactContextRestoreAcknowledgement(result: MaterializedContextRevision) {
	return {
		operation: "context-restore" as const,
		contextKey: result.contextKey,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactContextTermRestoreAcknowledgement(result: MaterializedContextTermRevision) {
	return {
		operation: "context-term-restore" as const,
		id: result.id,
		contextKey: result.contextKey,
		term: result.term,
		revision: result.headRevision,
		restoredFromRevision: result.restoredFromRevision
	};
}

export function toCompactEntityDetails(details: EntityDetails | EntityRelations): CompactEntityDetails {
	return {
		entity: toCompactEntity(details.entity),
		incoming: details.incoming.map(({ relationType, entity }) => ({
			type: relationType,
			entity: toCompactEntity(entity)
		})),
		outgoing: details.outgoing.map(({ relationType, entity }) => ({
			type: relationType,
			entity: toCompactEntity(entity)
		})),
		planEntries: details.planEntries ?? []
	};
}

export function toCompactEntityList(
	entities: EntitySummary[],
	total = entities.length,
	openBlockers?: Record<string, string[]>,
	parentGroups?: QueryEntityParentGroup[]
): CompactEntityList {
	return {
		items: entities.map(toCompactEntity),
		total,
		...(parentGroups ? { parentGroups: parentGroups.map((group) => ({ parent: toCompactEntity(group.parent), items: group.entities.map(toCompactEntity) })) } : {}),
		...(openBlockers ? { openBlockers } : {})
	};
}

export function toCompactNextWork(result: {
	initiative: EntityRecord;
	available: Array<{ issue: EntityRecord; blockers: string[]; unblocks: string[] }>;
	blocked: Array<{ issue: EntityRecord; blockers: string[]; unblocks: string[] }>;
}): CompactNextWork {
	const toCompactNextWorkItem = (item: { issue: EntityRecord; blockers: string[]; unblocks: string[] }): CompactNextWorkItem => ({
		issue: toCompactEntity(item.issue),
		blockers: item.blockers,
		unblocks: item.unblocks
	});

	return {
		initiative: toCompactEntity(result.initiative),
		available: result.available.map(toCompactNextWorkItem),
		blocked: result.blocked.map(toCompactNextWorkItem)
	};
}