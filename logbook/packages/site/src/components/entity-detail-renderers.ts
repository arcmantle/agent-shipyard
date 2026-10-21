import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { choose } from "lit/directives/choose.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { PROJECT_GRAPH_KINDS, type ContextDetails, type Entity, type GraphEdge, type GraphNode, type InitiativeBundle, type IssueComment, type PlanEntry, type ProjectGraphKind, type RelationshipGraph } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";

export type EntityDetailTab = "overview" | "plan" | "issues" | "plans" | "prds" | "adrs" | "context" | "userStories" | "debt" | "related" | "graph";
export type RecordView = "list" | "tree";

export type EntityDetailTabDefinition = {
	label: string;
	recordCount?: number;
	tab: EntityDetailTab;
};

export type DetailRecordSection = {
	crossLink?: boolean;
	key: string;
	records: Entity[];
	title: string;
};

export type EntityDetailData = {
	adrRecords: Entity[];
	bundle: InitiativeBundle | null;
	crossLinkRecordIds: ReadonlySet<string>;
	debtRecords: Entity[];
	debtSections: DetailRecordSection[];
	inheritedContext: ContextDetails | null;
	issueGraph: RelationshipGraph;
	issueRecords: Entity[];
	linkedSections: DetailRecordSection[];
	parentIssue: Entity | null;
	planRecords: Entity[];
	prdRecords: Entity[];
	relatedRecords: Entity[];
	subIssueTree: DetailIssueTreeNode[];
	tabs: EntityDetailTabDefinition[];
	userStoryRecords: Entity[];
};

export type DetailIssueTreeNode = {
	issue: Entity;
	children: DetailIssueTreeNode[];
};

export type EntityDetailRendererContext = {
	bundle: InitiativeBundle | null;
	entity: Entity;
	linkedRecords: Entity[];
	parentIssue: Entity | null;
	prdStories: Entity[];
	issueTreeForStory: (storyId: string) => DetailIssueTreeNode[];
	recordsInIssueTree: (nodes: DetailIssueTreeNode[]) => Entity[];
};

export type EntityDetailRendererHost = {
	entityDetailTab: EntityDetailTab;
	visibleGraphKinds: ReadonlySet<ProjectGraphKind>;
	renderBodySourceNotice(): TemplateResult;
	renderPlanEntry(entry: PlanEntry): TemplateResult;
	renderIssueComment(comment: IssueComment): TemplateResult;
	renderContextTab(context: ContextDetails | null): TemplateResult;
	renderGraphTab(graph: RelationshipGraph): TemplateResult;
	renderIssueTree(nodes: DetailIssueTreeNode[]): TemplateResult;
	renderIssueTreeForRecords(bundle: InitiativeBundle, records: Entity[], matchingRecords: Entity[]): TemplateResult;
	renderRecordBrowser(title: string, records: Entity[], emptyMessage: string, bundle: InitiativeBundle | null, options?: {
		crossLinkRecordIds?: ReadonlySet<string>;
		treeContent?: (matchingRecords: Entity[]) => TemplateResult;
		treeTab?: "issues" | "userStories";
	}): TemplateResult;
	renderRef(record: Entity, crossLink?: boolean): TemplateResult | typeof nothing;
	renderRefSections(sections: DetailRecordSection[]): TemplateResult;
	renderTabButton(tab: EntityDetailTab, label: string, active: boolean, recordCount?: number): TemplateResult;
};

export type EntityDetailDataContext = {
	bundle: InitiativeBundle | null;
	debtSections: DetailRecordSection[];
	entity: Entity;
	graphAvailable: boolean;
	inheritedContext: ContextDetails | null;
	issueGraph: RelationshipGraph;
};

export abstract class EntityDetailRenderer {
	public constructor(store: AgentIssuesStore, entity: Entity, host: EntityDetailRendererHost) {
		this.store = store;
		this.entity = entity;
		this.host = host;
	}

