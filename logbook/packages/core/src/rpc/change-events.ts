import type { ServerResponse } from "node:http";
import { STRUCTURAL_RELATION_TYPES } from "../features/entity-store/domain.js";
import type { StorageDriver } from "../features/storage-driver/storage-driver.js";

export type ProjectChangeCategory = "bulk" | "context" | "entity" | "issue-comment" | "plan-entry" | "relation" | "unknown";

export type ProjectChangeEvent = {
	type: "snapshot-changed";
	at: string;
	projectId?: string;
	category?: ProjectChangeCategory;
	affectedEntityIds?: string[];
	affectedEntityKinds?: string[];
	affectedInitiativeIds?: string[];
	affectsProjectSummary?: boolean;
	correlationId?: string;
};

export type ProjectChangeEventDetails = Omit<ProjectChangeEvent, "at" | "type">;

const ENTITY_METHODS = new Set([
	"archiveEntity",
	"createEntity",
	"deleteEntity",
	"moveEntity",
	"restoreEntityRevision",
	"setEntityBody",
	"updateEntity",
	"updateEntityStatus"
]);
const ISSUE_COMMENT_METHODS = new Set(["createIssueComment", "deleteIssueComment", "updateIssueComment"]);
const PLAN_ENTRY_METHODS = new Set([
	"createPlanEntry",
	"deletePlanEntry",
	"linkPlanEntryEntity",
	"unlinkPlanEntryEntity",
	"updatePlanEntry"
]);
const CONTEXT_METHODS = new Set([
	"defineContextTerm",
	"forgetContextTerm",
	"restoreContextRevision",
	"restoreContextTermRevision",
	"upsertContext"
]);
const STRUCTURAL_RELATION_TYPE_SET = new Set<string>(STRUCTURAL_RELATION_TYPES);
const PROJECT_SUMMARY_ENTITY_KINDS = new Set(["epic", "initiative", "issue", "project", "userStory"]);

export async function projectChangeEventForWrite(
	store: StorageDriver,
	method: string,
	projectId: string | undefined,
	params: unknown,
	result: unknown,
	correlationId?: string
): Promise<ProjectChangeEventDetails> {
	const input = params && typeof params === "object" ? params as Record<string, unknown> : {};
	const output = result && typeof result === "object" ? result as Record<string, unknown> : {};
	const entityOutput = output.entity && typeof output.entity === "object" ? output.entity as Record<string, unknown> : output;
	let category: ProjectChangeCategory = "unknown";
	let affectedEntityIds: string[] = [];
	let affectedEntityKinds: string[] = [];

	if (ENTITY_METHODS.has(method)) {
		category = "entity";
		affectedEntityIds = stringValues(entityOutput.id, input.entityId);
		affectedEntityKinds = stringValues(entityOutput.kind, input.kind);
	} else if (ISSUE_COMMENT_METHODS.has(method)) {
		category = "issue-comment";
		affectedEntityIds = stringValues(output.issueId, input.issueId);
	} else if (PLAN_ENTRY_METHODS.has(method)) {
		category = "plan-entry";
		let planId = stringValues(output.planId, input.planId)[0];
		if (!planId && typeof input.entryId === "string") {
			try {
				planId = (await store.getPlanEntry({ entryId: input.entryId })).planId;
			} catch {
				// A deleted Plan entry can only use scope captured before the write.
			}
		}
		affectedEntityIds = stringValues(planId, input.targetId);
	} else if (method === "linkEntities" || method === "unlinkEntities") {
		category = "relation";
		affectedEntityIds = stringValues(input.fromId, input.toId);
	} else if (CONTEXT_METHODS.has(method)) {
		category = "context";
		affectedEntityIds = stringValues(input.scopeRef);
	} else if (method === "applyRelations" || method === "importCanonicalChains") {
		category = "bulk";
	}

	const resolvedScope = await resolveEntityScopes(store, affectedEntityIds);
	return {
		affectedEntityIds,
		affectedEntityKinds: [...new Set([...affectedEntityKinds, ...resolvedScope.entityKinds])],
		affectedInitiativeIds: resolvedScope.initiativeIds,
		affectsProjectSummary: category === "entity"
			? [...affectedEntityKinds, ...resolvedScope.entityKinds].some((kind) => PROJECT_SUMMARY_ENTITY_KINDS.has(kind))
			: category === "relation" && typeof input.relationType === "string" && STRUCTURAL_RELATION_TYPE_SET.has(input.relationType),
		category,
		...(projectId ? { projectId } : {}),
		...(correlationId ? { correlationId } : {})
	};
}

