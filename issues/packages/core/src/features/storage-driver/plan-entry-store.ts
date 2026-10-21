import type { LinkResult, UnlinkResult } from "../entity-store/store-types.js";
import type { EntitySummary } from "../entity-store/domain.js";
import type { PlanEntryHistoryEntry, PlanEntryPage, PlanEntryRecord, PlanEntryRole, PlanEntryScopeDirection, PlanEntrySummary } from "../plan-entry/plan-entry-types.js";

export type PlanConfirmationResult = {
	entity: EntitySummary;
	previousStatus: string;
	confirmed: boolean;
};

export interface PlanEntryStore {
	confirmPlan(input: { planId: string; snapshotDigest: string }): Promise<PlanConfirmationResult>;
	createPlanEntry(input: {
		planId: string;
		role: PlanEntryRole;
		body: string;
		scopeDirection?: PlanEntryScopeDirection;
		referencedEntityIds?: string[];
		supersededEntryIds?: string[];
	}): Promise<PlanEntrySummary>;
	getPlanEntry(input: { entryId: string }): Promise<PlanEntryRecord>;
	updatePlanEntry(input: { entryId: string; body: string; expectedRevision: number; expectedContentHash: string }): Promise<PlanEntryRecord>;
	deletePlanEntry(input: { entryId: string; expectedRevision: number; expectedContentHash: string }): Promise<PlanEntryRecord>;
	linkPlanEntryEntity(input: { entryId: string; targetId: string }): Promise<LinkResult>;
	unlinkPlanEntryEntity(input: { entryId: string; targetId: string }): Promise<UnlinkResult>;
	listPlanEntries(input: { planId: string }): Promise<PlanEntryRecord[]>;
	listPlanEntryPage(input: { planId: string; before?: string; all?: boolean }): Promise<PlanEntryPage>;
	listPlanEntryHistory(input: { entryId: string }): Promise<PlanEntryHistoryEntry[]>;
}