	public store: AgentIssuesStore;
	public entity: Entity;
	public host: EntityDetailRendererHost;
	public abstract label: string;
	protected onLoadMoreIssueComments = () => {
		void this.store.loadMoreIssueComments(this.entity.id);
	};

	public usesTabs(): boolean {
		return true;
	}

	public issueSeeds(context: EntityDetailRendererContext): Entity[] {
		return context.linkedRecords.filter((record) => record.kind === "issue");
	}

	public additionalUserStories(_context: EntityDetailRendererContext, _issueRecordIds: ReadonlySet<string>): Entity[] {
		return [];
	}

	public entityTabs(): EntityDetailTabDefinition[] {
		return [];
	}

	public detailData(): EntityDetailData {
		const bundle = this.store.bundleForEntityId(this.entity.id);
		const debtSections = this.store.debtRecordSectionsFor(this.entity.id);
		const linkedSections = this.store.linkedRecordSectionsFor(this.entity.id, {
			excludeRelatedIds: debtSections.flatMap((section) => section.records.map((record) => record.id)),
			excludeRelationTypes: this.excludedRelationTypes()
		});
		const baseIssueGraph = this.buildIssueGraph(bundle);
		const context: EntityDetailDataContext = {
			bundle,
			debtSections,
			entity: this.entity,
			graphAvailable: baseIssueGraph.edges.length > 0,
			inheritedContext: bundle ? this.store.getContextForInitiative(bundle.initiative.id) : null,
			issueGraph: this.filterGraphByKind(baseIssueGraph, this.host.visibleGraphKinds)
		};
		const linkedRecords = this.uniqueRecords(linkedSections.flatMap((section) => section.records));
		const rendererContext: EntityDetailRendererContext = {
			bundle,
			entity: this.entity,
			issueTreeForStory: (storyId) => bundle ? this.store.issueTreeForStory(bundle, storyId) : [],
			linkedRecords,
			parentIssue: this.parentIssue(context),
			prdStories: this.prdStories(context),
			recordsInIssueTree: (nodes) => this.recordsInIssueTree(nodes)
		};
		const directIssueRecords = this.issueSeeds(rendererContext);
		const issueRecords = this.uniqueRecords([
			...directIssueRecords,
			...directIssueRecords.flatMap((record) => bundle ? this.recordsInIssueTree(this.store.subIssueTreeForIssue(bundle, record.id)) : []),
			...linkedRecords.filter((record) => record.kind === "issue")
		]).filter((record) => record.id !== this.entity.id);
		const issueRecordIds = new Set(issueRecords.map((record) => record.id));
		const userStoryRecords = this.uniqueRecords([
			...linkedRecords.filter((record) => record.kind === "userStory"),
			...this.additionalUserStories(rendererContext, issueRecordIds),
			...(context.bundle?.fixLinks.filter((link) => issueRecordIds.has(link.issue.id)).map((link) => link.userStory) ?? [])
		]).filter((record) => record.id !== this.entity.id);
		const planRecords = linkedRecords.filter((record) => record.kind === "plan");
		const prdRecords = linkedRecords.filter((record) => record.kind === "prd");
		const adrRecords = this.uniqueRecords([
			...linkedRecords.filter((record) => record.kind === "adr"),
			...(bundle?.constrainsLinks.filter((link) => link.issue.id === this.entity.id).map((link) => link.adr) ?? [])
		]);
		const debtRecords = this.uniqueRecords([
			...context.debtSections.flatMap((section) => section.records),
			...linkedRecords.filter((record) => record.kind === "debt")
		]);
		const relatedRecords = linkedRecords.filter((record) => !["issue", "userStory", "plan", "prd", "adr", "debt"].includes(record.kind));

		return {
			adrRecords,
			bundle,
			crossLinkRecordIds: new Set(linkedSections.filter((section) => section.crossLink).flatMap((section) => section.records.map((record) => record.id))),
			debtRecords,
			debtSections,
			inheritedContext: context.inheritedContext,
			issueGraph: context.issueGraph,
			issueRecords,
			linkedSections,
			parentIssue: rendererContext.parentIssue,
			planRecords,
			prdRecords,
			relatedRecords,
			subIssueTree: this.entity.kind === "issue" && bundle ? this.store.subIssueTreeForIssue(bundle, this.entity.id) : [],
			tabs: this.tabsFor(context, issueRecords, planRecords, prdRecords, adrRecords, userStoryRecords, debtRecords, relatedRecords),
			userStoryRecords
		};
	}

