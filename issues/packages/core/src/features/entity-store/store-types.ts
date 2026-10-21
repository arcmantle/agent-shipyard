import type { EntityRecord, EntitySummary, RelationRecord, RelationType } from "./domain.js";
import type { ContextDetails } from "../context/context-types.js";
import type { IssueCommentPage } from "../storage-driver/issue-comment-store.js";
import type { PlanEntryRecord } from "../plan-entry/plan-entry-types.js";
import type { UserDirectoryRecord } from "../user-directory/user-directory.js";
import type { WorkspaceRetrievalContext, WorkspaceObservationDiagnostic } from "../workspace-observation/workspace-observation.js";

export type CompletionObservation = {
	id: string;
	issueId: string;
	completionOrdinal: number;
	repositoryIdentity: string | null;
	commitSha: string | null;
	branch: string | null;
	dirty: boolean | null;
	capturedAt: string;
	calculatedVersionState: "available" | "unknown";
	calculatedVersion: string | null;
	diagnostics: Array<{ code: string; message: string }>;
};

export type VersionCoverage = {
	calculatedVersionState: CompletionObservation["calculatedVersionState"];
	calculatedVersion: string | null;
	issueCount: number;
	latestCapturedAt: string;
};

/**
 * The entity/handoff-store result contract (ADR13's dialect-agnostic
 * boundary): every `StorageDriver` implementation - SQLite
 * (`@agent-issues/api-local`) and Postgres (`@agent-issues/api-pg`) alike -
 * returns these same shapes, so they live in core rather than either
 * concrete store.
 */

export type LinkResult = {
	relation: RelationRecord;
	created: boolean;
};

export type EntityDetails = {
	entity: EntityRecord;
	incoming: Array<{ relationType: RelationType; entity: EntitySummary }>;
	outgoing: Array<{ relationType: RelationType; entity: EntitySummary }>;
	planEntries: PlanEntryRecord[];
	completionObservations: CompletionObservation[];
	currentCompletionObservation: CompletionObservation | null;
	versionCoverage: VersionCoverage[];
	comments?: IssueCommentPage;
};

export type EntityRelations = {
	entity: EntitySummary;
	incoming: Array<{ relationType: RelationType; entity: EntitySummary }>;
	outgoing: Array<{ relationType: RelationType; entity: EntitySummary }>;
	planEntries: PlanEntryRecord[];
};

export type QueryEntitiesInput = {
	kind: string;
	statuses?: string[];
	parentId?: string;
	limit?: number;
	retrievalContext?: WorkspaceRetrievalContext;
};

export type QueryEntityParentGroup = {
	parent: EntitySummary;
	entities: EntitySummary[];
};

export type QueryEntitiesResult = {
	entities: EntitySummary[];
	total: number;
	retrievalDiagnostics?: WorkspaceObservationDiagnostic[];
	/** Present when a short `parentId` resolves to multiple structural parents. */
	parentGroups?: QueryEntityParentGroup[];
	/**
	 * Only populated when `kind` is `"issue"`: maps each returned issue's
	 * canonical reference to the references of its open (not-`done`)
	 * `blocks` sources, so a caller ranking workable candidates can read
	 * blocked-status straight off the list instead of issuing one
	 * `queryEntityRelations` call per candidate. Keyed and valued by
	 * reference, not internal id, so a caller never has to resolve a raw id
	 * back to something it can pass to another command.
	 */
	openBlockers?: Record<string, string[]>;
};

export type RelationDirection = "incoming" | "outgoing" | "both";

export type QueryEntityRelationsInput = {
	entityId: string;
	direction?: RelationDirection;
	types?: RelationType[];
};

export type InitiativeBundle = {
	initiative: EntityRecord;
	entities: EntityRecord[];
	prds: EntityRecord[];
	userStories: EntityRecord[];
	adrs: EntityRecord[];
	issues: EntityRecord[];
	fixLinks: Array<{ issue: EntityRecord; userStory: EntityRecord }>;
	subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }>;
	blockerLinks: Array<{ source: EntityRecord; target: EntityRecord }>;
	constrainsLinks: Array<{ adr: EntityRecord; issue: EntityRecord }>;
	versionCoverage: VersionCoverage[];
};

export type InitiativeDetail = {
	initiative: EntityRecord;
};

export const INITIATIVE_TABS = ["overview", "issues", "plans", "prds", "adrs", "context", "userStories", "debt", "graph"] as const;

export type InitiativeTab = (typeof INITIATIVE_TABS)[number];

export function isInitiativeTab(value: string | null): value is InitiativeTab {
	return typeof value === "string" && (INITIATIVE_TABS as readonly string[]).includes(value);
}

export type InitiativeTabData = {
	tab: InitiativeTab;
	records: EntityRecord[];
	relations: RelationRecord[];
	rollup?: InitiativeRollup;
	context?: ContextDetails;
};

export type ProjectDiscovery =
	| {
			kind: "available";
			projects: ProjectRollup[];
	  }
	| {
			kind: "unavailable";
	  };

export type ProjectRollup = {
	project: EntityRecord;
	epicCount: number;
	initiativeCount: number;
	completedInitiativeCount: number;
};

export type DatabaseSnapshot = {
	generatedAt: string;
	users: UserDirectoryRecord[];
	issueComments: Record<string, IssueCommentPage>;
	planEntries: PlanEntryRecord[];
	entities: EntityRecord[];
	relations: RelationRecord[];
	orphans: EntityRecord[];
	projectAdrs: EntityRecord[];
	initiatives: InitiativeBundle[];
	contexts: {
		shared: ContextDetails;
		initiatives: ContextDetails[];
	};
};

export type ProjectSnapshot =
	| {
			kind: "available";
			snapshot: DatabaseSnapshot;
	  }
	| {
			kind: "unavailable";
	  };

export type InitiativeRollup = {
	initiative: EntitySummary;
	adrCount: number;
	contextTermCount: number;
	debtCount: number;
	issueCount: number;
	totalIssueCount: number;
	completedIssueCount: number;
	planCount: number;
	prdCount: number;
	userStoryCount: number;
};

export type ProjectSummary =
	| {
			kind: "available";
			project: EntitySummary;
			epics: Array<{
				epic: EntitySummary;
				initiatives: InitiativeRollup[];
			}>;
			counts: {
				epics: number;
				initiatives: number;
				completedInitiatives: number;
			};
	  }
	| {
			kind: "unavailable";
	  };

export type StatusUpdateResult = {
	entity: EntitySummary;
	previousStatus: string;
};

export type UnlinkResult = {
	relation: RelationRecord;
	removed: boolean;
};

export type DeleteResult = {
	entity: EntitySummary;
	removed: boolean;
};

export type MoveResult = {
	entity: EntitySummary;
	previousParentId: string | null;
	newParentId: string;
	relationType: RelationType;
};
