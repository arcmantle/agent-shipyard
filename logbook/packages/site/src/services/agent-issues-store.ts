import { computed, signal } from "@lit-labs/signals";
import type { InstructionCatalog, InstructionComparison, InstructionDependencyInspection, InstructionHistory, InstructionKind, InstructionPreview, InstructionResetAllInspection, InstructionResetInspection, InstructionSourceResult } from "@agent-issues/core";
import { InstructionFragmentError } from "@agent-issues/core/instruction-store";
import type { ProjectChangeEvent, SearchCapability, SearchNavigationTarget, SearchResponse, SearchResult, SearchSourceType } from "@agent-issues/core";
import { PROJECT_GRAPH_KINDS, isConsoleSection, type AdrRailEntry, type ConsoleSection, type ContextDetails, type ContextPageTab, type DebtFilter, type Entity, type EntityDetails, type EntitySummary, type EpicInitiativeGroup, type FixLink, type GraphEdge, type GraphNode, type InitiativeBundle, type InitiativeDetail, type InitiativeRollup, type InitiativeSortCriterion, type InitiativeTab, type InitiativeTabData, type IssueCommentPage, type PageMode, type PlanEntry, type PlanEntryPage, type ProjectAdrSectionData, type ProjectContextSectionData, type ProjectContextTermEntry, type ProjectContextTermSource, type ProjectDiscovery, type ProjectGraphKind, type ProjectSummary, type ProjectSummaryEpicGroup, type Relation, type RelationshipGraph, type RootTab, type SiteConfig, type Snapshot, type ViewMode } from "../models.js";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_CODE_LENGTH = 6;
const GLOBAL_SEARCH_RECENTS_LIMIT = 5;
const GLOBAL_SEARCH_RECENTS_STORAGE_PREFIX = "agent-issues-global-search-recents";
const INITIATIVE_TAB_PREFETCH_DELAY_MS = 400;
const LOCAL_CHANGE_CORRELATION_TTL_MS = 5 * 60 * 1000;
const PLAN_CURRENT_GROUPS = [
	{ key: "questions", title: "Questions" },
	{ key: "decisions", title: "Decisions" },
	{ key: "includedScope", title: "Included scope" },
	{ key: "excludedScope", title: "Excluded scope" },
	{ key: "constraints", title: "Constraints" },
	{ key: "preferences", title: "Preferences" },
	{ key: "considerations", title: "Considerations" }
] as const;

type PlanCurrentGroupKey = (typeof PLAN_CURRENT_GROUPS)[number]["key"];
export type SiteInstructionResetAllInspection = InstructionResetAllInspection & { confirmationToken: string; expiresAt: string };
export class InstructionResetRefreshError extends Error {}

const KIND_PREFIX: Record<string, string> = {
	project: "PROJ",
	epic: "EPIC",
	version: "VER",
	initiative: "INIT",
	prd: "PRD",
	userStory: "US",
	adr: "ADR",
	issue: "ISS",
	debt: "DEBT",
	handoff: "HO"
};