	public renderDetail(): TemplateResult {
		const data = this.detailData();
		const activeTab = data.tabs.some(({ tab }) => tab === this.host.entityDetailTab) ? this.host.entityDetailTab : "overview";

		return html`
		${when(
			this.usesTabs(),
			() => this.renderTabbedDetail(data, activeTab),
			() => this.renderUntabbedDetail(data)
		)}
		`;
	}

	public renderTabbedDetail(data: EntityDetailData, activeTab: EntityDetailTab): TemplateResult {
		return html`
		<div
			aria-label=${`${this.label} details`}
			class="ai-subtabs"
			role="tablist"
		>
			${repeat(data.tabs, ({ tab }) => tab, ({ label, recordCount, tab }) => this.host.renderTabButton(tab, label, activeTab === tab, recordCount))}
		</div>
		<section
			aria-labelledby=${`issue-detail-${this.entity.id}-${activeTab}-tab`}
			id=${`issue-detail-${this.entity.id}-${activeTab}-panel`}
			role="tabpanel"
		>
			${choose(activeTab, [
				["overview", () => this.renderOverview()],
				["plan", () => this.renderPlanTab()],
				["issues", () => this.host.renderRecordBrowser("Issues", data.issueRecords, "No related issues.", this.store.bundleForEntityId(this.entity.id), {
					crossLinkRecordIds: data.crossLinkRecordIds,
					treeContent: (matchingRecords) => when(
						this.store.bundleForEntityId(this.entity.id) !== null,
						() => html`
						<div class="ai-record-tree ai-issue-tree">
							${this.host.renderIssueTreeForRecords(this.store.bundleForEntityId(this.entity.id)!, data.issueRecords, matchingRecords)}
						</div>
						`,
						() => html`
						<div class="ai-record-tree ai-issue-tree">
							${repeat(matchingRecords, (record) => record.id, (record) => this.host.renderRef(record))}
						</div>
						`
					),
					treeTab: "issues"
				})],
				["plans", () => this.host.renderRecordBrowser("Plans", data.planRecords, "No related Plans.", this.store.bundleForEntityId(this.entity.id))],
				["prds", () => this.host.renderRecordBrowser("PRDs", data.prdRecords, "No related PRDs.", this.store.bundleForEntityId(this.entity.id))],
				["adrs", () => this.host.renderRecordBrowser("ADRs", data.adrRecords, "No related ADRs.", this.store.bundleForEntityId(this.entity.id))],
				["context", () => this.host.renderContextTab(data.inheritedContext)],
				["userStories", () => this.host.renderRecordBrowser("User stories", data.userStoryRecords, "No related user stories.", this.store.bundleForEntityId(this.entity.id), {
					treeContent: (matchingRecords) => this.renderUserStoryTree(data, matchingRecords),
					treeTab: "userStories"
				})],
				["debt", () => this.host.renderRecordBrowser("Debt", data.debtRecords, "No debt recorded.", this.store.bundleForEntityId(this.entity.id))],
				["related", () => this.host.renderRecordBrowser("Related records", data.relatedRecords, "No other related records.", this.store.bundleForEntityId(this.entity.id))],
				["graph", () => this.host.renderGraphTab(data.issueGraph)]
			])}
		</section>
		`;
	}