export function mergeProjectChangeEventDetails(
	before: ProjectChangeEventDetails,
	after: ProjectChangeEventDetails
): ProjectChangeEventDetails {
	return {
		affectedEntityIds: stringValues(...(before.affectedEntityIds ?? []), ...(after.affectedEntityIds ?? [])),
		affectedEntityKinds: stringValues(...(before.affectedEntityKinds ?? []), ...(after.affectedEntityKinds ?? [])),
		affectedInitiativeIds: stringValues(...(before.affectedInitiativeIds ?? []), ...(after.affectedInitiativeIds ?? [])),
		affectsProjectSummary: before.affectsProjectSummary === true || after.affectsProjectSummary === true,
		category: after.category ?? before.category,
		correlationId: after.correlationId ?? before.correlationId,
		projectId: after.projectId ?? before.projectId
	};
}

function stringValues(...values: unknown[]): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function resolveEntityScopes(
	store: StorageDriver,
	entityIds: string[]
): Promise<{ entityKinds: string[]; initiativeIds: string[] }> {
	const rootIds = new Set(entityIds);
	const entityKinds = new Set<string>();
	const initiativeIds = new Set<string>();
	const visited = new Set<string>();
	const pending = [...entityIds];

	while (pending.length > 0) {
		const entityId = pending.shift()!;
		if (visited.has(entityId)) {
			continue;
		}
		visited.add(entityId);

		try {
			const details = await store.getEntityDetails(entityId);
			if (rootIds.has(entityId)) {
				entityKinds.add(details.entity.kind);
			}
			if (details.entity.kind === "initiative") {
				initiativeIds.add(details.entity.id);
				continue;
			}

			for (const relation of details.incoming) {
				if (STRUCTURAL_RELATION_TYPE_SET.has(relation.relationType)) {
					pending.push(relation.entity.id);
				}
			}
		} catch {
			// Deleted records and external scope references cannot always be resolved.
		}
	}

	return { entityKinds: [...entityKinds], initiativeIds: [...initiativeIds] };
}

/**
 * Per-tenant SSE broadcaster (ADR13's "change-notification channel"): after
 * each committed `PgStore` write dispatched through the JSON-RPC gate, only
 * subscribers for that write's tenant (ADR9) receive a `snapshot-changed`
 * event - matching the shape the site's local `/events` live-refresh
 * consumer already expects (`packages/cli/src/site/server.ts`).
 */
export class ChangeEventBroadcaster {
	private readonly subscribersByTenant = new Map<string, Set<ServerResponse>>();

	subscribe(tenantId: string, response: ServerResponse): () => void {
		let subscribers = this.subscribersByTenant.get(tenantId);
		if (!subscribers) {
			subscribers = new Set();
			this.subscribersByTenant.set(tenantId, subscribers);
		}
		subscribers.add(response);

		return () => {
			subscribers.delete(response);
			if (subscribers.size === 0) {
				this.subscribersByTenant.delete(tenantId);
			}
		};
	}

	publishSnapshotChanged(tenantId: string, details: ProjectChangeEventDetails = {}): void {
		const subscribers = this.subscribersByTenant.get(tenantId);
		if (!subscribers || subscribers.size === 0) {
			return;
		}

		const payload = JSON.stringify({ type: "snapshot-changed", at: new Date().toISOString(), ...details });
		for (const subscriber of subscribers) {
			subscriber.write(`data: ${payload}\n\n`);
		}
	}
}