function shortEntityReference(entity: { id: string; kind: string; shortReference?: string }): string {
	if (entity.shortReference) {
		return entity.shortReference;
	}

	const prefix = KIND_PREFIX[entity.kind] ?? entity.kind.slice(0, 4).toUpperCase();
	let hash = 0x811c9dc5;
	for (let index = 0; index < entity.id.length; index += 1) {
		hash ^= entity.id.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	let value = BigInt(hash >>> 0);
	let code = "";
	for (let index = 0; index < SHORT_CODE_LENGTH; index += 1) {
		code = CROCKFORD_ALPHABET[Number(value & 31n)]! + code;
		value >>= 5n;
	}
	return `${prefix}_${code}`;
}

type IssueTreeNode = {
	issue: Entity;
	children: IssueTreeNode[];
};

type ProjectSnapshot = {
	kind: "available";
	snapshot: Snapshot;
} | {
	kind: "unavailable";
};
type CachedInitiativeDetail = {
	detail: InitiativeDetail | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type InitiativeDetailResponse = InitiativeDetail | { kind: "unavailable" };
type CachedEntityDetail = {
	detail: EntityDetails | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type EntityDetailResponse = EntityDetails | { kind: "unavailable" };
type CachedProjectAdrs = {
	data: ProjectAdrSectionData | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type ProjectRecordData = {
	records: Entity[];
	relations: Relation[];
};
type CachedProjectRecordData = {
	data: ProjectRecordData | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type CachedProjectContext = {
	data: ProjectContextSectionData | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type CachedPlanEntryPage = {
	data: PlanEntryPage | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type CachedIssueCommentPage = {
	data: IssueCommentPage | null;
	error: string | null;
	loading: boolean;
	stale?: boolean;
};
type CachedInitiativeTab = {
	error: string | null;
	loading: boolean;
	data: InitiativeTabData | null;
	stale?: boolean;
};
type ViewerRoute = {
	instructionKey?: string | null;
	instructionCategory?: InstructionKind;
	tenantId: string | null;
	projectId: string | null;
	page: PageMode;
	section: ConsoleSection;
	entityId: string | null;
	initiativeId: string | null;
	initiativeTab: InitiativeTab;
	target: NestedRouteTarget | null;
};

type PersonalInstructionCatalog = InstructionCatalog & {
	owner: { type: "local" } | { type: "cloud"; tenantId: string; userId: string };
};

const INITIATIVE_TABS: readonly InitiativeTab[] = ["overview", "issues", "plans", "prds", "adrs", "context", "userStories", "debt", "graph"];
const DEFERRED_INITIATIVE_TABS = INITIATIVE_TABS.filter((tab): tab is Exclude<InitiativeTab, "overview"> => tab !== "overview");

type NestedRouteTarget = { scopeRef?: string } & (
	| { type: "context"; id: null }
	| { type: "context-term"; id: string }
	| { type: "issue-comment" | "plan-entry"; id: string }
);

export type GlobalSearchRecent = {
	target: SearchNavigationTarget;
	title: string;
	sourceType: SearchSourceType;
};

function isSearchNavigationTarget(value: unknown): value is SearchNavigationTarget {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return false;
	}
	const target = value as Record<string, unknown>;

	if (target.type === "entity") {
		return typeof target.entityId === "string";
	}

	if (target.type === "plan-entry") {
		return typeof target.planId === "string" && typeof target.entryId === "string";
	}

	if (target.type === "issue-comment") {
		return typeof target.issueId === "string" && typeof target.commentId === "string";
	}

	if (target.type === "context") {
		return target.scopeRef === undefined || typeof target.scopeRef === "string";
	}

	return target.type === "context-term" && typeof target.term === "string" && (target.scopeRef === undefined || typeof target.scopeRef === "string");
}

function filterGraphByKind(graph: RelationshipGraph, visibleKinds: ReadonlySet<ProjectGraphKind>): RelationshipGraph {
	const visibleNodes = graph.nodes.filter((node) => visibleKinds.has(node.kind as ProjectGraphKind));
	const visibleKeys = new Set(visibleNodes.map((node) => node.key));
	const visibleColumnIndexes = [...new Set(visibleNodes.map((node) => node.col))].sort((left, right) => left - right);
	const compactColumnByIndex = new Map(visibleColumnIndexes.map((column, index) => [column, index]));

	return {
		columns: visibleColumnIndexes.map((column) => graph.columns[column]!),
		edges: graph.edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to)),
		nodes: visibleNodes.map((node) => ({ ...node, col: compactColumnByIndex.get(node.col)! }))
	};
}

function entityFromSummary(entity: EntitySummary): Entity {
	return { ...entity, body: "" };
}

function relationsFromEntityDetails(details: EntityDetails): Relation[] {
	return [
		...(details.incoming ?? []).map(({ entity, relationType }) => ({ createdAt: details.entity.createdAt, fromId: entity.id, toId: details.entity.id, type: relationType })),
		...(details.outgoing ?? []).map(({ entity, relationType }) => ({ createdAt: details.entity.createdAt, fromId: details.entity.id, toId: entity.id, type: relationType }))
	];
}

function affectedInitiativeTabs(event: ProjectChangeEvent): Set<Exclude<InitiativeTab, "overview">> {
	if (event.category === "relation") {
		return new Set(["issues", "plans", "prds", "adrs", "context", "userStories", "debt", "graph"]);
	}
	if (event.category === "context") {
		return new Set(["context"]);
	}
	if (event.category === "plan-entry") {
		return new Set(["plans"]);
	}
	if (event.category !== "entity") {
		return new Set();
	}

	const tabByKind: Record<string, Exclude<InitiativeTab, "overview">> = {
		adr: "adrs",
		debt: "debt",
		issue: "issues",
		plan: "plans",
		prd: "prds",
		userStory: "userStories"
	};
	return new Set([
		...(event.affectedEntityKinds ?? []).flatMap((kind) => tabByKind[kind] ? [tabByKind[kind]] : []),
		"graph"
	]);
}

export class AgentIssuesStore {
	public instructionCatalog = signal<PersonalInstructionCatalog | null>(null);
	public instructionSource = signal<InstructionSourceResult | null>(null);
	public instructionCategory = signal<InstructionKind>("agent");
	public instructionSearch = signal("");
	public selectedInstructionKey = signal<string | null>(null);
	public instructionCatalogLoading = signal(false);
	public instructionSourceLoading = signal(false);
	public instructionSaving = signal(false);
	public instructionError = signal<string | null>(null);
	public instructionConflict = signal<InstructionSourceResult | null>(null);
	public instructionNavigationGuard: ((navigate: () => void) => boolean) | null = null;
	public instructionItemNavigator: ((key: string | null, category: InstructionKind) => Promise<void>) | null = null;
	protected instructionCatalogGeneration = 0;
	protected instructionSourceGeneration = 0;
	protected browserNavigationGeneration = 0;
	protected routeHistoryPosition = this.readHistoryPosition() ?? 0;
	protected restoringHistoryPosition: number | null = null;
	protected historyRestoration: Promise<void> | null = null;
	protected finishHistoryRestoration: (() => void) | null = null;

	protected allowInstructionNavigation(navigate: () => void) {
		return this.activePage.get() !== "instructions" || !this.instructionNavigationGuard || this.instructionNavigationGuard(navigate);
	}

	public filteredInstructions = computed(() => {
		const query = this.instructionSearch.get().trim().toLowerCase();
		return (this.instructionCatalog.get()?.items ?? []).filter((item) =>
			item.kind === this.instructionCategory.get() && item.key.toLowerCase().includes(query));
	});

	public async openInstructions() {
		if (!this.allowInstructionNavigation(() => { void this.openInstructions(); })) return;
		this.activePage.set("instructions");
		this.selectedId.set(null);
		this.selectedInitiativeId.set(null);
		this.selectedNestedTarget.set(null);
		this.stopLiveUpdates();
		this.writeRoute(this.currentRoute());
		await this.loadInstructionCatalog();
	}

	public selectInstructionCategory(category: InstructionKind, options: { writeRoute?: boolean } = {}) {
		if (!this.allowInstructionNavigation(() => this.selectInstructionCategory(category))) return;
		this.instructionConflict.set(null);
		this.instructionCategory.set(category);
		this.instructionSearch.set("");
		this.selectedInstructionKey.set(null);
		this.instructionSource.set(null);
		this.instructionSourceGeneration += 1;
		this.instructionSourceLoading.set(false);
		this.instructionError.set(null);
		if (options.writeRoute !== false) this.writeRoute(this.currentRoute());
	}

	public async selectInstruction(key: string | null, options: { writeRoute?: boolean } = {}) {
		if (!this.allowInstructionNavigation(() => { void this.selectInstruction(key, options); })) return;
		this.instructionConflict.set(null);
		const generation = ++this.instructionSourceGeneration;
		this.selectedInstructionKey.set(key);
		this.instructionSource.set(null);
		this.instructionSourceLoading.set(!!key);
		this.instructionError.set(null);
		if (options.writeRoute !== false) this.writeRoute(this.currentRoute());
		if (!key) return;
		try {
			const source = await this.fetchJson<InstructionSourceResult>(this.buildInstructionPath(`/api/instructions/source?key=${encodeURIComponent(key)}`));
			if (generation === this.instructionSourceGeneration) this.instructionSource.set(source);
		} catch (error) {
			if (generation === this.instructionSourceGeneration) this.instructionError.set(error instanceof Error ? error.message : String(error));
		} finally {
			if (generation === this.instructionSourceGeneration) this.instructionSourceLoading.set(false);
		}
	}

	public async compareInstructionSource(key: string): Promise<InstructionComparison> {
		const response = await fetch(this.buildInstructionPath(`/api/instructions/compare?key=${encodeURIComponent(key)}`));
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}

	public async createInstructionFragment(key: string): Promise<InstructionSourceResult> {
		const created = await this.mutateInstructionFragment("create", { key, body: "" });
		const catalog = this.instructionCatalog.get();
		if (catalog) this.instructionCatalog.set({ ...catalog, items: [...catalog.items, created] });
		return created;
	}

	public async removeInstructionFragment(source: InstructionSourceResult) {
		await this.mutateInstructionFragment("remove", { key: source.key, expectedRevision: source.source.revision });
		const catalog = this.instructionCatalog.get();
		if (catalog) this.instructionCatalog.set({ ...catalog, items: catalog.items.filter((item) => item.key !== source.key) });
		if (this.selectedInstructionKey.get() === source.key) {
			this.instructionSourceGeneration += 1;
			this.selectedInstructionKey.set(null);
			this.instructionSource.set(null);
			this.instructionConflict.set(null);
			this.instructionError.set(null);
			this.writeRoute(this.currentRoute());
		}
	}

	protected async mutateInstructionFragment(operation: "create" | "remove", input: { key: string; body?: string; expectedRevision?: number }): Promise<InstructionSourceResult> {
		if (this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		const generation = this.instructionCatalogGeneration;
		const tenant = this.selectedTenant.get();
		this.instructionSaving.set(true);
		try {
			const response = await fetch(this.buildInstructionPath(`/api/instructions/fragments/${operation}`), {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
			});
			if (!response.ok) {
				if (response.headers.get("content-type")?.includes("application/json")) {
					const error = await response.json() as { message: string; reason: InstructionFragmentError["reason"]; currentSource?: InstructionSourceResult; affectedReferences: string[] };
					throw new InstructionFragmentError(error.reason, error.message, error.currentSource, error.affectedReferences);
				}
				throw new Error(await response.text());
			}
			const result = await response.json() as InstructionSourceResult;
			if (generation !== this.instructionCatalogGeneration || tenant !== this.selectedTenant.get()) throw new Error("The instruction owner changed.");
			return result;
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async inspectInstructionDependencies(key: string): Promise<InstructionDependencyInspection> {
		const response = await fetch(this.buildInstructionPath(`/api/instructions/dependencies?key=${encodeURIComponent(key)}`));
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}

	public async listInstructionHistory(key: string): Promise<InstructionHistory> {
		return this.fetchJson(this.buildInstructionPath(`/api/instructions/history?key=${encodeURIComponent(key)}`));
	}

	public async readInstructionRevision(key: string, revision: number): Promise<InstructionSourceResult> {
		return this.fetchJson(this.buildInstructionPath(`/api/instructions/revision?key=${encodeURIComponent(key)}&revision=${revision}`));
	}

	public async restoreInstructionRevision(revision: number) {
		const current = this.instructionSource.get();
		if (!current || this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		const tenant = this.selectedTenant.get();
		const generation = this.instructionSourceGeneration;
		this.instructionSaving.set(true);
		try {
			const response = await fetch(this.buildInstructionPath("/api/instructions/restore"), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: current.key, revision, expectedRevision: current.source.revision })
			});
			if (!response.ok) throw new Error(await response.text());
			const restored = await response.json() as InstructionSourceResult;
			if (generation !== this.instructionSourceGeneration || tenant !== this.selectedTenant.get() || this.instructionSource.get() !== current) {
				throw new Error("The instruction owner or source changed.");
			}
			this.instructionConflict.set(null);
			this.instructionError.set(null);
			this.instructionSource.set(restored);
			const catalog = this.instructionCatalog.get();
			if (catalog) this.instructionCatalog.set({ ...catalog, items: catalog.items.map((item) => item.key === restored.key ? restored : item) });
			return restored;
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async inspectInstructionReset(key: string): Promise<InstructionResetInspection> {
		return this.fetchJson(this.buildInstructionPath(`/api/instructions/reset/inspect?key=${encodeURIComponent(key)}`));
	}

	public async inspectInstructionResetAll(): Promise<SiteInstructionResetAllInspection> {
		return this.fetchJson(this.buildInstructionPath("/api/instructions/reset-all/inspect"));
	}

	public async resetInstructionAll(inspection: SiteInstructionResetAllInspection) {
		if (this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		const tenant = this.selectedTenant.get();
		const generation = this.instructionCatalogGeneration;
		const sourceGeneration = this.instructionSourceGeneration;
		const key = this.selectedInstructionKey.get();
		this.instructionSaving.set(true);
		try {
			const response = await fetch(this.buildInstructionPath("/api/instructions/reset-all"), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevisions: inspection.expectedRevisions, confirmationToken: inspection.confirmationToken })
			});
			if (!response.ok) throw new Error(await response.text());
			try {
				await this.refreshResetInstructions(tenant, generation, sourceGeneration, key);
			} catch (error) {
				if (generation !== this.instructionCatalogGeneration || tenant !== this.selectedTenant.get()) throw error;
				throw new InstructionResetRefreshError(`Reset All completed. Saved instructions could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async reloadResetInstructions() {
		if (this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		this.instructionSaving.set(true);
		try {
			await this.refreshResetInstructions(this.selectedTenant.get(), this.instructionCatalogGeneration, this.instructionSourceGeneration, this.selectedInstructionKey.get());
		} finally {
			this.instructionSaving.set(false);
		}
	}

	protected async refreshResetInstructions(tenant: string | null, generation: number, sourceGeneration: number, key: string | null) {
		const isCurrent = () => generation === this.instructionCatalogGeneration && sourceGeneration === this.instructionSourceGeneration && tenant === this.selectedTenant.get();
		if (!isCurrent()) throw new Error("The instruction owner or source changed.");
		const catalog = await this.fetchJson<PersonalInstructionCatalog>(this.buildInstructionPath("/api/instructions/catalog"));
		if (!isCurrent()) throw new Error("The instruction owner or source changed.");
		const source = key && catalog.items.some((item) => item.key === key)
			? await this.fetchJson<InstructionSourceResult>(this.buildInstructionPath(`/api/instructions/source?key=${encodeURIComponent(key)}`)) : null;
		if (!isCurrent()) throw new Error("The instruction owner or source changed.");
		this.instructionCatalog.set(catalog);
		this.instructionSource.set(source);
		this.instructionConflict.set(null);
		this.instructionError.set(null);
		if (!source) {
			this.selectedInstructionKey.set(null);
			this.writeRoute(this.currentRoute());
		}
	}

	public async resetInstructionSource(inspection: InstructionResetInspection) {
		const current = this.instructionSource.get();
		if (!current || this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		const tenant = this.selectedTenant.get();
		const generation = this.instructionSourceGeneration;
		this.instructionSaving.set(true);
		try {
			const response = await fetch(this.buildInstructionPath("/api/instructions/reset"), {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: inspection.key, expectedRevision: inspection.currentSource.source.revision })
			});
			if (!response.ok) throw new Error(await response.text());
			const reset = await response.json() as InstructionSourceResult;
			if (generation !== this.instructionSourceGeneration || tenant !== this.selectedTenant.get() || this.instructionSource.get() !== current) {
				throw new Error("The instruction owner or source changed.");
			}
			this.instructionConflict.set(null);
			this.instructionError.set(null);
			this.instructionSource.set(reset);
			const catalog = this.instructionCatalog.get();
			if (catalog) this.instructionCatalog.set({ ...catalog, items: catalog.items.map((item) => item.key === reset.key ? reset : item) });
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async commitInstructionChanges(changes: import("@agent-issues/core").InstructionChange[]) {
		if (this.instructionSaving.get()) throw new Error("An instruction operation is in progress.");
		const tenant = this.selectedTenant.get();
		const generation = this.instructionCatalogGeneration;
		const sourceGeneration = this.instructionSourceGeneration;
		this.instructionSaving.set(true);
		try {
			const response = await fetch(this.buildInstructionPath("/api/instructions/changes"), {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes })
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as import("@agent-issues/core").InstructionChangesResult;
			if (tenant !== this.selectedTenant.get() || generation !== this.instructionCatalogGeneration || sourceGeneration !== this.instructionSourceGeneration) {
				throw new Error("The instruction owner or source changed.");
			}
			const saved = new Map(result.changes.map((change) => [change.source.key, change.source]));
			const catalog = this.instructionCatalog.get();
			if (catalog) this.instructionCatalog.set({ ...catalog, items: catalog.items.map((item) => saved.get(item.key) ?? item) });
			const current = this.instructionSource.get();
			if (current && saved.has(current.key)) this.instructionSource.set(saved.get(current.key)!);
			this.instructionConflict.set(null);
			this.instructionError.set(null);
			return result;
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async previewInstructionSource(key: string, body: string, changes = [{ key, body }]): Promise<InstructionPreview> {
		const response = await fetch(this.buildInstructionPath("/api/instructions/preview"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key, changes })
		});
		if (!response.ok) throw new Error(await response.text());
		return response.json();
	}

	public async saveInstructionSource(body: string, expectedRevision?: number) {
		const current = this.instructionSource.get();
		if (!current || this.instructionSaving.get()) return false;
		const generation = this.instructionSourceGeneration;
		const path = this.buildInstructionPath("/api/instructions/source");
		const readPath = this.buildInstructionPath(`/api/instructions/source?key=${encodeURIComponent(current.key)}`);
		this.instructionSaving.set(true);
		this.instructionError.set(null);
		this.instructionConflict.set(null);
		try {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: current.key, body, expectedRevision: expectedRevision ?? current.source.revision })
			});
			if (!response.ok) throw new Error(await response.text());
			const saved = await response.json() as InstructionSourceResult;
			if (generation !== this.instructionSourceGeneration) return false;
			this.instructionSource.set(saved);
			const catalog = this.instructionCatalog.get();
			if (catalog) this.instructionCatalog.set({ ...catalog, items: catalog.items.map((item) => item.key === saved.key ? saved : item) });
			return true;
		} catch (error) {
			if (generation === this.instructionSourceGeneration) {
				this.instructionError.set(error instanceof Error ? error.message : String(error));
				try {
					const latest = await this.fetchJson<InstructionSourceResult>(readPath);
					if (generation === this.instructionSourceGeneration && latest.source.revision !== current.source.revision) {
						this.instructionConflict.set(latest);
					}
				} catch {
					if (generation === this.instructionSourceGeneration) this.instructionError.set(`${this.instructionError.get()} The saved revision could not be read.`);
				}
			}
			return false;
		} finally {
			this.instructionSaving.set(false);
		}
	}

	public async loadInstructionCatalog() {
		if (!this.allowInstructionNavigation(() => { void this.loadInstructionCatalog(); })) return;
		this.instructionConflict.set(null);
		const generation = ++this.instructionCatalogGeneration;
		this.instructionSourceGeneration += 1;
		this.instructionCatalog.set(null);
		this.instructionSource.set(null);
		this.instructionSourceLoading.set(false);
		this.instructionCatalogLoading.set(true);
		this.instructionError.set(null);
		try {
			const catalog = await this.fetchJson<PersonalInstructionCatalog>(this.buildInstructionPath("/api/instructions/catalog"));
			if (generation !== this.instructionCatalogGeneration) return;
			this.instructionCatalog.set(catalog);
			if (this.selectedInstructionKey.get()) await this.selectInstruction(this.selectedInstructionKey.get(), { writeRoute: false });
		} catch (error) {
			if (generation === this.instructionCatalogGeneration) this.instructionError.set(error instanceof Error ? error.message : String(error));
		} finally {
			if (generation === this.instructionCatalogGeneration) this.instructionCatalogLoading.set(false);
		}
	}

	protected buildInstructionPath(path: string) {
		const tenant = this.selectedTenant.get();
		return tenant ? `${path}${path.includes("?") ? "&" : "?"}tenant=${encodeURIComponent(tenant)}` : path;
	}

	public config = signal<SiteConfig | null>(null);
	public snapshot = signal<Snapshot | null>(null);
	public projectSummary = signal<ProjectSummary | null>(null);
	public entityDetails = signal<Map<string, CachedEntityDetail>>(new Map());
	public projectAdrsCache = signal<CachedProjectAdrs>({ data: null, error: null, loading: false });
	public projectDebtCache = signal<CachedProjectRecordData>({ data: null, error: null, loading: false });
	public projectContextCache = signal<CachedProjectContext>({ data: null, error: null, loading: false });
	public projectGraphCache = signal<CachedProjectRecordData>({ data: null, error: null, loading: false });
	public planEntryPages = signal<Map<string, CachedPlanEntryPage>>(new Map());
	public issueCommentPages = signal<Map<string, CachedIssueCommentPage>>(new Map());
	public initiativeDetails = signal<Map<string, CachedInitiativeDetail>>(new Map());
	public initiativeTabs = signal<Map<string, CachedInitiativeTab>>(new Map());
	public projectDiscovery = signal<ProjectDiscovery | null>(null);
	public search = signal("");
	public globalSearchCapability = signal<SearchCapability | null>(null);
	public globalSearchQuery = signal("");
	public globalSearchScope = signal<"current-project" | "all-projects">("current-project");
	public globalSearchSourceTypes = signal<SearchSourceType[]>(["entity", "context", "context-term", "plan-entry", "issue-comment"]);
	public globalSearchResponse = signal<SearchResponse | null>(null);
	public globalSearchResults = signal<SearchResult[]>([]);
	public globalSearchRecents = signal<SearchNavigationTarget[]>([]);
	public globalSearchProgress = signal(false);
	public globalSearchOpen = signal(false);
	public contextSearch = signal("");
	public contextTab = signal<ContextPageTab>("all");
	public selectedContextInitiativeId = signal<string | null>(null);
	public visibleProjectGraphKinds = signal<Set<ProjectGraphKind>>(new Set(PROJECT_GRAPH_KINDS));
	public initiativeStatusFilter = signal("all");
	public initiativeSort = signal<InitiativeSortCriterion>("changed");
	public adrStatusFilter = signal("all");
	public debtLifecycleFilter = signal("open");
	public debtCategoryFilter = signal("all");
	public debtPriorityFilter = signal("all");
	public kindFilter = signal("all");
	public selectedTenant = signal<string | null>(null);
	public selectedProjectId = signal<string | null>(null);
	public selectedInitiativeId = signal<string | null>(null);
	public selectedId = signal<string | null>(null);
	public entityBackStack = signal<string[]>([]);
	public selectedNestedTarget = signal<NestedRouteTarget | null>(null);
	public cascadePath = signal<string[]>([]);
	public cascadeAvailableWidth = signal<number>(0);
	public cascadeWindowStart = signal<number | null>(null);
	public reRootTrail = signal<string[][]>([]);
	public railCollapsed = signal<boolean>(false);
	public masterCollapsedOverride = signal<boolean | null>(null);
	public collapsedEpicIdsByProject = signal<Map<string, Set<string>>>(new Map());
	public syncLabel = signal("loading");
	public errorMessage = signal<string | null>(null);
	public activeView = signal<ViewMode>("overview");
	public activePage = signal<PageMode>("list");
	public activeRootTab = signal<RootTab>("initiatives");
	public activeSection = signal<ConsoleSection>("initiatives");
	public initTab = signal<InitiativeTab>("overview");
	protected globalSearchAbortController: AbortController | null = null;
	protected globalSearchProgressTimer: number | null = null;
	protected globalSearchRequestTimer: number | null = null;
	protected initiativeTabPrefetchGeneration = 0;
	protected initiativeTabPrefetchTimer: number | null = null;
	protected localChangeCorrelations = new Map<string, number>();

	public tenantById = computed(() => new Map((this.config.get()?.availableTenants ?? []).map((tenant) => [tenant.id, tenant])));

	public tenantOptions = computed(() => {
		const tenants = new Map(this.tenantById.get());
		const selectedTenant = this.selectedTenant.get();
		if (selectedTenant && !tenants.has(selectedTenant)) {
			tenants.set(selectedTenant, {
				displayName: this.formatTenantDisplayName(selectedTenant),
				id: selectedTenant
			});
		}

		return [...tenants.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
	});

	public selectedTenantDisplayName = computed(() => {
		const selectedTenant = this.selectedTenant.get();
		if (!selectedTenant) {
			return null;
		}

		return this.tenantById.get().get(selectedTenant)?.displayName ?? this.formatTenantDisplayName(selectedTenant);
	});

	public selectedProjectDisplayName = computed(() => {
		const selectedProjectId = this.selectedProjectId.get();
		if (!selectedProjectId) {
			return null;
		}
		const discovery = this.projectDiscovery.get();
		if (discovery?.kind !== "available") {
			return selectedProjectId;
		}

		return discovery.projects.find((entry) => entry.project.id === selectedProjectId)?.project.title ?? selectedProjectId;
	});

	public entityById = computed(() => {
		const snapshot = this.snapshot.get();
		const bundleEntities = snapshot?.initiatives.flatMap((bundle) => [
			bundle.initiative,
			...bundle.prds,
			...bundle.userStories,
			...bundle.adrs,
			...bundle.issues
		]) ?? [];
		const entityDetails = [...this.entityDetails.get().values()]
			.flatMap((entry) => entry.detail ? [entry.detail] : []);
		const detailEntities = entityDetails.map((details) => details.entity);
		const relatedEntities = entityDetails.flatMap((details) => [
			...(details.incoming ?? []).map(({ entity }) => entityFromSummary(entity)),
			...(details.outgoing ?? []).map(({ entity }) => entityFromSummary(entity))
		]);
		return new Map([...(snapshot?.entities ?? []), ...(snapshot?.projectAdrs ?? []), ...bundleEntities, ...relatedEntities, ...detailEntities].map((entity) => [entity.id, entity]));
	});

	public globalSearchRecentRecords = computed(() => this.globalSearchRecents.get().flatMap((target): GlobalSearchRecent[] => {
		const snapshot = this.snapshot.get();
		if (!snapshot) {
			return [];
		}

		if (target.type === "entity") {
			const entity = this.entityForId(target.entityId);
			return entity ? [{ sourceType: "entity", target, title: entity.title }] : [];
		}

		if (target.type === "plan-entry") {
			const entry = snapshot.planEntries?.find((candidate) => candidate.id === target.entryId && candidate.planId === target.planId && !candidate.tombstone);
			return entry && this.entityForId(target.planId) ? [{ sourceType: "plan-entry", target, title: entry.body ?? "Plan entry" }] : [];
		}

		if (target.type === "issue-comment") {
			const comment = snapshot.issueComments[target.issueId]?.comments.find((candidate) => candidate.id === target.commentId && !candidate.tombstone);
			return comment && this.entityForId(target.issueId) ? [{ sourceType: "issue-comment", target, title: comment.body ?? "Comment" }] : [];
		}

		const contexts = [snapshot.contexts.shared, ...snapshot.contexts.initiatives];
		const context = target.scopeRef
			? contexts.find((candidate) => candidate.context.key === target.scopeRef || candidate.context.scopeEntityId === target.scopeRef)
			: snapshot.contexts.shared;
		if (!context?.context.exists) {
			return [];
		}

		if (target.type === "context") {
			return [{ sourceType: "context", target, title: context.context.title }];
		}

		const term = context.terms.find((candidate) => candidate.term === target.term);
		return term ? [{ sourceType: "context-term", target, title: term.term }] : [];
	}));

	public entityForId(entityId: string | null): Entity | null {
		return entityId ? this.entityById.get().get(entityId) ?? null : null;
	}

	public requestEntityTab(entityId: string, tab: string) {
		if (tab === "plan") {
			void this.loadPlanEntryPage(entityId);
		}
	}

	public async loadMorePlanEntries(planId: string) {
		const before = this.planEntryPages.get().get(planId)?.data?.nextBefore;
		if (before) {
			await this.loadPlanEntryPage(planId, false, before);
		}
	}

	public async loadMoreIssueComments(issueId: string) {
		const before = this.issueCommentPages.get().get(issueId)?.data?.nextBefore;
		if (before) {
			await this.loadIssueCommentPage(issueId, false, before);
		}
	}

	public openGlobalSearch() {
		this.globalSearchOpen.set(true);
		this.globalSearchRecents.set(this.readGlobalSearchRecents());
		void this.reloadGlobalSearchCapability();
	}

	public planEntriesFor(planId: string): PlanEntry[] {
		return this.planEntryPages.get().get(planId)?.data?.entries ?? (this.snapshot.get()?.planEntries ?? []).filter((entry) => entry.planId === planId);
	}

	public issueCommentsFor(issueId: string) {
		return this.issueCommentPages.get().get(issueId)?.data?.comments ?? this.snapshot.get()?.issueComments[issueId]?.comments ?? [];
	}

	public displayUser(userId: string, issueId: string): string {
		const user = this.issueCommentPages.get().get(issueId)?.data?.users.find((candidate) => candidate.id === userId)
			?? this.snapshot.get()?.users.find((candidate) => candidate.id === userId);
		return user?.displayName ?? user?.authenticationSubject ?? userId;
	}

	public closeGlobalSearch() {
		this.globalSearchOpen.set(false);
		this.setGlobalSearchQuery("");
	}

	public setGlobalSearchQuery(query: string) {
		this.globalSearchQuery.set(query);
		this.globalSearchResponse.set(null);
		this.globalSearchProgress.set(false);
		this.cancelGlobalSearchRequest();

		if (!query.trim()) {
			this.globalSearchResults.set([]);
			return;
		}

		this.globalSearchRequestTimer = window.setTimeout(() => {
			void this.requestGlobalSearch(query);
		}, 150);
	}

	public setGlobalSearchScope(scope: "current-project" | "all-projects") {
		this.globalSearchScope.set(scope);
		this.setGlobalSearchQuery(this.globalSearchQuery.get());
	}

	public setGlobalSearchSourceTypes(sourceTypes: SearchSourceType[]) {
		this.globalSearchSourceTypes.set(sourceTypes);
		this.setGlobalSearchQuery(this.globalSearchQuery.get());
	}

	public async retryGlobalSearch() {
		const query = this.globalSearchQuery.get();
		if (query.trim()) {
			await this.requestGlobalSearch(query);
		}
	}

	public async reloadGlobalSearchCapability() {
		const tenantId = this.selectedTenant.get();
		if (!tenantId) {
			this.globalSearchCapability.set(null);
			return;
		}

		try {
			const response = await fetch(`/api/search/capability?${new URLSearchParams({ tenant: tenantId })}`, { cache: "no-store" });
			if (!response.ok) {
				throw new Error("Global search capability request failed.");
			}

			const capability = (await response.json()) as SearchCapability;
			if (this.selectedTenant.get() === tenantId) {
				this.globalSearchCapability.set(capability);
			}
		} catch {
			this.globalSearchCapability.set(null);
		}
	}

	protected async requestGlobalSearch(query: string) {
		if (query !== this.globalSearchQuery.get()) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		if (!tenantId || !projectId) {
			return;
		}

		const abortController = new AbortController();
		this.globalSearchAbortController = abortController;
		this.globalSearchProgressTimer = window.setTimeout(() => {
			if (this.globalSearchAbortController === abortController) {
				this.globalSearchProgress.set(true);
			}
		}, 150);
		const params = new URLSearchParams({
			tenant: tenantId,
			project: projectId,
			query,
			scope: this.globalSearchScope.get()
		});
		params.set("sourceTypes", this.globalSearchSourceTypes.get().join(","));

		try {
			const response = await fetch(`/api/search?${params}`, { cache: "no-store", signal: abortController.signal });
			if (!response.ok) {
				throw new Error("Global search request failed.");
			}

			const result = (await response.json()) as SearchResponse;
			if (this.globalSearchAbortController === abortController) {
				this.globalSearchResponse.set(result);
				if (result.state === "available") {
					this.globalSearchResults.set(result.results);
				}
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return;
			}

			if (this.globalSearchAbortController === abortController) {
				this.globalSearchResponse.set({ state: "operational-error" });
			}
		} finally {
			if (this.globalSearchAbortController === abortController) {
				this.globalSearchAbortController = null;
				this.clearGlobalSearchProgressTimer();
				this.globalSearchProgress.set(false);
			}
		}
	}

	protected cancelGlobalSearchRequest() {
		if (this.globalSearchRequestTimer !== null) {
			window.clearTimeout(this.globalSearchRequestTimer);
			this.globalSearchRequestTimer = null;
		}

		this.globalSearchAbortController?.abort();
		this.globalSearchAbortController = null;
		this.clearGlobalSearchProgressTimer();
	}

	protected clearGlobalSearchProgressTimer() {
		if (this.globalSearchProgressTimer !== null) {
			window.clearTimeout(this.globalSearchProgressTimer);
			this.globalSearchProgressTimer = null;
		}
	}

	public cascadeColumns = computed(() =>
		this.cascadePath.get()
			.map((entityId) => this.entityForId(entityId))
			.filter((entity): entity is Entity => Boolean(entity))
	);

	public masterCollapsed = computed((): boolean => {
		const override = this.masterCollapsedOverride.get();
		if (override !== null) {
			return override;
		}

		return false;
	});

	public readonly cascadeColumnWidth = 480;
	public readonly cascadeColumnGap = 16;

	public cascadeCapacityForWidth(availableWidth: number): number {
		if (availableWidth <= 0) {
			return Number.POSITIVE_INFINITY;
		}

		return Math.max(1, Math.floor(availableWidth / (this.cascadeColumnWidth + this.cascadeColumnGap)));
	}

	public cascadeHopRelation(parentId: string, childId: string): string | null {
		const relations = this.snapshot.get()?.relations ?? [];
		const structural = relations.find((relation) => relation.fromId === parentId && relation.toId === childId);
		if (structural) {
			return structural.type;
		}

		const reversed = relations.find((relation) => relation.fromId === childId && relation.toId === parentId);
		return reversed?.type ?? null;
	}

	public cascadeColumnWindow = computed((): { breadcrumb: Entity[]; columns: Entity[] } => {
		const path = this.cascadeColumns.get();
		const capacity = this.cascadeCapacityForWidth(this.cascadeAvailableWidth.get());
		if (path.length <= capacity) {
			return { breadcrumb: [], columns: path };
		}

		const rightAnchoredStart = path.length - capacity;
		const manualStart = this.cascadeWindowStart.get();
		const start = Math.min(Math.max(manualStart ?? rightAnchoredStart, 0), path.length - 1);

		return { breadcrumb: path.slice(0, start), columns: path.slice(start) };
	});

	public cascadePathForLeaf(leafId: string): string[] {
		const relations = this.snapshot.get()?.relations ?? [];

		const issueChain = [leafId];
		const seen = new Set<string>([leafId]);
		let currentId = leafId;

		while (true) {
			const parentRelation = relations.find((relation) => relation.type === "decomposes" && relation.toId === currentId);
			if (!parentRelation || seen.has(parentRelation.fromId)) {
				break;
			}

			issueChain.unshift(parentRelation.fromId);
			seen.add(parentRelation.fromId);
			currentId = parentRelation.fromId;
		}

		const rootIssueId = issueChain[0];
		const fixedStories = this.sortEntities(
			relations
				.filter((relation) => relation.type === "fixes" && relation.fromId === rootIssueId)
				.map((relation) => this.entityForId(relation.toId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
		const storyId = fixedStories[0]?.id ?? null;
		const spine = this.spineForStory(storyId, rootIssueId);

		return [...spine, ...issueChain];
	}

	protected spineForStory(storyId: string | null, rootIssueId: string): string[] {
		const relations = this.snapshot.get()?.relations ?? [];
		const prdId = storyId
			? relations.find((relation) => relation.type === "creates" && relation.toId === storyId)?.fromId ?? null
			: null;
		const initiativeId = prdId
			? relations.find((relation) => relation.type === "owns" && relation.toId === prdId)?.fromId ?? null
			: relations.find((relation) => relation.type === "tracks" && relation.toId === rootIssueId)?.fromId ?? null;

		const spine: string[] = [];
		if (initiativeId) {
			spine.push(initiativeId);
		}

		if (prdId) {
			spine.push(prdId);
		}

		if (storyId) {
			spine.push(storyId);
		}

		return spine;
	}

	public cascadeSeamFor(
		parentId: string,
		childId: string
	): { relation: string | null; branch: { options: Entity[]; selectedIndex: number } | null } {
		const relation = this.cascadeHopRelation(parentId, childId);
		if (relation !== "fixes") {
			return { relation, branch: null };
		}

		const relations = this.snapshot.get()?.relations ?? [];
		const options = this.sortEntities(
			relations
				.filter((candidate) => candidate.type === "fixes" && candidate.fromId === childId)
				.map((candidate) => this.entityForId(candidate.toId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
		if (options.length <= 1) {
			return { relation, branch: null };
		}

		return { relation, branch: { options, selectedIndex: options.findIndex((entity) => entity.id === parentId) } };
	}

	public selectCascadeBranch(rootIssueId: string, storyId: string) {
		const path = this.cascadePath.get();
		const chainStart = path.indexOf(rootIssueId);
		if (chainStart === -1) {
			return;
		}

		const issueChain = path.slice(chainStart);
		const spine = this.spineForStory(storyId, rootIssueId);

		this.cascadeWindowStart.set(null);
		this.cascadePath.set([...spine, ...issueChain]);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public selectedEntity = computed(() => this.entityForId(this.selectedId.get()));
	public entityBackTarget = computed(() => this.entityForId(this.entityBackStack.get().at(-1) ?? null));

	public bundleForEntityId(entityId: string | null): InitiativeBundle | null {
		if (!entityId) {
			return null;
		}

		return (
			(this.snapshot.get()?.initiatives ?? []).find((bundle) =>
				[bundle.initiative, ...bundle.entities, ...bundle.prds, ...bundle.userStories, ...bundle.adrs, ...bundle.issues].some(
					(candidate) => candidate.id === entityId
				)
			) ?? null
		);
	}

	public selectedBundle = computed(() => this.bundleForEntityId(this.selectedId.get()));

	public bundleForInitiativeId(initiativeId: string | null): InitiativeBundle | null {
		if (!initiativeId) {
			return null;
		}

		const snapshotBundle = (this.snapshot.get()?.initiatives ?? []).find((bundle) => bundle.initiative.id === initiativeId) ?? null;
		if (snapshotBundle) {
			return snapshotBundle;
		}

		const rollup = this.projectSummaryInitiatives.get().find((candidate) => candidate.initiative.id === initiativeId);
		if (!rollup) {
			return null;
		}

		const detail = this.initiativeDetailForId(initiativeId);
		const tabData = this.initiativeTabForId(initiativeId, this.initTab.get());
		const initiative: Entity = detail?.initiative ?? { ...rollup.initiative, body: "" };
		const records = tabData?.records ?? [];
		const recordsById = new Map([initiative, ...records].map((record) => [record.id, record]));
		const relationRecords = tabData?.relations ?? [];
		return {
			adrs: records.filter((record) => record.kind === "adr"),
			blockerLinks: relationRecords
				.filter((relation) => relation.type === "blocks")
				.flatMap((relation) => {
					const source = recordsById.get(relation.fromId);
					const target = recordsById.get(relation.toId);
					return source && target ? [{ source, target }] : [];
				}),
			constrainsLinks: relationRecords
				.filter((relation) => relation.type === "constrains")
				.flatMap((relation) => {
					const adr = recordsById.get(relation.fromId);
					const issue = recordsById.get(relation.toId);
					return adr && issue ? [{ adr, issue }] : [];
				}),
			entities: [initiative, ...records],
			fixLinks: relationRecords
				.filter((relation) => relation.type === "fixes")
				.flatMap((relation) => {
					const issue = recordsById.get(relation.fromId);
					const userStory = recordsById.get(relation.toId);
					return issue && userStory ? [{ issue, userStory }] : [];
				}),
			initiative,
			issues: records.filter((record) => record.kind === "issue"),
			prds: records.filter((record) => record.kind === "prd"),
			relations: relationRecords,
			subIssueLinks: relationRecords
				.filter((relation) => relation.type === "decomposes")
				.flatMap((relation) => {
					const parent = recordsById.get(relation.fromId);
					const issue = recordsById.get(relation.toId);
					return parent && issue ? [{ parent, issue }] : [];
				}),
			userStories: records.filter((record) => record.kind === "userStory")
		};
	}

	public selectedInitiativeBundle = computed(() => this.bundleForInitiativeId(this.selectedInitiativeId.get()));

	public initiativeDetailForId(initiativeId: string | null): InitiativeDetail | null {
		return initiativeId ? this.initiativeDetails.get().get(initiativeId)?.detail ?? null : null;
	}

	public initiativeTabForId(initiativeId: string | null, tab: InitiativeTab): InitiativeTabData | null {
		return initiativeId ? this.initiativeTabs.get().get(this.initiativeTabCacheKey(initiativeId, tab))?.data ?? null : null;
	}

	public isSummaryInitiative(initiativeId: string): boolean {
		return !this.snapshot.get()?.initiatives.some((bundle) => bundle.initiative.id === initiativeId) &&
			this.projectSummaryInitiatives.get().some((rollup) => rollup.initiative.id === initiativeId);
	}

	public activeInitiativeId = computed(() => this.selectedInitiativeId.get() ?? this.selectedBundle.get()?.initiative.id ?? null);

	public sharedContext = computed(() => this.projectContextCache.get().data?.shared ?? this.snapshot.get()?.contexts.shared ?? null);

	public initiativeContextById = computed(() =>
		new Map(
			(this.projectContextCache.get().data?.initiatives ?? this.snapshot.get()?.contexts.initiatives ?? [])
				.filter((details) => Boolean(details.context.scopeEntityId))
				.map((details) => [details.context.scopeEntityId ?? details.context.key, details])
		)
	);

	public selectedContext = computed(() => {
		const bundle = this.selectedBundle.get();
		if (bundle) {
			return this.initiativeContextById.get().get(bundle.initiative.id) ?? null;
		}

		return this.sharedContext.get();
	});

	public projectContextTerms = computed(() => {
		const scopedTerms = this.projectContextCache.get().data?.terms;
		if (scopedTerms) {
			return scopedTerms;
		}

		const termsByKey = new Map<string, ProjectContextTermEntry>();
		for (const details of [this.sharedContext.get(), ...(this.projectContextCache.get().data?.initiatives ?? this.snapshot.get()?.contexts.initiatives ?? [])]) {
			if (!details) {
				continue;
			}

			for (const term of details.terms) {
				const key = term.term.toLowerCase();
				const source: ProjectContextTermSource = {
					avoid: [...term.avoid],
					contextKey: details.context.key,
					contextTitle: details.context.title,
					definition: term.definition,
					scopeEntityId: details.context.scopeEntityId,
					scopeKind: details.context.scopeKind,
					scopeLabel: details.context.scopeLabel,
					updatedAt: term.updatedAt
				};
				const existing = termsByKey.get(key);

				if (!existing) {
					termsByKey.set(key, {
						term: term.term,
						sources: [source],
						hasSharedSource: details.context.scopeKind === "default",
						hasDuplicates: false,
						hasConflictingDefinitions: false
					});
					continue;
				}

				existing.sources.push(source);
				existing.hasDuplicates = existing.sources.length > 1;
				existing.hasSharedSource = existing.hasSharedSource || details.context.scopeKind === "default";
				existing.hasConflictingDefinitions = hasConflictingDefinitions(existing.sources);
				if (term.term.localeCompare(existing.term) < 0) {
					existing.term = term.term;
				}
			}
		}

		return [...termsByKey.values()]
			.map((entry) => ({
				...entry,
				sources: entry.sources.sort(compareProjectContextSources)
			}))
			.sort((left, right) => left.term.localeCompare(right.term));
	});

	public filteredProjectContextTerms = computed(() => {
		const query = this.contextSearch.get().trim().toLowerCase();
		if (!query) {
			return this.projectContextTerms.get();
		}

		return this.projectContextTerms.get().filter((entry) => {
			if (entry.term.toLowerCase().includes(query)) {
				return true;
			}

			return entry.sources.some((source) =>
				[
					source.scopeLabel,
					source.contextTitle,
					source.definition,
					...source.avoid
				]
					.join(" ")
					.toLowerCase()
					.includes(query)
			);
		});
	});

	public filteredInitiativeContextTerms = computed(() => {
		const selectedInitiativeId = this.selectedContextInitiativeId.get();
		const query = this.contextSearch.get().trim().toLowerCase();

		return this.projectContextTerms.get()
			.map((entry) => {
				const sources = entry.sources.filter(
					(source) =>
						source.scopeKind === "initiative" &&
						(!selectedInitiativeId || source.scopeEntityId === selectedInitiativeId)
				);

				if (sources.length === 0) {
					return null;
				}

				const matchesQuery = !query || entry.term.toLowerCase().includes(query) || sources.some((source) =>
					[source.scopeLabel, source.contextTitle, source.definition, ...source.avoid]
						.join(" ")
						.toLowerCase()
						.includes(query)
				);

				if (!matchesQuery) {
					return null;
				}

				return {
					...entry,
					sources,
					hasSharedSource: false,
					hasDuplicates: sources.length > 1,
					hasConflictingDefinitions: hasConflictingDefinitions(sources)
				};
			})
			.filter((entry): entry is ProjectContextTermEntry => entry !== null);
	});

	public filteredSharedContext = computed(() => {
		const details = this.sharedContext.get();
		if (!details) {
			return null;
		}

		const query = this.contextSearch.get().trim().toLowerCase();
		if (!query) {
			return details;
		}

		const contextMatches = [details.context.key, details.context.scopeLabel, details.context.summary, details.context.title]
			.join(" ")
			.toLowerCase()
			.includes(query);
		const filteredTerms = details.terms.filter((term) =>
			[term.term, term.definition, ...term.avoid]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);

		if (!contextMatches && filteredTerms.length === 0) {
			return null;
		}

		return {
			context: {
				...details.context,
				summary: contextMatches ? details.context.summary : ""
			},
			terms: filteredTerms
		};
	});

	public projectContextDuplicateCount = computed(() => this.projectContextTerms.get().filter((entry) => entry.hasDuplicates).length);

	public incomingRelationsFor(entityId: string | null): Relation[] {
		if (!entityId) {
			return [];
		}

		return this.scopedRelations().filter((relation) => relation.toId === entityId);
	}

	public outgoingRelationsFor(entityId: string | null): Relation[] {
		if (!entityId) {
			return [];
		}

		return this.scopedRelations().filter((relation) => relation.fromId === entityId);
	}

	public scopedRelations(): Relation[] {
		const relationByKey = new Map<string, Relation>();
		for (const relation of this.snapshot.get()?.relations ?? []) {
			relationByKey.set(`${relation.fromId}:${relation.type}:${relation.toId}`, relation);
		}
		for (const details of [...this.entityDetails.get().values()]
			.flatMap((entry) => entry.detail ? [entry.detail] : [])) {
			for (const relation of relationsFromEntityDetails(details)) {
				relationByKey.set(`${relation.fromId}:${relation.type}:${relation.toId}`, relation);
			}
		}
		return [...relationByKey.values()];
	}

	public selectedIncoming = computed(() => this.incomingRelationsFor(this.selectedId.get()));

	public selectedOutgoing = computed(() => this.outgoingRelationsFor(this.selectedId.get()));

	public relatedEntities = computed(() => {
		const relatedIds = new Set<string>();
		for (const relation of [...this.selectedIncoming.get(), ...this.selectedOutgoing.get()]) {
			relatedIds.add(relation.fromId);
			relatedIds.add(relation.toId);
		}
		relatedIds.delete(this.selectedId.get() ?? "");

		return this.sortEntities(
			[...relatedIds]
				.map((entityId) => this.entityById.get().get(entityId))
				.filter((entity): entity is Entity => Boolean(entity))
		);
	});

	public localGraphEntities = computed(() => {
		const selectedEntity = this.selectedEntity.get();
		return selectedEntity ? [selectedEntity, ...this.relatedEntities.get()] : [];
	});

	public localGraphRelations = computed(() => {
		const localIds = new Set(this.localGraphEntities.get().map((entity) => entity.id));
		return this.scopedRelations().filter((relation) => localIds.has(relation.fromId) && localIds.has(relation.toId));
	});

	public filteredEntities = computed(() => {
		const query = this.search.get().trim().toLowerCase();
		const kindFilter = this.kindFilter.get();

		return this.sortEntities(
			(this.snapshot.get()?.entities ?? []).filter((entity) => {
				if (kindFilter !== "all" && entity.kind !== kindFilter) {
					return false;
				}

				if (!query) {
					return true;
				}

				return [entity.id, entity.kind, entity.status, entity.title].join(" ").toLowerCase().includes(query);
			})
		);
	});

	public kindOptions = computed(() => [
		"issue",
		"all",
		...new Set((this.snapshot.get()?.entities ?? []).map((entity) => entity.kind).filter((kind) => kind !== "issue"))
	]);

	public rootTabCounts = computed(() => ({
		adrs: (this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "adr").length,
		initiatives: this.snapshot.get()?.initiatives.length ?? 0
	}));

	public allDebtRecords = computed(() => this.sortEntities(
		this.projectDebtCache.get().data?.records ?? (this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "debt")
	));

	public debtRecords = computed(() => {
		const lifecycle = this.debtLifecycleFilter.get();
		const category = this.debtCategoryFilter.get();
		const priority = this.debtPriorityFilter.get();
		return this.sortEntities(
			this.allDebtRecords.get().filter(
				(entity) =>
					(lifecycle === "all" || entity.status === lifecycle) &&
					(category === "all" || entity.category === category) &&
					(priority === "all" || entity.priority === priority)
			)
		);
	});

	public projectInitiatives = computed(() => this.snapshot.get()?.initiatives ?? this.projectSummaryInitiatives.get().map((rollup) => ({
		adrs: [],
		blockerLinks: [],
		constrainsLinks: [],
		entities: [entityFromSummary(rollup.initiative)],
		fixLinks: [],
		initiative: entityFromSummary(rollup.initiative),
		issues: [],
		prds: [],
		subIssueLinks: [],
		userStories: []
	})));

	public projectSummaryEpicGroups = computed(() => {
		const summary = this.projectSummary.get();
		return summary?.kind === "available" ? summary.epics : [];
	});

	public projectSummaryInitiatives = computed<InitiativeRollup[]>(() =>
		this.projectSummaryEpicGroups.get().flatMap((group) => group.initiatives)
	);

	public epicInitiativeGroups = computed<EpicInitiativeGroup[]>(() => {
		const snapshot = this.snapshot.get();
		if (!snapshot) {
			return [];
		}

		const bundlesByInitiativeId = new Map(snapshot.initiatives.map((bundle) => [bundle.initiative.id, bundle]));
		const initiativeIdsByEpicId = new Map<string, string[]>();
		for (const relation of snapshot.relations) {
			if (relation.type !== "contains" || !bundlesByInitiativeId.has(relation.toId)) {
				continue;
			}

			const initiativeIds = initiativeIdsByEpicId.get(relation.fromId) ?? [];
			initiativeIds.push(relation.toId);
			initiativeIdsByEpicId.set(relation.fromId, initiativeIds);
		}

		return this.sortEntities(snapshot.entities.filter((entity) => entity.kind === "epic"))
			.map((epic) => {
				const initiatives = (initiativeIdsByEpicId.get(epic.id) ?? [])
					.map((initiativeId) => bundlesByInitiativeId.get(initiativeId))
					.filter((bundle): bundle is InitiativeBundle => Boolean(bundle));
				return {
					epic,
					initiatives,
					completedInitiativeCount: initiatives.filter((bundle) => this.isDoneStatus(bundle.initiative.status)).length
				};
			})
			.filter((group) => group.initiatives.length > 0);
	});

	public projectAdrs = computed(() => this.sortEntities(
		this.projectAdrsCache.get().data?.projectAdrs ?? this.snapshot.get()?.projectAdrs ?? (this.snapshot.get()?.entities ?? []).filter((entity) => entity.kind === "adr")
	));

	public adrRailEntries = computed<AdrRailEntry[]>(() => {
		const snapshot = this.snapshot.get();
		const projectEntries = this.projectAdrs.get().map((adr) => ({
			adr,
			scope: "project" as const,
			scopeLabel: "project decision"
		}));

		const initiativeAdrs = this.projectAdrsCache.get().data?.initiativeAdrs;
		const initiativeEntries = (initiativeAdrs ?? snapshot?.initiatives ?? []).flatMap((entry) =>
			this.sortEntities(entry.adrs).map((adr) => ({
				adr,
				scope: "initiative" as const,
				scopeLabel: `initiative ${entry.initiative.title}`
			}))
		);

		return [...projectEntries, ...initiativeEntries];
	});

	public projectStoryCount = computed(() => this.projectSummaryInitiatives.get().reduce((total, rollup) => total + rollup.userStoryCount, 0));

	public projectIssueCount = computed(() => this.projectSummaryInitiatives.get().reduce((total, rollup) => total + rollup.issueCount, 0));

	public projectDescription = computed(() => this.sharedContext.get()?.context.summary ?? this.selectedTenantDisplayName.get() ?? "");

	public orphanIds = computed(() => new Set((this.snapshot.get()?.orphans ?? []).map((entity) => entity.id)));

	public connected = false;
	public events: EventSource | null = null;
	public pollTimer: number | null = null;

	public connect() {
		if (this.connected) {
			return;
		}

		this.connected = true;
		this.applyRoute(this.readRoute(), false);
		window.addEventListener("hashchange", this.onBrowserNavigation);
		window.addEventListener("popstate", this.onPopState);
		void this.bootstrap();
	}

	public disconnect() {
		if (!this.connected) {
			return;
		}

		this.connected = false;
		this.cancelInitiativeTabPrefetch();
		window.removeEventListener("hashchange", this.onBrowserNavigation);
		window.removeEventListener("popstate", this.onPopState);
		this.cancelGlobalSearchRequest();
		this.events?.close();
		this.events = null;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	public applyLocalProjectChange(event: ProjectChangeEvent) {
		this.handleProjectChange(event);
		this.registerLocalChangeCorrelation(event.correlationId);
	}

	public async mutateProject<T>(method: string, params: unknown): Promise<T> {
		const correlationId = globalThis.crypto.randomUUID();
		this.registerLocalChangeCorrelation(correlationId);

		try {
			const response = await fetch(this.buildTenantScopedPath("/api/project-mutation"), {
				body: JSON.stringify({ correlationId, method, params }),
				cache: "no-store",
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			if (!response.ok) {
				throw new Error(`Project mutation ${method} failed.`);
			}

			const payload = await response.json() as { event: ProjectChangeEvent; result: T };
			this.applyLocalProjectChange(payload.event);
			return payload.result;
		} catch (error) {
			this.localChangeCorrelations.delete(correlationId);
			throw error;
		}
	}

	protected registerLocalChangeCorrelation(correlationId: string | undefined) {
		if (!correlationId) {
			return;
		}
		const now = Date.now();
		for (const [pendingCorrelationId, expiresAt] of this.localChangeCorrelations) {
			if (expiresAt < now) {
				this.localChangeCorrelations.delete(pendingCorrelationId);
			}
		}
		this.localChangeCorrelations.set(correlationId, now + LOCAL_CHANGE_CORRELATION_TTL_MS);
	}

	public onHashChange = () => {
		const requested = this.readRoute();
		if (this.isHistoryRestoration() || this.isCurrentInstructionRoute(requested)) return;
		if (this.isStagedInstructionRoute(requested)) {
			void this.navigateStagedInstructionRoute(requested);
			return;
		}
		if (!this.allowBrowserNavigation(() => {
			const route = this.applyRoute(requested);
			this.writeRoute(route, true);
		})) return;
		const route = this.applyRoute(requested);
		this.writeRoute(route, true);
	};

	public onPopState = async () => {
		const route = this.readRoute();
		if (this.isHistoryRestoration() || this.isCurrentInstructionRoute(route)) return;
		if (this.isStagedInstructionRoute(route)) {
			await this.navigateStagedInstructionRoute(route);
			return;
		}
		if (!this.allowBrowserNavigation(() => {
			void this.navigateToRoute(route);
		})) return;
		if (route.tenantId !== this.selectedTenant.get() || route.projectId !== this.selectedProjectId.get()) {
			await this.navigateToRoute(route);
			return;
		}

		this.applyRoute(route);
	};

	public onBrowserNavigation = async () => {
		const route = this.readRoute();
		if (this.isHistoryRestoration() || this.isCurrentInstructionRoute(route)) return;
		if (this.isStagedInstructionRoute(route)) {
			await this.navigateStagedInstructionRoute(route);
			return;
		}
		if (!this.allowBrowserNavigation(() => {
			void this.navigateToRoute(route);
		})) return;
		await this.navigateToRoute(route);
		const params = new URLSearchParams(new URL(window.location.href).hash.slice(1));
		if (params.has("cascade")) {
			this.writeRoute(this.currentRoute(), true);
		}
	};

	protected isStagedInstructionRoute(route: ViewerRoute) {
		return !!this.instructionItemNavigator && this.activePage.get() === "instructions" && route.page === "instructions"
			&& route.tenantId === this.selectedTenant.get() && route.projectId === this.selectedProjectId.get();
	}

	protected async navigateStagedInstructionRoute(route: ViewerRoute) {
		const generation = ++this.browserNavigationGeneration;
		await this.instructionItemNavigator?.(route.instructionKey ?? null, route.instructionCategory ?? "agent");
		if (generation !== this.browserNavigationGeneration || !this.isStagedInstructionRoute(route)) return;
		this.routeHistoryPosition = this.readHistoryPosition() ?? this.routeHistoryPosition;
		if (!this.isCurrentInstructionRoute(route)) this.writeRoute(this.currentRoute(), true);
	}

	protected allowBrowserNavigation(navigate: () => void) {
		const targetPosition = this.readHistoryPosition();
		const currentPosition = this.routeHistoryPosition;
		const knownTraversal = targetPosition !== null && targetPosition !== currentPosition;
		const allowed = this.allowInstructionNavigation(() => {
			if (!knownTraversal) {
				navigate();
				return;
			}
			const resume = () => window.history.go(targetPosition - currentPosition);
			if (this.historyRestoration) void this.historyRestoration.then(resume);
			else resume();
		});
		if (!allowed) {
			if (knownTraversal) {
				if (this.restoringHistoryPosition === null) {
					this.restoringHistoryPosition = currentPosition;
					this.historyRestoration = new Promise((resolve) => { this.finishHistoryRestoration = resolve; });
					window.history.go(currentPosition - targetPosition);
				}
			} else this.writeRoute(this.currentRoute(), true);
		}
		return allowed;
	}

	protected readHistoryPosition(): number | null {
		const position = window.history.state?.agentIssuesRoutePosition;
		return Number.isSafeInteger(position) ? position : null;
	}

	protected isHistoryRestoration() {
		if (this.restoringHistoryPosition === null) return false;
		if (this.readHistoryPosition() === this.restoringHistoryPosition) {
			this.restoringHistoryPosition = null;
			this.finishHistoryRestoration?.();
			this.finishHistoryRestoration = null;
			this.historyRestoration = null;
		}
		return true;
	}

	protected isCurrentInstructionRoute(route: ViewerRoute) {
		return this.activePage.get() === "instructions" && route.page === "instructions"
			&& route.tenantId === this.selectedTenant.get() && route.projectId === this.selectedProjectId.get()
			&& route.instructionKey === this.selectedInstructionKey.get() && route.instructionCategory === this.instructionCategory.get();
	}

	public setSearchFromEvent = (event: Event) => {
		this.search.set((event.target as HTMLInputElement).value);
	};

	public setKindFilterFromEvent = (event: Event) => {
		this.kindFilter.set((event.target as HTMLSelectElement).value);
	};

	public openRootTab(tab: RootTab) {
		this.activeRootTab.set(tab);
	}

	public selectSection(section: ConsoleSection) {
		if (!this.allowInstructionNavigation(() => this.selectSection(section))) return;
		this.activeSection.set(section);
		this.selectedInitiativeId.set(null);
		this.selectedId.set(null);
		this.selectedNestedTarget.set(null);
		this.initTab.set("overview");
		this.contextSearch.set("");
		this.contextTab.set("all");
		this.selectedContextInitiativeId.set(null);
		this.activePage.set("list");
		this.writeRoute(this.currentRoute());
		if (section === "adrs") {
			void this.loadProjectAdrs();
		} else if (section === "debt") {
			void this.loadProjectDebt();
		} else if (section === "context") {
			void this.loadProjectContext();
		} else if (section === "graph") {
			void this.loadProjectGraph();
		}
	}

	public setContextTab(tab: ContextPageTab) {
		this.contextTab.set(tab);
	}

	public setContextInitiativeFilter(initiativeId: string | null) {
		this.selectedContextInitiativeId.set(initiativeId);
	}

	public setMasterStatusFilter(section: "initiatives" | "adrs", status: string) {
		if (section === "initiatives") {
			this.initiativeStatusFilter.set(status);
			return;
		}

		this.adrStatusFilter.set(status);
	}

	public setInitiativeSort(criterion: InitiativeSortCriterion) {
		this.initiativeSort.set(criterion);
	}

	public setDebtFilter(filter: DebtFilter, value: string) {
		if (filter === "lifecycle") {
			this.debtLifecycleFilter.set(value);
			return;
		}

		if (filter === "category") {
			this.debtCategoryFilter.set(value);
			return;
		}

		this.debtPriorityFilter.set(value);
	}

	public setInitTab(tab: InitiativeTab) {
		this.initTab.set(tab);
		this.writeRoute(this.currentRoute());
		const initiativeId = this.selectedInitiativeId.get();
		if (initiativeId && tab !== "overview" && this.projectSummaryInitiatives.get().some((rollup) => rollup.initiative.id === initiativeId)) {
			void this.loadInitiativeTab(initiativeId, tab);
		}
	}

	public async retryInitiativeDetail(initiativeId: string) {
		await this.loadInitiativeDetail(initiativeId, true);
	}

	public async retryInitiativeTab(initiativeId: string, tab: Exclude<InitiativeTab, "overview">) {
		await this.loadInitiativeTab(initiativeId, tab, true);
	}

	public setTenantFromEvent = (event: Event) => {
		const tenantId = (event.target as HTMLSelectElement).value;
		void this.selectTenant(tenantId);
	};

	public selectEntityFromEvent = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (!entityId) {
			return;
		}

		this.selectEntity(entityId);
	};

	public openViewFromEvent = (event: Event) => {
		const nextView = (event.currentTarget as HTMLElement).dataset.view as ViewMode | undefined;
		if (!nextView) {
			return;
		}

		this.activeView.set(nextView);
	};

	public async openSearchTarget(target: SearchNavigationTarget, projectId: string | null = this.selectedProjectId.get()): Promise<boolean> {
		if (!this.allowInstructionNavigation(() => { void this.openSearchTarget(target, projectId); })) return false;
		if (projectId && projectId !== this.selectedProjectId.get()) {
			await this.selectProject(projectId, { preserveGlobalSearch: true });
			if (this.selectedProjectId.get() !== projectId) {
				return false;
			}
		}

		this.recordGlobalSearchRecent(target);

		if (target.type === "entity") {
			this.selectEntity(target.entityId);
			return true;
		}

		if (target.type === "plan-entry") {
			this.selectEntity(target.planId, { id: target.entryId, type: target.type });
			return true;
		}

		if (target.type === "issue-comment") {
			this.selectEntity(target.issueId, { id: target.commentId, type: target.type });
			return true;
		}

		if (target.type === "context" || target.type === "context-term") {
			this.activeSection.set("context");
			this.selectedInitiativeId.set(null);
			this.selectedId.set(null);
			this.activePage.set("list");
			this.contextTab.set(target.scopeRef ? "initiatives" : "global");
			this.selectedContextInitiativeId.set(target.scopeRef ?? null);
			this.selectedNestedTarget.set(target.type === "context"
				? { id: null, scopeRef: target.scopeRef, type: target.type }
				: { id: target.term, scopeRef: target.scopeRef, type: target.type });
			this.writeRoute(this.currentRoute());
			await this.loadProjectContext();
		}

		return true;
	}

	protected globalSearchRecentsStorageKey(): string | null {
		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		return tenantId && projectId ? `${GLOBAL_SEARCH_RECENTS_STORAGE_PREFIX}:${tenantId}:${projectId}` : null;
	}

	protected readGlobalSearchRecents(): SearchNavigationTarget[] {
		const storageKey = this.globalSearchRecentsStorageKey();
		if (!storageKey) {
			return [];
		}

		try {
			const stored = window.localStorage.getItem(storageKey);
			if (!stored) {
				return [];
			}

			const targets = JSON.parse(stored) as unknown;
			return Array.isArray(targets) ? targets.filter(isSearchNavigationTarget).slice(0, GLOBAL_SEARCH_RECENTS_LIMIT) : [];
		} catch {
			return [];
		}
	}

	protected recordGlobalSearchRecent(target: SearchNavigationTarget) {
		const storageKey = this.globalSearchRecentsStorageKey();
		if (!storageKey) {
			return;
		}

		const recents = this.readGlobalSearchRecents();
		const targetKey = JSON.stringify(target);
		const nextRecents = [target, ...recents.filter((recent) => JSON.stringify(recent) !== targetKey)].slice(0, GLOBAL_SEARCH_RECENTS_LIMIT);
		window.localStorage.setItem(storageKey, JSON.stringify(nextRecents));
		this.globalSearchRecents.set(nextRecents);
	}

	public selectEntity(entityId: string, target: NestedRouteTarget | null = null) {
		if (!this.allowInstructionNavigation(() => this.selectEntity(entityId, target))) return;
		if (this.entityForId(entityId)?.kind === "initiative") {
			this.selectInitiative(entityId);
			return;
		}

		this.cascadePath.set([]);
		this.entityBackStack.set([]);
		this.selectedInitiativeId.set(null);
		this.selectedId.set(entityId);
		this.selectedNestedTarget.set(target);
		this.activePage.set("entity");
		this.writeRoute(this.currentRoute());
		void this.loadEntityDetail(entityId);
		if (this.entityForId(entityId)?.kind === "issue") {
			void this.loadIssueCommentPage(entityId);
		}
	}

	public selectEntityFromRecord(entityId: string) {
		const sourceId = this.selectedId.get();
		const backStack = this.entityBackStack.get();
		this.selectEntity(entityId);
		if (sourceId && sourceId !== entityId) {
			this.entityBackStack.set([...backStack, sourceId]);
		}
	}

	public selectProjectGraphEntity(entityId: string, kind: string) {
		this.activeSection.set(kind === "adr" ? "adrs" : "initiatives");
		this.selectEntity(entityId);
	}

	public selectInitiativeFromEvent = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.id;
		if (!initiativeId) {
			return;
		}

		this.selectInitiative(initiativeId);
	};

	public openCascade(rootId: string) {
		this.cascadeWindowStart.set(null);
		this.cascadePath.set([rootId]);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public toggleRail() {
		this.railCollapsed.set(!this.railCollapsed.get());
	}

	public toggleMaster() {
		this.masterCollapsedOverride.set(!this.masterCollapsed.get());
	}

	public isEpicExpanded(epicId: string): boolean {
		const projectId = this.selectedProjectId.get();
		return !projectId || !this.collapsedEpicIdsByProject.get().get(projectId)?.has(epicId);
	}

	public toggleEpicExpanded(epicId: string) {
		const projectId = this.selectedProjectId.get();
		if (!projectId) {
			return;
		}

		const collapsedEpicIdsByProject = new Map(this.collapsedEpicIdsByProject.get());
		const collapsedEpicIds = new Set(collapsedEpicIdsByProject.get(projectId));
		if (collapsedEpicIds.has(epicId)) {
			collapsedEpicIds.delete(epicId);
		} else {
			collapsedEpicIds.add(epicId);
		}

		collapsedEpicIdsByProject.set(projectId, collapsedEpicIds);
		this.collapsedEpicIdsByProject.set(collapsedEpicIdsByProject);
	}

	protected clearMasterOverrideIfShallow() {
		if (this.cascadePath.get().length < 2) {
			this.masterCollapsedOverride.set(null);
		}
	}

	public reRootCascade(targetId: string) {
		const currentPath = this.cascadePath.get();
		if (currentPath.length > 0) {
			this.reRootTrail.set([...this.reRootTrail.get(), currentPath]);
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set(this.cascadePathForLeaf(targetId));
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public restoreReRoot(index: number) {
		const trail = this.reRootTrail.get();
		const restored = trail[index];
		if (!restored) {
			return;
		}

		this.reRootTrail.set(trail.slice(0, index));
		this.cascadeWindowStart.set(null);
		this.cascadePath.set(restored);
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	public popReRoot() {
		const trail = this.reRootTrail.get();
		if (trail.length === 0) {
			return;
		}

		this.restoreReRoot(trail.length - 1);
	}

	public drillCascade(parentId: string, childId: string) {
		const parentIndex = this.cascadePath.get().indexOf(parentId);
		if (parentIndex === -1) {
			return;
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set([...this.cascadePath.get().slice(0, parentIndex + 1), childId]);
		this.writeCascadeHash();
	}

	public restoreAncestor(entityId: string) {
		const index = this.cascadePath.get().indexOf(entityId);
		if (index === -1) {
			return;
		}

		this.cascadeWindowStart.set(index);
	}

	public truncateCascadeTo(entityId: string) {
		const path = this.cascadePath.get();
		const index = path.indexOf(entityId);
		if (index === -1 || index === path.length - 1) {
			return;
		}

		this.cascadeWindowStart.set(null);
		this.cascadePath.set(path.slice(0, index + 1));
		this.clearMasterOverrideIfShallow();
		this.writeCascadeHash();
	}

	protected writeCascadeHash() {
		this.writeRoute(this.currentRoute());
	}

	public selectInitiative(initiativeId: string) {
		if (!this.allowInstructionNavigation(() => this.selectInitiative(initiativeId))) return;
		this.cancelInitiativeTabPrefetch();
		this.selectedId.set(null);
		this.entityBackStack.set([]);
		this.selectedInitiativeId.set(initiativeId);
		this.selectedNestedTarget.set(null);
		this.activePage.set("initiative");
		this.activeSection.set("initiatives");
		this.activeView.set("overview");
		this.initTab.set("overview");
		this.cascadePath.set([]);
		this.clearMasterOverrideIfShallow();
		this.writeRoute(this.currentRoute());
		if (this.isSummaryInitiative(initiativeId)) {
			void this.loadInitiativeRoute(initiativeId, "overview");
		}
	}

	public clearSelection() {
		this.cancelInitiativeTabPrefetch();
		this.cascadePath.set([]);
		this.clearMasterOverrideIfShallow();
		this.selectedInitiativeId.set(null);
		this.selectedId.set(null);
		this.entityBackStack.set([]);
		this.selectedNestedTarget.set(null);
		this.activePage.set("list");
		this.activeView.set("overview");
		this.writeRoute(this.currentRoute());
	}

	public async selectTenant(tenantId: string) {
		if (!tenantId || tenantId === this.selectedTenant.get()) {
			return;
		}
		if (!this.allowInstructionNavigation(() => { void this.selectTenant(tenantId); })) return;

		this.selectedTenant.set(tenantId);
		this.selectedProjectId.set(null);
		this.resetScopeDetail();
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("choose a project");
		await this.reloadProjectDiscovery();
	}

	public async returnToProjectChooser() {
		if (!this.selectedTenant.get()) {
			return;
		}
		if (!this.allowInstructionNavigation(() => { void this.returnToProjectChooser(); })) return;

		this.selectedProjectId.set(null);
		this.snapshot.set(null);
		this.projectSummary.set(null);
		this.resetScopeDetail();
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("choose a project");
		await this.reloadProjectDiscovery();
	}

	public async selectProject(projectId: string, options: { preserveGlobalSearch?: boolean } = {}) {
		const tenantId = this.selectedTenant.get();
		if (!tenantId || !projectId || projectId === this.selectedProjectId.get()) {
			return;
		}
		if (!this.allowInstructionNavigation(() => { void this.selectProject(projectId, options); })) return;

		const previousRoute = this.currentRoute();
		const previousProjectId = previousRoute.projectId;
		this.selectedProjectId.set(projectId);
		this.resetScopeDetail(options);
		this.writeRoute(this.currentRoute());
		this.stopLiveUpdates();
		this.syncLabel.set("connecting");

		try {
			await this.reloadProjectSummary();
			this.connectEvents();
		} catch (error) {
			if (options.preserveGlobalSearch && previousProjectId) {
				this.selectedProjectId.set(previousProjectId);
				this.writeRoute(this.currentRoute(), true);
				try {
					await this.reloadProjectSummary();
					this.applyRoute(previousRoute);
					this.writeRoute(previousRoute, true);
					this.connectEvents();
					this.errorMessage.set(error instanceof Error ? error.message : String(error));
					return;
				} catch {
					// Continue to the unavailable-project state when recovery also fails.
				}
			}
			this.selectedProjectId.set(null);
			this.snapshot.set(null);
			this.projectSummary.set(null);
			this.writeRoute(this.currentRoute(), true);
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("project unavailable");
		}
	}

	public initiativeStats(bundle: InitiativeBundle) {
		const rollup = this.projectSummaryInitiatives.get().find((candidate) => candidate.initiative.id === bundle.initiative.id);
		if (rollup) {
			const pct = rollup.issueCount > 0 ? Math.round((rollup.completedIssueCount / rollup.issueCount) * 100) : 0;
			return { adrs: rollup.adrCount ?? bundle.adrs.length, done: rollup.completedIssueCount, issues: rollup.issueCount, pct, stories: rollup.userStoryCount };
		}

		const total = bundle.issues.filter((issue) => issue.status !== "deferred").length;
		const done = bundle.issues.filter((issue) => this.isDoneStatus(issue.status)).length;
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		return { adrs: bundle.adrs.length, done, issues: total, pct, stories: bundle.userStories.length };
	}

	public issuesForStory(bundle: InitiativeBundle, storyId: string) {
		const issueIds = new Set(bundle.fixLinks.filter((link) => link.userStory.id === storyId).map((link) => link.issue.id));
		return this.sortEntities(bundle.issues.filter((issue) => issueIds.has(issue.id)));
	}

	public subIssuesForIssue(bundle: InitiativeBundle, issueId: string) {
		return this.sortEntities(bundle.subIssueLinks.filter((link) => link.parent.id === issueId).map((link) => link.issue));
	}

	public parentIssueForIssue(bundle: InitiativeBundle, issueId: string) {
		return bundle.subIssueLinks.find((link) => link.issue.id === issueId)?.parent ?? null;
	}

	public issueTreeForStory(bundle: InitiativeBundle, storyId: string): IssueTreeNode[] {
		const parentIssueIdByChildId = new Map(bundle.subIssueLinks.map((link) => [link.issue.id, link.parent.id]));
		const childIssueIdsByParentId = new Map<string, string[]>();

		for (const link of bundle.subIssueLinks) {
			const childIssueIds = childIssueIdsByParentId.get(link.parent.id) ?? [];
			childIssueIds.push(link.issue.id);
			childIssueIdsByParentId.set(link.parent.id, childIssueIds);
		}

		const relevantIds = new Set<string>();
		const fixingIssues = this.issuesForStory(bundle, storyId);

		for (const issue of fixingIssues) {
			const descendantQueue = [issue.id];

			while (descendantQueue.length > 0) {
				const currentIssueId = descendantQueue.shift();
				if (!currentIssueId || relevantIds.has(currentIssueId)) {
					continue;
				}

				relevantIds.add(currentIssueId);
				for (const childIssueId of childIssueIdsByParentId.get(currentIssueId) ?? []) {
					descendantQueue.push(childIssueId);
				}
			}

			let currentIssueId: string | null = issue.id;

			while (currentIssueId) {
				if (relevantIds.has(currentIssueId)) {
					currentIssueId = parentIssueIdByChildId.get(currentIssueId) ?? null;
					continue;
				}

				relevantIds.add(currentIssueId);
				currentIssueId = parentIssueIdByChildId.get(currentIssueId) ?? null;
			}
		}

		const rootIds = [...relevantIds].filter((issueId) => {
			const parentIssueId = parentIssueIdByChildId.get(issueId);
			return !parentIssueId || !relevantIds.has(parentIssueId);
		});

		return this.buildIssueTree(bundle, rootIds, relevantIds);
	}

	public issueTreeForDirectIssues(bundle: InitiativeBundle): IssueTreeNode[] {
		const storyIssueIds = new Set(
			bundle.userStories.flatMap((story) => this.issueTreeForStory(bundle, story.id).flatMap((node) => this.issueTreeNodeIds(node)))
		);
		const directIssueIds = new Set(bundle.issues.map((issue) => issue.id).filter((issueId) => !storyIssueIds.has(issueId)));
		const parentIssueIdByChildId = new Map(bundle.subIssueLinks.map((link) => [link.issue.id, link.parent.id]));
		const rootIds = [...directIssueIds].filter((issueId) => {
			const parentIssueId = parentIssueIdByChildId.get(issueId);
			return !parentIssueId || !directIssueIds.has(parentIssueId);
		});

		return this.buildIssueTree(bundle, rootIds, directIssueIds);
	}

	public subIssueTreeForIssue(bundle: InitiativeBundle, issueId: string): IssueTreeNode[] {
		const relevantIds = new Set<string>();
		const queue = this.subIssuesForIssue(bundle, issueId).map((issue) => issue.id);

		while (queue.length > 0) {
			const currentIssueId = queue.shift();
			if (!currentIssueId || relevantIds.has(currentIssueId)) {
				continue;
			}

			relevantIds.add(currentIssueId);
			for (const childIssue of this.subIssuesForIssue(bundle, currentIssueId)) {
				queue.push(childIssue.id);
			}
		}

		return this.buildIssueTree(
			bundle,
			this.subIssuesForIssue(bundle, issueId).map((issue) => issue.id),
			relevantIds
		);
	}

	public buildInitiativeGraph(bundle: InitiativeBundle, visibleKinds?: ReadonlySet<ProjectGraphKind>): RelationshipGraph {
		const initiative = bundle.initiative;
		const snapshot = this.snapshot.get();
		const relations = bundle.relations ?? snapshot?.relations ?? [];
		const graphEntities = bundle.relations ? bundle.entities : snapshot?.entities ?? [];
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const issueById = new Map(bundle.issues.map((issue) => [issue.id, issue]));
		const childIssuesByParentId = new Map<string, Entity[]>();
		const childIssueIds = new Set(bundle.subIssueLinks.map((link) => link.issue.id));
		const fixingStoryIdsByIssueId = new Map<string, string[]>();
		const plans = this.sortEntities(bundle.entities.filter((entity) => entity.kind === "plan"));

		nodes.push({ col: 0, fullLabel: initiative.title, id: initiative.id, key: initiative.id, kind: "initiative", label: initiative.title });

		for (const plan of plans) {
			nodes.push({ col: 1, fullLabel: plan.title, id: plan.id, key: plan.id, kind: "plan", label: plan.title, status: plan.status });
			edges.push({ from: initiative.id, to: plan.id });
		}

		for (const prd of bundle.prds) {
			nodes.push({ col: 1, fullLabel: prd.title, id: prd.id, key: prd.id, kind: "prd", label: prd.title });
			edges.push({ from: initiative.id, to: prd.id });
		}

		for (const adr of bundle.adrs) {
			nodes.push({ col: 1, fullLabel: adr.title, id: adr.id, key: adr.id, kind: "adr", label: adr.title });
			edges.push({ from: initiative.id, to: adr.id });
		}

		for (const story of bundle.userStories) {
			nodes.push({ col: 2, fullLabel: story.title, id: story.id, key: story.id, kind: "story", label: story.title });
			edges.push({ from: initiative.id, to: story.id });
		}

		for (const link of bundle.subIssueLinks) {
			const children = childIssuesByParentId.get(link.parent.id) ?? [];
			children.push(link.issue);
			childIssuesByParentId.set(link.parent.id, children);
		}

		for (const [parentId, children] of childIssuesByParentId) {
			childIssuesByParentId.set(parentId, this.sortEntities(children));
		}

		for (const link of bundle.fixLinks) {
			const storyIds = fixingStoryIdsByIssueId.get(link.issue.id) ?? [];
			storyIds.push(link.userStory.id);
			fixingStoryIdsByIssueId.set(link.issue.id, storyIds);
		}

		const rootIssues = this.sortEntities(bundle.issues.filter((issue) => !childIssueIds.has(issue.id)));
		let maxIssueDepth = 0;
		const seen = new Set<string>();

		const visitIssue = (issue: Entity, depth: number) => {
			if (seen.has(issue.id)) {
				maxIssueDepth = Math.max(maxIssueDepth, depth);
				return;
			}

			seen.add(issue.id);
			maxIssueDepth = Math.max(maxIssueDepth, depth);
			nodes.push({
				col: 3 + depth,
				fullLabel: issue.title,
				id: issue.id,
				key: issue.id,
				kind: "issue",
				label: issue.title,
				status: issue.status
			});

			const storyIds = fixingStoryIdsByIssueId.get(issue.id) ?? [];
			if (storyIds.length > 0) {
				for (const storyId of storyIds) {
					edges.push({ from: storyId, to: issue.id });
				}
			} else if (depth === 0) {
				edges.push({ from: initiative.id, to: issue.id });
			}

			for (const child of childIssuesByParentId.get(issue.id) ?? []) {
				visitIssue(child, depth + 1);
				edges.push({ from: issue.id, to: child.id });
			}
		};

		for (const issue of rootIssues) {
			visitIssue(issue, 0);
		}

		for (const issue of this.sortEntities(bundle.issues)) {
			if (!seen.has(issue.id)) {
				visitIssue(issue, 0);
			}
		}

		const issueColumns = ["Issues"];
		for (let depth = 1; depth <= maxIssueDepth; depth += 1) {
			issueColumns.push(depth === 1 ? "Sub-issues" : "Nested sub-issues");
		}
		const debtColumn = 3 + issueColumns.length;
		const ownedDebt = this.sortEntities(
			graphEntities.filter(
				(entity) =>
					entity.kind === "debt" &&
					relations.some(
						(relation) => relation.fromId === initiative.id && relation.toId === entity.id && relation.type === "records"
					)
			)
		);

		for (const debt of ownedDebt) {
			nodes.push({
				col: debtColumn,
				fullLabel: debt.title,
				id: debt.id,
				key: debt.id,
				kind: "debt",
				label: debt.title,
				status: debt.status
			});
			edges.push({ from: initiative.id, label: "records", to: debt.id });
		}

		const visibleNodeIds = new Set(nodes.map((node) => node.id));
		const debtIds = new Set(ownedDebt.map((debt) => debt.id));
		const planIds = new Set(plans.map((plan) => plan.id));
		for (const relation of relations) {
			if (relation.type === "informs" && planIds.has(relation.fromId) && visibleNodeIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "informs", to: relation.toId });
			}

			if (relation.type === "resolves" && visibleNodeIds.has(relation.fromId) && debtIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "resolves", to: relation.toId });
			}

			if (relation.type === "relatesTo" && debtIds.has(relation.fromId) && visibleNodeIds.has(relation.toId)) {
				edges.push({ from: relation.fromId, label: "relatesTo", to: relation.toId });
			}
		}

		const graph = { columns: ["Initiative", "Plans, PRDs & ADRs", "User stories", ...issueColumns, "Debt records"], edges, nodes };
		return visibleKinds ? filterGraphByKind(graph, visibleKinds) : graph;
	}

	public buildProjectGraph(): RelationshipGraph {
		const cachedGraph = this.projectGraphCache.get().data;
		if (cachedGraph) {
			return this.buildScopedProjectGraph(cachedGraph);
		}

		const snapshot = this.snapshot.get();
		const epicGroups = this.epicInitiativeGroups.get();
		const projectKey = "__project";
		const nodeKeyByEntityId = new Map<string, string>();
		const selectedProjectId = this.selectedProjectId.get();
		const nodes: GraphNode[] = [
			{
				col: 0,
				fullLabel: this.projectDescription.get(),
				id: "",
				key: projectKey,
				kind: "project",
				label: this.selectedTenantDisplayName.get() ?? ""
			}
		];
		const edges: GraphEdge[] = [];
		if (selectedProjectId) {
			nodeKeyByEntityId.set(selectedProjectId, projectKey);
		}

		for (const adr of snapshot?.projectAdrs ?? []) {
			nodes.push({ col: 1, fullLabel: adr.title, id: adr.id, key: adr.id, kind: "adr", label: adr.title, status: adr.status });
			nodeKeyByEntityId.set(adr.id, adr.id);
			edges.push({ from: projectKey, to: adr.id });
		}

		for (const group of epicGroups) {
			const { epic } = group;
			nodes.push({
				col: 1,
				fullLabel: epic.title,
				id: epic.id,
				key: epic.id,
				kind: "epic",
				label: epic.title,
				status: epic.status
			});
			nodeKeyByEntityId.set(epic.id, epic.id);
			edges.push({ from: projectKey, to: epic.id });

			for (const bundle of group.initiatives) {
				const initiative = bundle.initiative;
				const storyKeyById = new Map<string, string>();
				const fixingStoryIdsByIssueId = new Map<string, string[]>();
				nodes.push({
					col: 2,
					fullLabel: `${initiative.title} — ${bundle.userStories.length} stories, ${bundle.issues.length} issues`,
					id: initiative.id,
					key: initiative.id,
					kind: "initiative",
					label: initiative.title,
					status: initiative.status
				});
				nodeKeyByEntityId.set(initiative.id, initiative.id);
				edges.push({ from: epic.id, to: initiative.id });

				const records: { entity: Entity; kind: string }[] = [
					...this.sortEntities(bundle.entities.filter((entity) => entity.kind === "plan")).map((plan) => ({ entity: plan, kind: "plan" })),
					...bundle.prds.map((prd) => ({ entity: prd, kind: "prd" })),
					...bundle.adrs.map((adr) => ({ entity: adr, kind: "adr" }))
				];
				for (const { entity, kind } of records) {
					const key = `${initiative.id}:${entity.id}`;
					nodes.push({ col: 3, fullLabel: entity.title, id: entity.id, key, kind, label: entity.title, status: entity.status });
					nodeKeyByEntityId.set(entity.id, key);
					edges.push({ from: initiative.id, to: key });
				}

				for (const story of this.sortEntities(bundle.userStories)) {
					const key = `${initiative.id}:${story.id}`;
					storyKeyById.set(story.id, key);
					nodeKeyByEntityId.set(story.id, key);
					nodes.push({ col: 4, fullLabel: story.title, id: story.id, key, kind: "story", label: story.title, status: story.status });
					edges.push({ from: initiative.id, to: key });
				}

				for (const link of bundle.fixLinks) {
					const storyIds = fixingStoryIdsByIssueId.get(link.issue.id) ?? [];
					storyIds.push(link.userStory.id);
					fixingStoryIdsByIssueId.set(link.issue.id, storyIds);
				}

				for (const issue of this.sortEntities(bundle.issues)) {
					const key = `${initiative.id}:${issue.id}`;
					nodeKeyByEntityId.set(issue.id, key);
					nodes.push({ col: 5, fullLabel: issue.title, id: issue.id, key, kind: "issue", label: issue.title, status: issue.status });
					const storyKeys = (fixingStoryIdsByIssueId.get(issue.id) ?? [])
						.map((storyId) => storyKeyById.get(storyId))
						.filter((storyKey): storyKey is string => Boolean(storyKey));
					if (storyKeys.length > 0) {
						for (const storyKey of storyKeys) {
							edges.push({ from: storyKey, to: key });
						}
					} else {
						edges.push({ from: initiative.id, to: key });
					}
				}
			}
		}

		const debtKeyById = new Map<string, string>();
		const debtRecords = this.sortEntities((snapshot?.entities ?? []).filter((entity) => entity.kind === "debt"));
		for (const debt of debtRecords) {
			const owner = (snapshot?.relations ?? []).find(
				(relation) => relation.fromId !== debt.id && relation.toId === debt.id && relation.type === "records"
			);
			const ownerKey = owner ? nodeKeyByEntityId.get(owner.fromId) : undefined;
			if (!ownerKey) {
				continue;
			}

			debtKeyById.set(debt.id, debt.id);
			nodes.push({ col: 6, fullLabel: debt.title, id: debt.id, key: debt.id, kind: "debt", label: debt.title, status: debt.status });
			edges.push({ from: ownerKey, label: "records", to: debt.id });
		}

		for (const relation of snapshot?.relations ?? []) {
			if (relation.type === "informs") {
				const sourceKey = nodeKeyByEntityId.get(relation.fromId);
				const targetKey = nodeKeyByEntityId.get(relation.toId);
				if (sourceKey && targetKey) {
					edges.push({ from: sourceKey, label: "informs", to: targetKey });
				}
			}

			if (relation.type === "resolves") {
				const resolverKey = nodeKeyByEntityId.get(relation.fromId);
				const debtKey = debtKeyById.get(relation.toId);
				if (resolverKey && debtKey) {
					edges.push({ from: resolverKey, label: "resolves", to: debtKey });
				}
			}

			if (relation.type === "relatesTo") {
				const debtKey = debtKeyById.get(relation.fromId);
				const relatedKey = nodeKeyByEntityId.get(relation.toId) ?? debtKeyById.get(relation.toId);
				if (debtKey && relatedKey) {
					edges.push({ from: debtKey, label: "relatesTo", to: relatedKey });
				}
			}
		}

		return filterGraphByKind(
			{ columns: ["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"], edges, nodes },
			this.visibleProjectGraphKinds.get()
		);
	}

	protected buildScopedProjectGraph(data: ProjectRecordData): RelationshipGraph {
		const records = this.sortEntities(data.records);
		const kinds = [...new Set(records
			.map((record) => record.kind === "userStory" ? "story" : record.kind)
			.filter((kind): kind is ProjectGraphKind => PROJECT_GRAPH_KINDS.includes(kind as ProjectGraphKind)))];
		const columnByKind = new Map(kinds.map((kind, index) => [kind, index]));
		const recordIds = new Set(records.map((record) => record.id));
		const nodes = records.flatMap((record): GraphNode[] => {
			const kind = record.kind === "userStory" ? "story" : record.kind;
			const column = columnByKind.get(kind as ProjectGraphKind);
			return column === undefined ? [] : [{
				col: column,
				fullLabel: record.title,
				id: record.id,
				key: record.id,
				kind,
				label: record.title,
				status: record.status
			}];
		});
		const edges = data.relations
			.filter((relation) => recordIds.has(relation.fromId) && recordIds.has(relation.toId))
			.map((relation) => ({ from: relation.fromId, label: relation.type, to: relation.toId }));
		return { columns: kinds.map((kind) => kind === "story" ? "User stories" : `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}s`), edges, nodes };
	}

	public toggleProjectGraphKind(kind: ProjectGraphKind) {
		const visibleKinds = new Set(this.visibleProjectGraphKinds.get());
		if (visibleKinds.has(kind)) {
			visibleKinds.delete(kind);
		} else {
			visibleKinds.add(kind);
		}
		this.visibleProjectGraphKinds.set(visibleKinds);
	}

	public isDoneStatus(status: string) {
		return status === "done" || status === "complete" || status === "closed";
	}

	public sortIssuesByExpectedCompletion(records: Entity[], bundle: InitiativeBundle): Entity[] {
		const recordsById = new Map(records.map((record) => [record.id, record]));
		const positionById = new Map(records.map((record, index) => [record.id, index]));
		const blockersRemainingById = new Map(records.map((record) => [record.id, 0]));
		const unblockedIssueIdsById = new Map(records.map((record) => [record.id, [] as string[]]));
		const linkedIssueIds = new Set<string>();
		const compare = (left: Entity, right: Entity) => {
			const completionDifference = Number(!this.isDoneStatus(left.status)) - Number(!this.isDoneStatus(right.status));
			return completionDifference || positionById.get(left.id)! - positionById.get(right.id)!;
		};

		for (const link of bundle.blockerLinks) {
			if (!recordsById.has(link.source.id) || !recordsById.has(link.target.id)) continue;
			if (!this.isDoneStatus(link.source.status) && this.isDoneStatus(link.target.status)) continue;

			const linkId = `${link.source.id}:${link.target.id}`;
			if (linkedIssueIds.has(linkId)) continue;
			linkedIssueIds.add(linkId);
			blockersRemainingById.set(link.target.id, blockersRemainingById.get(link.target.id)! + 1);
			unblockedIssueIdsById.get(link.source.id)!.push(link.target.id);
		}

		const readyIssues = records.filter((record) => blockersRemainingById.get(record.id) === 0);
		const orderedIssues: Entity[] = [];
		const emittedIssueIds = new Set<string>();

		while (readyIssues.length > 0) {
			readyIssues.sort(compare);
			const issue = readyIssues.shift()!;
			if (emittedIssueIds.has(issue.id)) continue;

			emittedIssueIds.add(issue.id);
			orderedIssues.push(issue);
			for (const unblockedIssueId of unblockedIssueIdsById.get(issue.id) ?? []) {
				const blockersRemaining = blockersRemainingById.get(unblockedIssueId)! - 1;
				blockersRemainingById.set(unblockedIssueId, blockersRemaining);
				if (blockersRemaining === 0) readyIssues.push(recordsById.get(unblockedIssueId)!);
			}
		}

		return [...orderedIssues, ...records.filter((record) => !emittedIssueIds.has(record.id)).sort(compare)];
	}

	public issueStatusTone(status: string) {
		if (this.isDoneStatus(status)) {
			return "done";
		}

		if (status === "blocked" || status === "paused") {
			return "blocked";
		}

		return "open";
	}

	public formatKindLabel(kind: string) {
		if (kind === "all") {
			return "All work items";
		}

		if (kind === "userStory") {
			return "User story";
		}

		if (kind === "prd") {
			return "PRD";
		}

		if (kind === "adr") {
			return "ADR";
		}

		return kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : "Unknown";
	}

	public statusTone(status: string) {
		if (status === "blocked" || status === "paused") {
			return "warn";
		}

		if (status === "cancelled") {
			return "danger";
		}

		if (status === "archived" || status === "deferred" || status === "done" || status === "complete" || status === "closed") {
			return "neutral";
		}

		return "success";
	}

	public badgeTone(status: string) {
		if (status === "done" || status === "complete" || status === "closed") {
			return "done";
		}

		if (status === "blocked" || status === "cancelled") {
			return "danger";
		}

		if (status === "ready" || status === "in-progress") {
			return "info";
		}

		if (status === "paused") {
			return "warn";
		}

		if (status === "active" || status === "current" || status === "approved") {
			return "success";
		}

		return "neutral";
	}

	public compactPath(value: string) {
		const segments = value.split("/").filter(Boolean);
		if (segments.length <= 3) {
			return value;
		}

		return `.../${segments.slice(-3).join("/")}`;
	}

	public formatTimestamp(value: string) {
		const timestamp = new Date(value);
		return Number.isNaN(timestamp.getTime())
			? value
			: new Intl.DateTimeFormat(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit"
				}).format(timestamp);
	}

	public truncate(value: string, maxLength: number) {
		return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
	}

	public shortRef(entity: { id: string; kind: string; shortReference?: string }) {
		return shortEntityReference(entity);
	}

	public buildOpenedText(entity: Entity) {
		const bundle = this.selectedBundle.get();
		const bundleText = bundle ? `inside ${bundle.initiative.id}` : "outside a visible initiative bundle";
		return `Opened ${this.formatTimestamp(entity.createdAt)} and currently ${bundleText}. Last updated ${this.formatTimestamp(entity.updatedAt)}.`;
	}

	public buildSummaryBody(entity: Entity) {
		const bundle = this.selectedBundle.get();
		const context = this.selectedContext.get();
		const selectedIncoming = this.selectedIncoming.get();
		const selectedOutgoing = this.selectedOutgoing.get();
		const orphanIds = this.orphanIds.get();

		const bundleSentence = bundle
			? `It currently sits in ${bundle.initiative.id}, which includes ${bundle.prds.length} PRDs, ${bundle.userStories.length} stories, ${bundle.adrs.length} ADRs, and ${bundle.issues.length} issues.`
			: "It is not currently connected to a visible initiative bundle in this snapshot.";

		const orphanSentence = orphanIds.has(entity.id)
			? "This record is marked as orphaned from the initiative structure."
			: "This record remains connected to the main initiative structure.";

		const contextSentence = context
			? `${context.context.title} is currently ${context.context.exists ? "stored" : "using its default shell"} with ${context.terms.length} defined terms.`
			: "No context is currently available for this record.";

		return `${entity.id} is a ${this.formatKindLabel(entity.kind).toLowerCase()} with ${selectedIncoming.length} incoming links and ${selectedOutgoing.length} outgoing links. ${bundleSentence} ${contextSentence} ${orphanSentence}`;
	}

	public buildRelationSentence(relation: Relation) {
		return `${relation.fromId} ${relation.type} ${relation.toId}`;
	}

	public relationLabel(type: string, incoming: boolean) {
		const incomingLabels: Record<string, string> = {
			blocks: "Blocked by",
			constrains: "Constrained by",
			decomposes: "Parent issue",
			creates: "Created by",
			fixes: "Fixed by",
			handsOff: "Incoming handoffs",
			owns: "Owned by",
			records: "Recorded by",
			resolves: "Resolved by",
			tracks: "Tracked by"
		};
		const outgoingLabels: Record<string, string> = {
			blocks: "Blocks",
			constrains: "Constrains",
			decomposes: "Sub-issues",
			creates: "Creates",
			fixes: "Fixes",
			relatesTo: "Related records",
			resolves: "Resolves debt",
			owns: "Owns",
			records: "Records",
			tracks: "Tracks"
		};

		if (incoming) {
			return incomingLabels[type] ?? `${type} (incoming)`;
		}

		return outgoingLabels[type] ?? type;
	}

	public detailMeta(entity: Entity): Array<[string, string]> {
		return this.detailMetaFor(entity.id);
	}

	public detailMetaFor(entityId: string | null): Array<[string, string]> {
		const entity = entityId ? this.entityById.get().get(entityId) ?? null : null;
		const bundle = this.bundleForEntityId(entityId);
		const owner = entity
			? this.incomingRelationsFor(entity.id)
				.find((relation) => relation.type === "records")
				?.fromId
			: null;
		const ownerEntity = owner ? this.entityById.get().get(owner) ?? null : null;
		const debtMeta: Array<[string, string]> = entity?.kind === "debt"
			? [
				["Category", entity.category ?? "—"],
				["Priority", entity.priority ?? "—"],
				["Lifecycle", entity.status],
				["Owner", ownerEntity ? `${this.shortRef(ownerEntity)} ${ownerEntity.title}` : "—"]
			]
			: [];
		const statusMeta: Array<[string, string]> = entity?.kind === "debt" ? [] : [["Status", entity?.status ?? "—"]];
		const typeMeta: Array<[string, string]> = entity?.type ? [["Type", entity.type]] : [];
		return [
			["Initiative", bundle ? `${this.shortRef(bundle.initiative)} ${bundle.initiative.title}` : "—"],
			...debtMeta,
			...statusMeta,
			...typeMeta,
			["Created", entity ? this.formatTimestamp(entity.createdAt) : "—"],
			["Updated", entity ? this.formatTimestamp(entity.updatedAt) : "—"]
		];
	}

	public linkedRecordSections(options?: { excludeRelationTypes?: string[]; excludeRelatedIds?: string[] }): Array<{ key: string; records: Entity[]; title: string }> {
		return this.linkedRecordSectionsFor(this.selectedId.get(), options);
	}

	public linkedRecordSectionsFor(
		entityId: string | null,
		options?: { excludeRelationTypes?: string[]; excludeRelatedIds?: string[] }
	): Array<{ key: string; records: Entity[]; title: string; crossLink: boolean }> {
		const spineRelationTypes = new Set(["owns", "creates", "fixes", "decomposes", "tracks", "constrains"]);
		const grouped = new Map<string, { records: Entity[]; crossLink: boolean }>();
		const excludedRelationTypes = new Set(options?.excludeRelationTypes ?? []);
		const excludedRelatedIds = new Set(options?.excludeRelatedIds ?? []);
		const add = (relatedId: string, label: string, relationType: string) => {
			if (excludedRelatedIds.has(relatedId)) {
				return;
			}

			const entity = this.entityById.get().get(relatedId);
			if (!entity) {
				return;
			}

			const group = grouped.get(label) ?? { crossLink: !spineRelationTypes.has(relationType), records: [] };
			group.records.push(entity);
			grouped.set(label, group);
		};

		for (const relation of this.outgoingRelationsFor(entityId)) {
			if (excludedRelationTypes.has(relation.type)) {
				continue;
			}

			add(relation.toId, this.relationLabel(relation.type, false), relation.type);
		}
		for (const relation of this.incomingRelationsFor(entityId)) {
			if (excludedRelationTypes.has(relation.type)) {
				continue;
			}

			add(relation.fromId, this.relationLabel(relation.type, true), relation.type);
		}

		return [...grouped.entries()].map(([title, group]) => ({
			crossLink: group.crossLink,
			key: title,
			records: this.sortEntities(group.records),
			title
		}));
	}

	public debtRecordSectionsFor(entityId: string | null): Array<{ key: string; records: Entity[]; title: string }> {
		const entity = entityId ? this.entityById.get().get(entityId) ?? null : null;
		if (!entity || !["project", "epic", "initiative", "issue"].includes(entity.kind)) {
			return [];
		}

		const ownedDebt = this.outgoingRelationsFor(entity.id)
			.filter((relation) => relation.type === "records")
			.map((relation) => this.entityById.get().get(relation.toId))
			.filter((record): record is Entity => record?.kind === "debt");
		const resolvedDebt = ["epic", "initiative", "issue"].includes(entity.kind)
			? this.outgoingRelationsFor(entity.id)
				.filter((relation) => relation.type === "resolves")
				.map((relation) => this.entityById.get().get(relation.toId))
				.filter((record): record is Entity => record?.kind === "debt")
			: [];

		return [
			...(ownedDebt.length > 0 ? [{ key: "owned-debt", records: this.sortEntities(ownedDebt), title: "Owned debt" }] : []),
			...(resolvedDebt.length > 0 ? [{ key: "resolved-debt", records: this.sortEntities(resolvedDebt), title: "Resolves debt" }] : [])
		];
	}

	public planProjectionFor(planId: string): { current: Array<{ key: PlanCurrentGroupKey; title: string; entries: PlanEntry[] }>; history: PlanEntry[] } {
		const history = [...this.planEntriesFor(planId)]
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.reference.localeCompare(right.reference));
		const supersededEntryIds = new Set(history.flatMap((entry) => entry.supersededEntryIds));
		const activeEntries = history.filter((entry) => !entry.tombstone && !supersededEntryIds.has(entry.id));

		return {
			current: PLAN_CURRENT_GROUPS.map((group) => ({
				key: group.key,
				title: group.title,
				entries: activeEntries.filter((entry) => belongsToPlanCurrentGroup(entry, group.key))
			})),
			history
		};
	}

	public closeEntity() {
		const backStack = this.entityBackStack.get();
		const sourceId = backStack.at(-1);
		if (sourceId) {
			this.entityBackStack.set(backStack.slice(0, -1));
			this.selectedId.set(sourceId);
			this.selectedNestedTarget.set(null);
			this.activePage.set("entity");
			this.writeRoute(this.currentRoute());
			void this.loadEntityDetail(sourceId);
			if (this.entityForId(sourceId)?.kind === "issue") {
				void this.loadIssueCommentPage(sourceId);
			}
			return;
		}

		const bundle = this.selectedBundle.get();
		this.selectedId.set(null);
		this.selectedNestedTarget.set(null);

		if (this.activeSection.get() !== "adrs" && bundle) {
			this.selectedInitiativeId.set(bundle.initiative.id);
			this.activePage.set("initiative");
			this.writeRoute(this.currentRoute());
			return;
		}

		this.activePage.set("list");
		this.writeRoute(this.currentRoute());
	}

	public getContextForInitiative(initiativeId: string): ContextDetails | null {
		return this.initiativeTabForId(initiativeId, "context")?.context ?? this.initiativeContextById.get().get(initiativeId) ?? null;
	}

	protected async bootstrap() {
		try {
			const config = await this.fetchJson<SiteConfig>("site-config.json");
			this.config.set(config);
			const route = this.readRoute();
			const initialRoute = { ...route, tenantId: route.tenantId ?? config.currentTenant };
			this.selectedTenant.set(initialRoute.tenantId);
			await this.reloadProjectDiscovery();
			await this.navigateToRoute(initialRoute);
			this.writeRoute(this.currentRoute(), true);
		} catch (error) {
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("load failed");
		}
	}

	protected async reloadProjectSummary() {
		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		const result = await this.fetchJson<ProjectSummary>(this.buildTenantScopedPath("/api/project-summary"));
		if (this.selectedTenant.get() !== tenantId || this.selectedProjectId.get() !== projectId) {
			return;
		}
		if (result.kind === "unavailable") {
			throw new Error("Selected project is unavailable.");
		}

		this.projectSummary.set(result);
		this.snapshot.set(null);
		this.errorMessage.set(null);
		this.syncLabel.set("listening");
	}

	protected refreshProjectSummaryInBackground() {
		void this.reloadProjectSummary().catch((error) => {
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("refresh failed");
		});
	}

	protected async loadInitiativeDetail(initiativeId: string, force = false) {
		const cached = this.initiativeDetails.get().get(initiativeId);
		if (cached?.loading || (!force && cached?.detail && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.setInitiativeDetailCache(initiativeId, { detail: cached?.detail ?? null, error: null, loading: true, stale: cached?.stale });
		try {
			const detail = await this.fetchJson<InitiativeDetailResponse>(this.buildTenantScopedPath(`/api/initiative-detail?initiative=${encodeURIComponent(initiativeId)}`));
			if (this.selectedTenant.get() !== tenantId || this.selectedProjectId.get() !== projectId) {
				return;
			}
			if (!("initiative" in detail)) {
				if (this.selectedInitiativeId.get() === initiativeId) {
					this.clearSelection();
				}
				return;
			}

			this.setInitiativeDetailCache(initiativeId, { detail, error: null, loading: false });
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.initiativeDetails.get().get(initiativeId);
				this.setInitiativeDetailCache(initiativeId, {
					detail: current?.detail ?? cached?.detail ?? null,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current?.stale ?? cached?.stale
				});
			}
		}
	}

	protected async loadInitiativeRoute(initiativeId: string, tab: InitiativeTab) {
		await this.loadInitiativeDetail(initiativeId);
		if (this.selectedInitiativeId.get() !== initiativeId || !this.initiativeDetailForId(initiativeId)) {
			return;
		}
		if (tab !== "overview" && this.initTab.get() === tab) {
			await this.loadInitiativeTab(initiativeId, tab);
		}
		if (this.selectedInitiativeId.get() === initiativeId) {
			this.startInitiativeTabPrefetch(initiativeId);
		}
	}

	public async retryProjectAdrs() {
		await this.loadProjectAdrs(true);
	}

	protected async loadProjectAdrs(force = false) {
		const cached = this.projectAdrsCache.get();
		if (cached.loading || (!force && cached.data && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.projectAdrsCache.set({ data: cached.data, error: null, loading: true, stale: cached.stale });
		try {
			const data = await this.fetchJson<ProjectAdrSectionData>(this.buildTenantScopedPath("/api/project-adrs"));
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				this.projectAdrsCache.set({ data, error: null, loading: false });
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.projectAdrsCache.get();
				this.projectAdrsCache.set({
					data: current.data,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current.stale ?? cached.stale
				});
			}
		}
	}

	public async retryProjectDebt() {
		await this.loadProjectDebt(true);
	}

	protected async loadProjectDebt(force = false) {
		await this.loadProjectRecordData("/api/project-debt", this.projectDebtCache, force);
	}

	public async retryProjectContext() {
		await this.loadProjectContext(true);
	}

	protected async loadProjectContext(force = false) {
		const cached = this.projectContextCache.get();
		if (cached.loading || (!force && cached.data && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.projectContextCache.set({ data: cached.data, error: null, loading: true, stale: cached.stale });
		try {
			const data = await this.fetchJson<ProjectContextSectionData>(this.buildTenantScopedPath("/api/project-context"));
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				this.projectContextCache.set({ data, error: null, loading: false });
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.projectContextCache.get();
				this.projectContextCache.set({
					data: current.data,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current.stale ?? cached.stale
				});
			}
		}
	}

	public async retryProjectGraph() {
		await this.loadProjectGraph(true);
	}

	protected async loadProjectGraph(force = false) {
		await this.loadProjectRecordData("/api/project-graph", this.projectGraphCache, force);
	}

	protected async loadProjectRecordData(
		path: string,
		cache: { get(): CachedProjectRecordData; set(value: CachedProjectRecordData): void },
		force: boolean
	) {
		const cached = cache.get();
		if (cached.loading || (!force && cached.data && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		cache.set({ data: cached.data, error: null, loading: true, stale: cached.stale });
		try {
			const data = await this.fetchJson<ProjectRecordData>(this.buildTenantScopedPath(path));
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				cache.set({ data, error: null, loading: false });
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = cache.get();
				cache.set({
					data: current.data,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current.stale ?? cached.stale
				});
			}
		}
	}

	protected async loadPlanEntryPage(planId: string, force = false, before?: string) {
		const cached = this.planEntryPages.get().get(planId);
		if (cached?.loading || (!force && cached?.data && !cached.stale && !before)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.setPlanEntryPageCache(planId, { data: cached?.data ?? null, error: null, loading: true, stale: cached?.stale });
		try {
			const page = await this.fetchJson<PlanEntryPage>(this.buildTenantScopedPath(`/api/plan-entries?plan=${encodeURIComponent(planId)}${before ? `&before=${encodeURIComponent(before)}` : ""}`));
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const entries = before
					? [...new Map([...(cached?.data?.entries ?? []), ...page.entries].map((entry) => [entry.id, entry])).values()]
					: page.entries;
				this.setPlanEntryPageCache(planId, { data: { ...page, entries }, error: null, loading: false });
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.planEntryPages.get().get(planId);
				this.setPlanEntryPageCache(planId, {
					data: current?.data ?? cached?.data ?? null,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current?.stale ?? cached?.stale
				});
			}
		}
	}

	protected setPlanEntryPageCache(planId: string, entry: CachedPlanEntryPage) {
		const pages = new Map(this.planEntryPages.get());
		pages.set(planId, entry);
		this.planEntryPages.set(pages);
	}

	protected async loadIssueCommentPage(issueId: string, force = false, before?: string) {
		const cached = this.issueCommentPages.get().get(issueId);
		if (cached?.loading || (!force && cached?.data && !cached.stale && !before)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.setIssueCommentPageCache(issueId, { data: cached?.data ?? null, error: null, loading: true, stale: cached?.stale });
		try {
			const page = await this.fetchJson<IssueCommentPage>(this.buildTenantScopedPath(`/api/issue-comments?issue=${encodeURIComponent(issueId)}${before ? `&before=${encodeURIComponent(before)}` : ""}`));
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const comments = before
					? [...new Map([...(cached?.data?.comments ?? []), ...page.comments].map((comment) => [comment.id, comment])).values()]
					: page.comments;
				const users = before
					? [...new Map([...(cached?.data?.users ?? []), ...page.users].map((user) => [user.id, user])).values()]
					: page.users;
				this.setIssueCommentPageCache(issueId, { data: { ...page, comments, users }, error: null, loading: false });
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.issueCommentPages.get().get(issueId);
				this.setIssueCommentPageCache(issueId, {
					data: current?.data ?? cached?.data ?? null,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current?.stale ?? cached?.stale
				});
			}
		}
	}

	protected setIssueCommentPageCache(issueId: string, entry: CachedIssueCommentPage) {
		const pages = new Map(this.issueCommentPages.get());
		pages.set(issueId, entry);
		this.issueCommentPages.set(pages);
	}

	public entityDetailForId(entityId: string | null): EntityDetails | null {
		return entityId ? this.entityDetails.get().get(entityId)?.detail ?? null : null;
	}

	public async retryEntityDetail(entityId: string) {
		await this.loadEntityDetail(entityId, true);
	}

	protected async loadEntityDetail(entityId: string, force = false) {
		const cached = this.entityDetails.get().get(entityId);
		if (cached?.loading || (!force && cached?.detail && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.setEntityDetailCache(entityId, { detail: cached?.detail ?? null, error: null, loading: true, stale: cached?.stale });
		try {
			const detail = await this.fetchJson<EntityDetailResponse>(this.buildTenantScopedPath(`/api/entity-detail?entity=${encodeURIComponent(entityId)}`));
			if (this.selectedTenant.get() !== tenantId || this.selectedProjectId.get() !== projectId) {
				return;
			}
			if (!("entity" in detail)) {
				if (this.selectedId.get() === entityId) {
					this.clearSelection();
				}
				return;
			}

			this.setEntityDetailCache(entityId, { detail, error: null, loading: false });
			if (detail.entity.kind === "issue") {
				void this.loadIssueCommentPage(entityId);
			}
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.entityDetails.get().get(entityId);
				this.setEntityDetailCache(entityId, {
					detail: current?.detail ?? cached?.detail ?? null,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current?.stale ?? cached?.stale
				});
			}
		}
	}

	protected setEntityDetailCache(entityId: string, entry: CachedEntityDetail) {
		const details = new Map(this.entityDetails.get());
		details.set(entityId, entry);
		this.entityDetails.set(details);
	}

	protected setInitiativeDetailCache(initiativeId: string, entry: CachedInitiativeDetail) {
		const details = new Map(this.initiativeDetails.get());
		details.set(initiativeId, entry);
		this.initiativeDetails.set(details);
	}

	protected async loadInitiativeTab(initiativeId: string, tab: Exclude<InitiativeTab, "overview">, force = false) {
		const cacheKey = this.initiativeTabCacheKey(initiativeId, tab);
		const cached = this.initiativeTabs.get().get(cacheKey);
		if (cached?.loading || (!force && cached?.data && !cached.stale)) {
			return;
		}

		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		this.setInitiativeTabCache(cacheKey, { data: cached?.data ?? null, error: null, loading: true, stale: cached?.stale });
		try {
			const data = await this.fetchJson<InitiativeTabData>(this.buildTenantScopedPath(`/api/initiative-tab?initiative=${encodeURIComponent(initiativeId)}&tab=${tab}`));
			if (this.selectedTenant.get() !== tenantId || this.selectedProjectId.get() !== projectId) {
				return;
			}

			this.setInitiativeTabCache(cacheKey, { data, error: null, loading: false });
		} catch (error) {
			if (this.selectedTenant.get() === tenantId && this.selectedProjectId.get() === projectId) {
				const current = this.initiativeTabs.get().get(cacheKey);
				this.setInitiativeTabCache(cacheKey, {
					data: current?.data ?? cached?.data ?? null,
					error: error instanceof Error ? error.message : String(error),
					loading: false,
					stale: current?.stale ?? cached?.stale
				});
			}
		}
	}

	protected startInitiativeTabPrefetch(initiativeId: string) {
		this.cancelInitiativeTabPrefetch();
		if (!this.connected) {
			return;
		}
		const generation = this.initiativeTabPrefetchGeneration;
		const tabs = [...DEFERRED_INITIATIVE_TABS];

		const scheduleNext = () => {
			if (generation !== this.initiativeTabPrefetchGeneration || this.selectedInitiativeId.get() !== initiativeId || tabs.length === 0) {
				return;
			}
			this.initiativeTabPrefetchTimer = window.setTimeout(() => {
				this.initiativeTabPrefetchTimer = null;
				void prefetchNext();
			}, INITIATIVE_TAB_PREFETCH_DELAY_MS);
		};

		const prefetchNext = async () => {
			if (generation !== this.initiativeTabPrefetchGeneration || this.selectedInitiativeId.get() !== initiativeId) {
				return;
			}
			const tab = tabs[0];
			if (!tab) {
				return;
			}
			const cached = this.initiativeTabs.get().get(this.initiativeTabCacheKey(initiativeId, tab));
			if (cached?.loading) {
				scheduleNext();
				return;
			}
			tabs.shift();
			if (!cached?.data || cached.stale) {
				await this.loadInitiativeTab(initiativeId, tab);
			}
			scheduleNext();
		};

		scheduleNext();
	}

	protected cancelInitiativeTabPrefetch() {
		this.initiativeTabPrefetchGeneration += 1;
		if (this.initiativeTabPrefetchTimer !== null) {
			window.clearTimeout(this.initiativeTabPrefetchTimer);
			this.initiativeTabPrefetchTimer = null;
		}
	}

	protected initiativeTabCacheKey(initiativeId: string, tab: InitiativeTab) {
		return `${initiativeId}:${tab}`;
	}

	protected setInitiativeTabCache(cacheKey: string, entry: CachedInitiativeTab) {
		const tabs = new Map(this.initiativeTabs.get());
		tabs.set(cacheKey, entry);
		this.initiativeTabs.set(tabs);
	}

	protected async reloadProjectDiscovery() {
		try {
			this.projectDiscovery.set(await this.fetchJson<ProjectDiscovery>(this.buildTenantScopedPath("/api/projects")));
			this.errorMessage.set(null);
		} catch (error) {
			this.projectDiscovery.set({ kind: "unavailable" });
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
		}
	}

	protected async navigateToRoute(route: ViewerRoute) {
		const generation = ++this.browserNavigationGeneration;
		const scopeChanged = route.tenantId !== this.selectedTenant.get() || route.projectId !== this.selectedProjectId.get();
		this.selectedTenant.set(route.tenantId);
		this.selectedProjectId.set(route.projectId);
		if (scopeChanged) {
			this.resetScopeDetail();
		}
		if (route.page === "instructions") {
			this.stopLiveUpdates();
			this.applyRoute(route, false);
			await this.loadInstructionCatalog();
			if (generation === this.browserNavigationGeneration) this.writeRestoredBrowserRoute(route);
			return;
		}
		if (!route.projectId) {
			this.snapshot.set(null);
			this.projectSummary.set(null);
			this.syncLabel.set("choose a project");
			await this.reloadProjectDiscovery();
			if (!this.completeBrowserNavigation(route, generation)) return;
			this.applyRoute(route);
			this.writeRestoredBrowserRoute(route);
			return;
		}

		this.stopLiveUpdates();
		this.syncLabel.set("connecting");
		try {
			await this.reloadProjectSummary();
			if (!this.completeBrowserNavigation(route, generation)) return;
			this.connectEvents();
			this.applyRoute(route);
			this.writeRestoredBrowserRoute(route);
		} catch (error) {
			if (generation !== this.browserNavigationGeneration) return;
			this.selectedProjectId.set(null);
			this.snapshot.set(null);
			this.projectSummary.set(null);
			this.writeRoute(this.currentRoute(), true);
			this.errorMessage.set(error instanceof Error ? error.message : String(error));
			this.syncLabel.set("project unavailable");
		}
	}

	protected completeBrowserNavigation(route: ViewerRoute, generation: number) {
		if (generation !== this.browserNavigationGeneration) return false;
		return this.allowBrowserNavigation(() => {
			void this.navigateToRoute(route);
		});
	}

	protected writeRestoredBrowserRoute(route: ViewerRoute) {
		if (JSON.stringify(this.readRoute()) !== JSON.stringify(route)) this.writeRoute(this.currentRoute(), true);
	}

	protected resetScopeDetail(options: { preserveGlobalSearch?: boolean } = {}) {
		this.instructionConflict.set(null);
		this.instructionCatalogGeneration += 1;
		this.instructionSourceGeneration += 1;
		this.instructionCatalog.set(null);
		this.instructionSource.set(null);
		this.selectedInstructionKey.set(null);
		this.instructionSearch.set("");
		this.instructionError.set(null);
		this.instructionCatalogLoading.set(false);
		this.instructionSourceLoading.set(false);
		this.cancelInitiativeTabPrefetch();
		this.cancelGlobalSearchRequest();
		if (!options.preserveGlobalSearch) {
			this.globalSearchCapability.set(null);
			this.globalSearchQuery.set("");
			this.globalSearchResponse.set(null);
			this.globalSearchProgress.set(false);
			this.globalSearchOpen.set(false);
		}
		this.entityDetails.set(new Map());
		this.projectAdrsCache.set({ data: null, error: null, loading: false });
		this.projectDebtCache.set({ data: null, error: null, loading: false });
		this.projectContextCache.set({ data: null, error: null, loading: false });
		this.projectGraphCache.set({ data: null, error: null, loading: false });
		this.planEntryPages.set(new Map());
		this.issueCommentPages.set(new Map());
		this.initiativeDetails.set(new Map());
		this.initiativeTabs.set(new Map());
		this.selectedId.set(null);
		this.selectedInitiativeId.set(null);
		this.selectedNestedTarget.set(null);
		this.cascadePath.set([]);
		this.reRootTrail.set([]);
		this.entityBackStack.set([]);
		this.activeSection.set("initiatives");
		this.activePage.set("list");
		this.activeView.set("overview");
		this.initTab.set("overview");
		this.initiativeStatusFilter.set("all");
		this.adrStatusFilter.set("all");
		this.clearMasterOverrideIfShallow();
	}

	protected connectEvents() {
		if (typeof EventSource !== "function") {
			this.startPolling();
			return;
		}

		this.events = new EventSource(this.buildTenantScopedPath("/events"));
		this.events.onmessage = (message) => {
			this.handleProjectChangeEvent(message);
		};
		this.events.onerror = () => {
			this.syncLabel.set("reconnecting");
			this.startPolling();
		};
	}

	protected handleProjectChangeEvent(message: MessageEvent<string>) {
		let event: ProjectChangeEvent;
		try {
			event = JSON.parse(message.data) as ProjectChangeEvent;
		} catch {
			this.refreshProjectSummaryInBackground();
			return;
		}

		if (event.correlationId) {
			const expiresAt = this.localChangeCorrelations.get(event.correlationId);
			this.localChangeCorrelations.delete(event.correlationId);
			if (expiresAt !== undefined && expiresAt >= Date.now()) {
				return;
			}
		}

		this.handleProjectChange(event);
	}

	protected handleProjectChange(event: ProjectChangeEvent) {
		if (event.projectId && event.projectId !== this.selectedProjectId.get()) {
			return;
		}
		if (!event.category || event.category === "bulk" || event.category === "unknown") {
			this.refreshProjectSummaryInBackground();
			return;
		}

		const selectedEntityId = this.selectedId.get();
		const affectedTabs = affectedInitiativeTabs(event);
		let handled = false;
		if (event.category === "entity") {
			for (const entityId of event.affectedEntityIds ?? []) {
				const cached = this.entityDetails.get().get(entityId);
				if (cached) {
					this.setEntityDetailCache(entityId, { ...cached, stale: true });
					handled = true;
				}
			}

			if (selectedEntityId && event.affectedEntityIds?.includes(selectedEntityId)) {
				void this.loadEntityDetail(selectedEntityId, true);
				handled = true;
			}

			if (event.affectedEntityKinds?.includes("adr")) {
				const cached = this.projectAdrsCache.get();
				if (cached.data) {
					this.projectAdrsCache.set({ ...cached, stale: true });
				}
				if (this.activeSection.get() === "adrs" && this.activePage.get() === "list") {
					void this.loadProjectAdrs(true);
				}
				handled = true;
			}

			if (event.affectedEntityKinds?.includes("debt")) {
				const cached = this.projectDebtCache.get();
				if (cached.data) {
					this.projectDebtCache.set({ ...cached, stale: true });
				}
				if (this.activeSection.get() === "debt" && this.activePage.get() === "list") {
					void this.loadProjectDebt(true);
				}
				handled = true;
			}

			const graphCache = this.projectGraphCache.get();
			if (graphCache.data) {
				this.projectGraphCache.set({ ...graphCache, stale: true });
			}
			if (this.activeSection.get() === "graph" && this.activePage.get() === "list") {
				void this.loadProjectGraph(true);
				handled = true;
			}
		}

		if (event.category === "issue-comment") {
			for (const issueId of event.affectedEntityIds ?? []) {
				const cached = this.issueCommentPages.get().get(issueId);
				if (cached) {
					this.setIssueCommentPageCache(issueId, { ...cached, stale: true });
					handled = true;
				}
				if (selectedEntityId === issueId) {
					void this.loadIssueCommentPage(issueId, true);
					handled = true;
				}
			}
		}

		if (event.category === "plan-entry") {
			for (const entityId of event.affectedEntityIds ?? []) {
				const cachedPlanEntries = this.planEntryPages.get().get(entityId);
				const isPlan = cachedPlanEntries !== undefined || this.entityForId(entityId)?.kind === "plan";
				if (cachedPlanEntries) {
					this.setPlanEntryPageCache(entityId, { ...cachedPlanEntries, stale: true });
					handled = true;
				}
				if (selectedEntityId === entityId && isPlan) {
					void this.loadPlanEntryPage(entityId, true);
					handled = true;
				}

				const cachedEntity = this.entityDetails.get().get(entityId);
				if (cachedEntity && !isPlan) {
					this.setEntityDetailCache(entityId, { ...cachedEntity, stale: true });
					handled = true;
				}
				if (selectedEntityId === entityId && !isPlan) {
					void this.loadEntityDetail(entityId, true);
					handled = true;
				}
			}
		}

		if (event.category === "context") {
			const cached = this.projectContextCache.get();
			if (cached.data) {
				this.projectContextCache.set({ ...cached, stale: true });
			}
			if (this.activeSection.get() === "context" && this.activePage.get() === "list") {
				void this.loadProjectContext(true);
			}
			handled = true;
		}

		if (event.category === "relation") {
			for (const entityId of event.affectedEntityIds ?? []) {
				const entityDetail = this.entityDetails.get().get(entityId);
				if (entityDetail) {
					this.setEntityDetailCache(entityId, { ...entityDetail, stale: true });
					handled = true;
				}
				if (selectedEntityId === entityId) {
					void this.loadEntityDetail(entityId, true);
					handled = true;
				}
			}

			const cached = this.projectGraphCache.get();
			if (cached.data) {
				this.projectGraphCache.set({ ...cached, stale: true });
			}
			if (this.activeSection.get() === "graph" && this.activePage.get() === "list") {
				void this.loadProjectGraph(true);
			}
			handled = true;
		}

		for (const initiativeId of event.affectedInitiativeIds ?? []) {
			if (event.affectedEntityIds?.includes(initiativeId)) {
				const cached = this.initiativeDetails.get().get(initiativeId);
				if (cached) {
					this.setInitiativeDetailCache(initiativeId, { ...cached, stale: true });
					handled = true;
				}
				if (this.selectedInitiativeId.get() === initiativeId && this.initTab.get() === "overview") {
					void this.loadInitiativeDetail(initiativeId, true);
					handled = true;
				}
			}

			for (const [cacheKey, cached] of this.initiativeTabs.get()) {
				const tab = cacheKey.slice(`${initiativeId}:`.length) as Exclude<InitiativeTab, "overview">;
				if (cacheKey.startsWith(`${initiativeId}:`) && affectedTabs.has(tab)) {
					this.setInitiativeTabCache(cacheKey, { ...cached, stale: true });
					handled = true;
				}
			}

			if (this.selectedInitiativeId.get() === initiativeId && this.initTab.get() !== "overview" && affectedTabs.has(this.initTab.get() as Exclude<InitiativeTab, "overview">)) {
				void this.loadInitiativeTab(initiativeId, this.initTab.get() as Exclude<InitiativeTab, "overview">, true);
				handled = true;
			}
		}

		if (handled) {
			if (event.affectsProjectSummary) {
				this.refreshProjectSummaryInBackground();
			}
			return;
		}

		this.refreshProjectSummaryInBackground();
	}

	protected startPolling() {
		if (this.pollTimer !== null) {
			return;
		}

		this.pollTimer = window.setInterval(() => {
			this.refreshProjectSummaryInBackground();
		}, 3000);
	}

	protected async fetchJson<T>(resourcePath: string): Promise<T> {
		const separator = resourcePath.includes("?") ? "&" : "?";
		const response = await fetch(`${resourcePath}${separator}ts=${Date.now()}`, { cache: "no-store" });
		if (!response.ok) {
			throw new Error(`Request failed for ${resourcePath}`);
		}

		return (await response.json()) as T;
	}

	protected sortEntities(entities: Entity[]) {
		return [...entities].sort((left, right) => {
			const leftTime = new Date(left.updatedAt).getTime();
			const rightTime = new Date(right.updatedAt).getTime();
			if (leftTime !== rightTime) {
				return rightTime - leftTime;
			}

			return left.id.localeCompare(right.id);
		});
	}

	protected buildIssueTree(bundle: InitiativeBundle, rootIds: string[], relevantIds: Set<string>): IssueTreeNode[] {
		const issueById = new Map(bundle.issues.map((issue) => [issue.id, issue]));
		const childIssueIdsByParentId = new Map<string, string[]>();

		for (const link of bundle.subIssueLinks) {
			if (!relevantIds.has(link.parent.id) || !relevantIds.has(link.issue.id)) {
				continue;
			}

			const childIssueIds = childIssueIdsByParentId.get(link.parent.id) ?? [];
			childIssueIds.push(link.issue.id);
			childIssueIdsByParentId.set(link.parent.id, childIssueIds);
		}

		const buildNode = (issueId: string): IssueTreeNode | null => {
			const issue = issueById.get(issueId);
			if (!issue) {
				return null;
			}

			const childIssues = this.sortEntities(
				(childIssueIdsByParentId.get(issueId) ?? [])
					.map((childIssueId) => issueById.get(childIssueId))
					.filter((childIssue): childIssue is Entity => Boolean(childIssue))
			);

			return {
				issue,
				children: childIssues
					.map((childIssue) => buildNode(childIssue.id))
					.filter((node): node is IssueTreeNode => node !== null)
			};
		};

		const rootIssues = this.sortEntities(
			rootIds
				.map((issueId) => issueById.get(issueId))
				.filter((issue): issue is Entity => Boolean(issue))
		);

		return rootIssues
			.map((issue) => buildNode(issue.id))
			.filter((node): node is IssueTreeNode => node !== null);
	}

	protected issueTreeNodeIds(node: IssueTreeNode): string[] {
		return [node.issue.id, ...node.children.flatMap((child) => this.issueTreeNodeIds(child))];
	}

	protected formatTenantDisplayName(tenantId: string) {
		return tenantId
			.replace(/-[0-9a-f]{12}$/i, "")
			.split(/[-_]+/)
			.filter((segment) => segment.length > 0)
			.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
			.join(" ");
	}

	protected readTenantFromUrl() {
		return this.readRoute().tenantId;
	}

	protected readProjectFromUrl() {
		return this.readRoute().projectId;
	}

	protected currentRoute(): ViewerRoute {
		return {
			instructionKey: this.selectedInstructionKey.get(),
			instructionCategory: this.instructionCategory.get(),
			tenantId: this.selectedTenant.get(),
			projectId: this.selectedProjectId.get(),
			page: this.activePage.get(),
			section: this.activeSection.get(),
			entityId: this.selectedId.get(),
			initiativeId: this.selectedInitiativeId.get(),
			initiativeTab: this.initTab.get(),
			target: this.selectedNestedTarget.get()
		};
	}

	protected readRoute(): ViewerRoute {
		const url = new URL(window.location.href);
		const params = new URLSearchParams(url.hash.slice(1));
		const legacyParams = url.searchParams;
		const tenantId = params.get("tenant") ?? legacyParams.get("tenant");
		const projectId = params.get("project") ?? legacyParams.get("project");
		const section = params.get("section");
		const entityId = params.get("entity");
		const initiativeId = params.get("initiative");
		const pageParam = params.get("page");
		const page: PageMode = pageParam === "instructions" ? "instructions" : pageParam === "entity"
			? "entity"
			: pageParam === "initiative"
				? "initiative"
				: pageParam === "project"
					? "list"
					: entityId
						? "entity"
						: initiativeId ? "initiative" : "list";
		const tabParam = params.get("tab");
		const initiativeTab = INITIATIVE_TABS.includes(tabParam as InitiativeTab) ? tabParam as InitiativeTab : "overview";
		const targetType = params.get("target");
		const targetId = params.get("target-id");
		const targetScopeRef = params.get("target-scope") ?? undefined;
		const target: NestedRouteTarget | null = targetType === "context"
			? { id: null, scopeRef: targetScopeRef, type: "context" }
			: targetId && targetType === "context-term"
				? { id: targetId, scopeRef: targetScopeRef, type: targetType }
			: targetId && (targetType === "context-term" || targetType === "issue-comment" || targetType === "plan-entry")
				? { type: targetType, id: targetId }
				: null;
		return {
			instructionKey: params.get("instruction"),
			instructionCategory: params.get("category") === "skill" ? "skill" : params.get("category") === "fragment" ? "fragment" : "agent",
			tenantId,
			projectId,
			page,
			section: isConsoleSection(section) ? section : "initiatives",
			entityId,
			initiativeId,
			initiativeTab,
			target
		};
	}

	protected normalizeRoute(route: ViewerRoute): ViewerRoute {
		if (route.page === "instructions") return { ...route, entityId: null, initiativeId: null, target: null };
		const entityById = this.entityById.get();
		if (entityById.size === 0) {
			return route;
		}

		const validEntityId = route.page === "entity" && route.entityId && (this.snapshot.get() === null || entityById.has(route.entityId)) ? route.entityId : null;
		const validInitiativeId = route.page === "initiative" && route.initiativeId && this.bundleForInitiativeId(route.initiativeId) ? route.initiativeId : null;
		return {
			...route,
			page: validEntityId ? "entity" : validInitiativeId ? "initiative" : "list",
			entityId: validEntityId,
			initiativeId: validInitiativeId,
			initiativeTab: validInitiativeId ? route.initiativeTab : "overview",
			target: this.normalizeNestedTarget(route.target, validEntityId)
		};
	}

	protected normalizeNestedTarget(target: NestedRouteTarget | null, entityId: string | null): NestedRouteTarget | null {
		if (!target) {
			return null;
		}

		if (target.type === "plan-entry") {
			const planEntry = (this.snapshot.get()?.planEntries ?? []).find((entry) => entry.id === target.id && entry.planId === entityId && !entry.tombstone);
			return planEntry ? target : null;
		}

		if (target.type === "issue-comment") {
			const comment = entityId ? this.snapshot.get()?.issueComments[entityId]?.comments.find((candidate) => candidate.id === target.id && !candidate.tombstone) : null;
			return comment ? target : null;
		}

		const context = target.scopeRef ? this.getContextForInitiative(target.scopeRef) : this.sharedContext.get();
		if (!context?.context.exists) {
			return null;
		}
		if (target.type === "context") {
			return target;
		}

		return context.terms.some((term) => term.term === target.id) ? target : null;
	}

	protected applyRoute(route: ViewerRoute, loadData = true): ViewerRoute {
		const normalizedRoute = this.normalizeRoute(route);
		this.routeHistoryPosition = this.readHistoryPosition() ?? this.routeHistoryPosition;
		if (normalizedRoute.initiativeId !== this.selectedInitiativeId.get()) {
			this.cancelInitiativeTabPrefetch();
		}
		this.selectedTenant.set(normalizedRoute.tenantId);
		this.selectedProjectId.set(normalizedRoute.projectId);
		this.activeSection.set(normalizedRoute.section);
		this.selectedId.set(normalizedRoute.entityId);
		this.selectedInitiativeId.set(normalizedRoute.initiativeId);
		this.initTab.set(normalizedRoute.initiativeTab);
		this.selectedNestedTarget.set(normalizedRoute.target);
		if (normalizedRoute.target?.type === "context" || normalizedRoute.target?.type === "context-term") {
			this.contextTab.set(normalizedRoute.target.scopeRef ? "initiatives" : "global");
			this.selectedContextInitiativeId.set(normalizedRoute.target.scopeRef ?? null);
		}
		this.cascadePath.set([]);
		this.reRootTrail.set([]);
		this.entityBackStack.set([]);
		this.clearMasterOverrideIfShallow();
		this.activePage.set(normalizedRoute.page);
		if (normalizedRoute.page === "instructions") {
			this.selectedInstructionKey.set(normalizedRoute.instructionKey ?? null);
			this.instructionCategory.set(normalizedRoute.instructionCategory ?? "agent");
			if (loadData) void this.loadInstructionCatalog();
			return normalizedRoute;
		}
		this.activeView.set("overview");
		if (!loadData) {
			return normalizedRoute;
		}
		if (normalizedRoute.entityId) {
			void this.loadEntityDetail(normalizedRoute.entityId);
		} else if (normalizedRoute.initiativeId && this.isSummaryInitiative(normalizedRoute.initiativeId)) {
			void this.loadInitiativeRoute(normalizedRoute.initiativeId, normalizedRoute.initiativeTab);
		} else if (normalizedRoute.section === "adrs") {
			void this.loadProjectAdrs();
		} else if (normalizedRoute.section === "debt") {
			void this.loadProjectDebt();
		} else if (normalizedRoute.section === "context") {
			void this.loadProjectContext();
		} else if (normalizedRoute.section === "graph") {
			void this.loadProjectGraph();
		}
		return normalizedRoute;
	}

	protected writeRoute(route: ViewerRoute, replace = false) {
		this.browserNavigationGeneration += 1;
		const historyPosition = this.readHistoryPosition();
		if (!replace && historyPosition === null) {
			window.history.replaceState({ ...window.history.state, agentIssuesRoutePosition: this.routeHistoryPosition }, "");
		}
		this.routeHistoryPosition = replace ? historyPosition ?? this.routeHistoryPosition : (historyPosition ?? this.routeHistoryPosition) + 1;
		const nextUrl = new URL(window.location.href);
		const entries: string[] = [];
		const add = (key: string, value: string | null) => {
			if (value) {
				entries.push(`${key}=${encodeURIComponent(value)}`);
			}
		};
		add("tenant", route.tenantId);
		add("project", route.projectId);
		add("page", route.page === "instructions" ? "instructions" : route.projectId ? route.page === "list" ? "project" : route.page : null);
		add("category", route.page === "instructions" ? route.instructionCategory ?? "agent" : null);
		add("instruction", route.page === "instructions" ? route.instructionKey ?? null : null);
		add("section", route.section === "initiatives" ? null : route.section);
		add("entity", route.entityId);
		add("initiative", route.initiativeId);
		add("tab", route.page === "initiative" ? route.initiativeTab : null);
		add("target", route.target?.type ?? null);
		add("target-id", route.target?.id ?? null);
		add("target-scope", route.target?.scopeRef ?? null);
		nextUrl.searchParams.delete("tenant");
		nextUrl.searchParams.delete("project");
		nextUrl.hash = entries.join("&");
		window.history[replace ? "replaceState" : "pushState"]({ ...window.history.state, agentIssuesRoutePosition: this.routeHistoryPosition }, "", nextUrl);
	}

	protected buildTenantScopedPath(resourcePath: string) {
		const tenantId = this.selectedTenant.get();
		const projectId = this.selectedProjectId.get();
		if (!tenantId && !projectId) {
			return resourcePath;
		}

		const separator = resourcePath.includes("?") ? "&" : "?";
		const query = new URLSearchParams();
		if (tenantId) {
			query.set("tenant", tenantId);
		}
		if (projectId) {
			query.set("project", projectId);
		}
		return query.size > 0 ? `${resourcePath}${separator}${query}` : resourcePath;
	}

	protected stopLiveUpdates() {
		this.events?.close();
		this.events = null;
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}

function hasConflictingDefinitions(sources: ProjectContextTermSource[]): boolean {
	const definitions = new Set(
		sources
			.map((source) => source.definition.trim().toLowerCase())
			.filter((definition) => definition.length > 0)
	);

	return definitions.size > 1;
}

function belongsToPlanCurrentGroup(entry: PlanEntry, groupKey: PlanCurrentGroupKey): boolean {
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

function compareProjectContextSources(left: ProjectContextTermSource, right: ProjectContextTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return left.scopeKind === "default" ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}