	public renderUntabbedDetail(data: EntityDetailData): TemplateResult {
		return html`
		${this.renderOverview()}
		${when(
			data.debtSections.length > 0,
			() => this.host.renderRefSections(data.debtSections),
			() => nothing
		)}
		${when(
			data.linkedSections.length > 0,
			() => this.host.renderRefSections(data.linkedSections),
			() => html`
			<section class="ai-sec">
				<h2>Linked records</h2>
				<div class="ai-empty">Nothing is linked to this record yet.</div>
			</section>
			`
		)}
		`;
	}

	public renderPlanTab(): TemplateResult {
		return html``;
	}

	public renderUserStoryTree(data: EntityDetailData, stories: Entity[]): TemplateResult {
		return html`
		<div class="ai-record-tree">
			${repeat(stories, (story) => story.id, (story) => html`
			<div class="ai-story-block">
				${this.host.renderRef(story)}
				${when(
					data.bundle !== null,
					() => html`<div class="ai-story-issues">${this.host.renderIssueTree(this.store.issueTreeForStory(data.bundle!, story.id))}</div>`,
					() => nothing
				)}
			</div>
			`)}
		</div>
		`;
	}

	public relatedRecordsFor(record: Entity, bundle: InitiativeBundle | null): Entity[] {
		const relatedRecords = new Map<string, Entity>();
		const add = (relatedRecord: Entity) => {
			if (relatedRecord.id !== record.id) relatedRecords.set(relatedRecord.id, relatedRecord);
		};

		for (const link of bundle?.fixLinks ?? []) {
			if (link.issue.id === record.id) add(link.userStory);
			if (link.userStory.id === record.id) add(link.issue);
		}
		for (const link of bundle?.subIssueLinks ?? []) {
			if (link.issue.id === record.id) add(link.parent);
			if (link.parent.id === record.id) add(link.issue);
		}
		for (const link of bundle?.blockerLinks ?? []) {
			if (link.source.id === record.id) add(link.target);
			if (link.target.id === record.id) add(link.source);
		}
		for (const link of bundle?.constrainsLinks ?? []) {
			if (link.adr.id === record.id) add(link.issue);
			if (link.issue.id === record.id) add(link.adr);
		}
		for (const relation of [...this.store.incomingRelationsFor(record.id), ...this.store.outgoingRelationsFor(record.id)]) {
			const relatedId = relation.fromId === record.id ? relation.toId : relation.fromId;
			const relatedRecord = this.store.entityById.get().get(relatedId);
			if (relatedRecord) add(relatedRecord);
		}

		return [...relatedRecords.values()];
	}

	public graphKindFor(record: Entity): ProjectGraphKind | null {
		const kind = record.kind === "userStory" ? "story" : record.kind;
		return PROJECT_GRAPH_KINDS.includes(kind as ProjectGraphKind) ? kind as ProjectGraphKind : null;
	}

	public graphKindLabel(kind: ProjectGraphKind): string {
		return kind === "story" ? "User stories" : `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}s`;
	}

	public buildIssueGraph(bundle: InitiativeBundle | null): RelationshipGraph {
		const graphRecords = this.uniqueRecords([this.entity, ...this.relatedRecordsFor(this.entity, bundle)])
			.filter((record) => this.graphKindFor(record) !== null);
		const kinds = [...new Set(graphRecords.map((record) => this.graphKindFor(record)!))];
		const columnByKind = new Map(kinds.map((kind, index) => [kind, index]));
		const recordIds = new Set(graphRecords.map((record) => record.id));
		const nodes: GraphNode[] = graphRecords.map((record) => ({
			col: columnByKind.get(this.graphKindFor(record)!)!,
			fullLabel: `${this.store.shortRef(record)} ${record.title}`,
			id: record.id,
			key: record.id,
			kind: this.graphKindFor(record)!,
			label: record.title,
			status: record.status
		}));
		const edges: GraphEdge[] = this.store.scopedRelations()
			.filter((relation) => recordIds.has(relation.fromId) && recordIds.has(relation.toId))
			.map((relation) => ({ from: relation.fromId, label: relation.type, to: relation.toId }));

		return { columns: kinds.map((kind) => this.graphKindLabel(kind)), edges, nodes };
	}

	public filterGraphByKind(graph: RelationshipGraph, visibleGraphKinds: ReadonlySet<ProjectGraphKind>): RelationshipGraph {
		const visibleNodes = graph.nodes.filter((node) => visibleGraphKinds.has(node.kind as ProjectGraphKind));
		const visibleKeys = new Set(visibleNodes.map((node) => node.key));
		const visibleColumnIndexes = [...new Set(visibleNodes.map((node) => node.col))].sort((left, right) => left - right);
		const compactColumnByIndex = new Map(visibleColumnIndexes.map((column, index) => [column, index]));

		return {
			columns: visibleColumnIndexes.map((column) => graph.columns[column]!),
			edges: graph.edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to)),
			nodes: visibleNodes.map((node) => ({ ...node, col: compactColumnByIndex.get(node.col)! }))
		};
	}

	public excludedRelationTypes(): string[] {
		return [];
	}

	public parentIssue(_context: EntityDetailDataContext): Entity | null {
		return null;
	}

	public prdStories(_context: EntityDetailDataContext): Entity[] {
		return [];
	}

	public tabsFor(
		context: EntityDetailDataContext,
		issueRecords: Entity[],
		planRecords: Entity[],
		prdRecords: Entity[],
		adrRecords: Entity[],
		userStoryRecords: Entity[],
		debtRecords: Entity[],
		relatedRecords: Entity[]
	): EntityDetailTabDefinition[] {
		const candidateTabs: Array<EntityDetailTabDefinition & { visible: () => boolean }> = [
			{ label: "Issues", recordCount: issueRecords.length, tab: "issues", visible: () => issueRecords.length > 0 },
			{ label: "Plans", recordCount: planRecords.length, tab: "plans", visible: () => planRecords.length > 0 },
			{ label: "PRDs", recordCount: prdRecords.length, tab: "prds", visible: () => prdRecords.length > 0 },
			{ label: "ADRs", recordCount: adrRecords.length, tab: "adrs", visible: () => adrRecords.length > 0 },
			{ label: "Context", tab: "context", visible: () => context.inheritedContext?.context.exists === true },
			{ label: "User stories", recordCount: userStoryRecords.length, tab: "userStories", visible: () => userStoryRecords.length > 0 },
			{ label: "Debt", recordCount: debtRecords.length, tab: "debt", visible: () => debtRecords.length > 0 },
			{ label: "Related", recordCount: relatedRecords.length, tab: "related", visible: () => relatedRecords.length > 0 },
			{ label: "Graph", tab: "graph", visible: () => context.graphAvailable }
		];

		return [
			{ label: "Overview", tab: "overview" },
			...this.entityTabs(),
			...candidateTabs.filter((tab) => tab.visible())
		];
	}

	public uniqueRecords(records: Entity[]): Entity[] {
		return [...new Map(records.map((record) => [record.id, record])).values()];
	}

	public recordsInIssueTree(nodes: DetailIssueTreeNode[]): Entity[] {
		return nodes.flatMap((node) => [node.issue, ...this.recordsInIssueTree(node.children)]);
	}

	public renderOverview(): TemplateResult {
		const body = (this.entity.body ?? "").trim();
		const bodySource = this.entity.bodySource ?? "authored";
		const comments = this.entity.kind === "issue" ? this.store.issueCommentsFor(this.entity.id) : [];
		const hasMoreComments = this.entity.kind === "issue" && (this.store.issueCommentPages.get().get(this.entity.id)?.data?.nextBefore ?? null) !== null;

		return html`
		${when(
			body.length > 0,
			() => html`
			<section class="ai-sec ai-body">
				${when(bodySource === "generated", () => this.host.renderBodySourceNotice(), () => nothing)}
				${unsafeHtml(renderAuthoredBody(body))}
			</section>
			`,
			() => nothing
		)}
		${when(
			comments.length > 0,
			() => html`
			<section class="ai-sec ai-conversation">
				<h2>Conversation</h2>
				${repeat(comments, (comment) => comment.id, (comment) => this.host.renderIssueComment(comment))}
				${when(
					hasMoreComments,
					() => html`<button @click=${this.onLoadMoreIssueComments}>Load more comments</button>`,
					() => nothing
				)}
			</section>
			`,
			() => nothing
		)}
		`;
	}
}

class IssueRenderer extends EntityDetailRenderer {
	public label = "Issue";

	public override excludedRelationTypes(): string[] {
		return ["decomposes"];
	}

	public override parentIssue(context: EntityDetailDataContext): Entity | null {
		return context.bundle ? this.store.parentIssueForIssue(context.bundle, this.entity.id) : null;
	}

	public override issueSeeds(context: EntityDetailRendererContext): Entity[] {
		return [context.entity, ...(context.parentIssue ? [context.parentIssue] : [])];
	}
}

class AdrRenderer extends EntityDetailRenderer {
	public label = "ADR";

	public override issueSeeds(context: EntityDetailRendererContext): Entity[] {
		const constrainedIssues = context.bundle?.constrainsLinks
			.filter((link) => link.adr.id === context.entity.id)
			.map((link) => link.issue) ?? [];
		return [...super.issueSeeds(context), ...constrainedIssues];
	}
}

class PrdRenderer extends EntityDetailRenderer {
	public label = "PRD";

	public override excludedRelationTypes(): string[] {
		return ["creates"];
	}

	public override prdStories(context: EntityDetailDataContext): Entity[] {
		return context.bundle?.userStories.filter((story) => this.store.outgoingRelationsFor(this.entity.id).some((relation) => relation.type === "creates" && relation.toId === story.id)) ?? [];
	}

	public override issueSeeds(context: EntityDetailRendererContext): Entity[] {
		const createdStoryIssues = context.prdStories.flatMap((story) =>
			context.recordsInIssueTree(context.issueTreeForStory(story.id))
		);
		return [...super.issueSeeds(context), ...createdStoryIssues];
	}

	public override additionalUserStories(context: EntityDetailRendererContext): Entity[] {
		return context.prdStories;
	}
}

class UserStoryRenderer extends EntityDetailRenderer {
	public label = "User story";

	public override issueSeeds(context: EntityDetailRendererContext): Entity[] {
		return [
			...super.issueSeeds(context),
			...context.recordsInIssueTree(context.issueTreeForStory(context.entity.id))
		];
	}
}

class PlanRenderer extends EntityDetailRenderer {
	public label = "Plan";
	protected onLoadMorePlanEntries = () => {
		void this.store.loadMorePlanEntries(this.entity.id);
	};

	public override entityTabs(): EntityDetailTabDefinition[] {
		return [{ label: "Plan", tab: "plan" }];
	}

	public renderCurrentPlanEntry(entry: PlanEntry, showQuestionContext: boolean, entriesById: ReadonlyMap<string, PlanEntry>): TemplateResult {
		const questions = showQuestionContext ? supersededQuestionsFor(entry, entriesById) : [];

		return html`
		${when(
			questions.length > 0,
			() => html`
			<div class="ai-plan-decision-pair">
				${repeat(questions, (question) => question.id, (question) => html`
				<section class="ai-plan-decision-question">
					<div class="ai-plan-decision-pair-label">Question</div>
					${this.host.renderPlanEntry(question)}
				</section>
				`)}
				<section class="ai-plan-decision-answer">
					<div class="ai-plan-decision-pair-label">Decision</div>
					${this.host.renderPlanEntry(entry)}
				</section>
			</div>
			`,
			() => this.host.renderPlanEntry(entry)
		)}
		`;
	}

	public override renderPlanTab(): TemplateResult {
		const planProjection = this.store.planProjectionFor(this.entity.id);
		const currentGroups = planProjection.current.filter((group) => group.entries.length > 0);
		const entriesById = new Map(planProjection.history.map((entry) => [entry.id, entry]));
		const hasMoreEntries = (this.store.planEntryPages.get().get(this.entity.id)?.data?.nextBefore ?? null) !== null;

		return html`
		<div class="ai-plan-tab">
			<section class="ai-sec ai-plan-current">
				<h2>Current plan</h2>
				${when(
					currentGroups.length > 0,
					() => repeat(currentGroups, (group) => group.key, (group) => html`
					<details class="ai-plan-group">
						<summary>
							<span>${group.title}</span>
							<span class="ai-plan-count">${group.entries.length}</span>
						</summary>
						<div
							class="ai-plan-entries"
							data-plan-group=${group.key}
						>
							${repeat(group.entries, (entry) => entry.id, (entry) => this.renderCurrentPlanEntry(entry, group.key === "decisions", entriesById))}
						</div>
					</details>
					`),
					() => html`<div class="ai-empty">No current Plan entries.</div>`
				)}
			</section>
			<details class="ai-sec ai-plan-history">
				<summary>
					<span>Entry history</span>
					<span class="ai-plan-count">${planProjection.history.length}</span>
				</summary>
				<div class="ai-plan-entries">
					${when(
						planProjection.history.length > 0,
						() => repeat(planProjection.history, (entry) => entry.id, (entry) => this.host.renderPlanEntry(entry)),
						() => html`<div class="ai-empty">No Plan entries yet.</div>`
					)}
				</div>
			</details>
			${when(
				hasMoreEntries,
				() => html`<button @click=${this.onLoadMorePlanEntries}>Load more entries</button>`,
				() => nothing
			)}
		</div>
		`;
	}
}

class DebtRenderer extends EntityDetailRenderer {
	public label = "Debt";
}

class HandoffRenderer extends EntityDetailRenderer {
	public label = "Handoff";
}

class GenericEntityRenderer extends EntityDetailRenderer {
	public label = "Record";

	public override usesTabs(): boolean {
		return false;
	}
}

export function createEntityDetailRenderer(store: AgentIssuesStore, entity: Entity, host: EntityDetailRendererHost): EntityDetailRenderer {
	switch (entity.kind) {
		case "issue":
			return new IssueRenderer(store, entity, host);
		case "adr":
			return new AdrRenderer(store, entity, host);
		case "prd":
			return new PrdRenderer(store, entity, host);
		case "userStory":
			return new UserStoryRenderer(store, entity, host);
		case "plan":
			return new PlanRenderer(store, entity, host);
		case "debt":
			return new DebtRenderer(store, entity, host);
		case "handoff":
			return new HandoffRenderer(store, entity, host);
		default:
			return new GenericEntityRenderer(store, entity, host);
	}
}

function supersededQuestionsFor(entry: PlanEntry, entriesById: ReadonlyMap<string, PlanEntry>): PlanEntry[] {
	const questions = new Map<string, PlanEntry>();
	const visitedIds = new Set<string>();
	const visit = (entryId: string) => {
		if (visitedIds.has(entryId)) return;
		visitedIds.add(entryId);

		const supersededEntry = entriesById.get(entryId);
		if (!supersededEntry) return;
		if (supersededEntry.role === "question" && !supersededEntry.tombstone) questions.set(supersededEntry.id, supersededEntry);
		for (const supersededEntryId of supersededEntry.supersededEntryIds) visit(supersededEntryId);
	};

	for (const supersededEntryId of entry.supersededEntryIds) visit(supersededEntryId);
	return [...questions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function unsafeHtml(value: string): TemplateResult {
	return html`${unsafeHTML(value)}`;
}

function renderAuthoredBody(markdown: string): string {
	const rawHtml = marked.parse(markdown, { async: false });
	return DOMPurify.sanitize(rawHtml);
}
