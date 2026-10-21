import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { choose } from "lit/directives/choose.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import "./context-view.js";
import "./record-browser-elements.js";
import "./relationship-graph.js";
import "./relationship-graph-filters.js";
import type { Entity, InitiativeBundle, InitiativeTab, ProjectGraphKind } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

function renderMarkdownBody(markdown: string): string {
	const rawHtml = marked.parse(markdown, { async: false });
	return DOMPurify.sanitize(rawHtml);
}

type IssueTreeNode = {
	issue: Entity;
	children: IssueTreeNode[];
};

type RecordTreeTab = "issues" | "userStories";
type RecordView = "list" | "tree";
type RankedRecord = { index: number; rank: number; record: Entity };
type InitiativeTabDefinition = {
	label: string;
	recordCount?: number;
	tab: InitiativeTab;
};

const INITIATIVE_GRAPH_KINDS: ProjectGraphKind[] = ["initiative", "plan", "prd", "adr", "story", "issue", "debt"];
const INITIATIVE_TAB_DETAILS: Array<[Exclude<InitiativeTab, "overview">, string]> = [
	["issues", "Issues"],
	["plans", "Plans"],
	["prds", "PRDs"],
	["adrs", "ADRs"],
	["graph", "Graph"],
	["context", "Context"],
	["userStories", "User stories"],
	["debt", "Debt"]
];

class InitiativeDetailView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false },
		initiativeId: { attribute: false },
		cascade: { attribute: false },
		activeChildId: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;
	public initiativeId: string | null = null;
	public cascade = false;
	public activeChildId: string | null = null;
	protected collapsedIssueIds = new Set<string>();
	protected collapsedOverviewSectionIds = new Set<string>();
	protected recordQuery = "";
	protected recordStatus = "current-work";
	protected issueRecordView: RecordView = "tree";
	protected userStoryRecordView: RecordView = "tree";
	protected visibleGraphKinds = new Set<ProjectGraphKind>(INITIATIVE_GRAPH_KINDS);

	protected activeBundle() {
		const store = this.store;
		if (!store) {
			return null;
		}

		return store.bundleForInitiativeId(this.initiativeId ?? store.selectedInitiativeId.get());
	}

	protected getTabButtonId(tab: InitiativeTab): string {
		return `initiative-tab-${tab}`;
	}

	protected getTabPanelId(tab: InitiativeTab): string {
		return `initiative-panel-${tab}`;
	}

	protected onSelectEntityClick = (event: Event) => {
		if (this.cascade) {
			const childId = (event.currentTarget as HTMLElement).dataset.id;
			if (childId && this.initiativeId) {
				this.store?.drillCascade(this.initiativeId, childId);
			}

			return;
		}

		this.store?.selectEntityFromEvent(event);
	};

	protected onSetTab = (event: Event) => {
		const tab = (event.currentTarget as HTMLElement).dataset.tab as InitiativeTab | undefined;
		if (!tab) {
			return;
		}

		this.recordQuery = "";
		this.recordStatus = tab === "issues" || tab === "userStories" ? "current-work" : "all";
		this.store?.setInitTab(tab);
	};

	protected onRetryLoad = (event: Event) => {
		const target = event.currentTarget as HTMLElement;
		const initiativeId = target.dataset.initiativeId;
		const tab = target.dataset.tab as Exclude<InitiativeTab, "overview"> | undefined;
		if (!initiativeId) {
			return;
		}

		if (tab) {
			void this.store?.retryInitiativeTab(initiativeId, tab);
			return;
		}

		void this.store?.retryInitiativeDetail(initiativeId);
	};

	protected onContextQueryInput = (event: Event) => {
		this.recordQuery = (event.target as HTMLInputElement).value;
		this.requestUpdate();
	};

	protected onRecordQueryChange = (event: Event) => {
		this.recordQuery = (event as CustomEvent<{ query: string }>).detail.query;
		this.requestUpdate();
	};

	protected onRecordStatusChange = (event: Event) => {
		this.recordStatus = (event as CustomEvent<{ status: string }>).detail.status;
		this.requestUpdate();
	};

	protected onRecordViewChange = (event: Event) => {
		const { tab, view } = (event as CustomEvent<{ tab: RecordTreeTab; view: RecordView }>).detail;
		if (tab === "issues") {
			this.issueRecordView = view;
		} else {
			this.userStoryRecordView = view;
		}
		this.requestUpdate();
	};

	protected onRecordOpen = (event: Event) => {
		const record = (event as CustomEvent<{ record: Entity }>).detail.record;
		if (this.cascade && this.initiativeId) {
			this.store?.drillCascade(this.initiativeId, record.id);
			return;
		}

		this.store?.selectEntity(record.id);
	};

	protected onNodeOpen = (event: Event) => {
		const id = (event as CustomEvent<{ id: string }>).detail.id;
		if (!id) {
			return;
		}

		this.store?.selectEntity(id);
	};

	protected onToggleGraphKind = (event: Event) => {
		const kind = (event as CustomEvent<{ kind: ProjectGraphKind }>).detail.kind;
		if (!kind) {
			return;
		}

		const visibleKinds = new Set(this.visibleGraphKinds);
		if (visibleKinds.has(kind)) {
			visibleKinds.delete(kind);
		} else {
			visibleKinds.add(kind);
		}
		this.visibleGraphKinds = visibleKinds;
		this.requestUpdate();
	};

	protected onToggleIssueBranch = (event: Event) => {
		event.stopPropagation();
		const issueId = (event.currentTarget as HTMLElement).dataset.id;
		if (!issueId) {
			return;
		}

		if (this.collapsedIssueIds.has(issueId)) {
			this.collapsedIssueIds.delete(issueId);
		} else {
			this.collapsedIssueIds.add(issueId);
		}

		this.requestUpdate();
	};

	protected onToggleOverviewSection = (event: Event) => {
		const sectionId = (event.currentTarget as HTMLElement).dataset.sectionId;
		if (!sectionId) {
			return;
		}

		if (this.collapsedOverviewSectionIds.has(sectionId)) {
			this.collapsedOverviewSectionIds.delete(sectionId);
		} else {
			this.collapsedOverviewSectionIds.add(sectionId);
		}

		this.requestUpdate();
	};

	protected renderBodySourceNotice() {
		return html`
		<div class="ai-body-source ai-body-source-generated">
			<span class="ai-body-source-badge">Generated fallback</span>
			<span class="ai-body-source-copy">Generated from tracker metadata because no authored body was present.</span>
		</div>
		`;
	}

	protected renderIssueBranch(node: IssueTreeNode, reserveBranchGutter = true): TemplateResult {
		const store = this.store;
		if (!store) {
			return html``;
		}

		const isCollapsed = this.collapsedIssueIds.has(node.issue.id);
		const childListId = `issue-children-${node.issue.id}`;

		return html`
		<div class="issue-branch">
			<div class="issue-branch-row">
				${when(
					node.children.length > 0,
					() => html`
					<button
						aria-controls=${childListId}
						class="branch-toggle"
						data-id=${node.issue.id}
						aria-expanded=${String(!isCollapsed)}
						aria-label=${`${isCollapsed ? "Expand" : "Collapse"} sub-issues for ${node.issue.title}`}
						@click=${this.onToggleIssueBranch}
					>
						${isCollapsed ? "+" : "-"}
					</button>
					`,
					() => when(reserveBranchGutter, () => html`<span class="branch-spacer"></span>`, () => nothing)
				)}
				<button
					class=${`child issue-branch-head ${node.issue.id === this.activeChildId ? "is-active-ref" : ""}`}
					data-id=${node.issue.id}
					@click=${this.onSelectEntityClick}
				>
				<span class="idtag">${store.shortRef(node.issue)}</span>
				<span class="child-title">${node.issue.title}</span>
				<span class=${`badge ${store.badgeTone(node.issue.status)}`}>${node.issue.status}</span>
				</button>
			</div>
			${when(
				node.children.length > 0 && !isCollapsed,
				() => html`
				<div
					class="issue-branch-children"
					id=${childListId}
				>
					${repeat(node.children, (child) => child.issue.id, (child) => this.renderIssueBranch(child))}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	protected renderOverviewSection(
		sectionId: string,
		title: string,
		body: TemplateResult,
		options: { count?: string; sectionClassName?: string } = {}
	): TemplateResult {
		const isCollapsed = this.collapsedOverviewSectionIds.has(sectionId);
		const sectionClassName = options.sectionClassName ? `sec ${options.sectionClassName}` : "sec";

		return html`
		<section class=${sectionClassName}>
			<button
				class="sec-toggle"
				data-section-id=${sectionId}
				aria-expanded=${String(!isCollapsed)}
				@click=${this.onToggleOverviewSection}
			>
				<span class="sec-head">
					<span class="sec-title">${title}</span>
					${when(
						Boolean(options.count),
						() => html`<span class="sec-count">${options.count}</span>`,
						() => nothing
					)}
				</span>
				<span
					class=${classMap({ collapsed: isCollapsed, "sec-chevron": true })}
					aria-hidden="true"
				>
					>
				</span>
			</button>
			${when(!isCollapsed, () => body, () => nothing)}
		</section>
		`;
	}

	protected renderLine(entity: Entity) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<agent-issues-record-list-item
			.active=${entity.id === this.activeChildId}
			.record=${entity}
			.reference=${store.shortRef(entity)}
			.statusTone=${store.badgeTone(entity.status)}
			class=${classMap({ "is-active-ref": entity.id === this.activeChildId, line: true, "record-row": true })}
			data-id=${entity.id}
			@record-open=${this.onRecordOpen}
		></agent-issues-record-list-item>
		`;
	}

	protected getRecordView(tab: RecordTreeTab): RecordView {
		return tab === "issues" ? this.issueRecordView : this.userStoryRecordView;
	}

	protected relatedRecordsFor(record: Entity, bundle: InitiativeBundle): Entity[] {
		const store = this.store;
		const relatedRecords = new Map<string, Entity>();
		const add = (relatedRecord: Entity) => {
			if (relatedRecord.id !== record.id) {
				relatedRecords.set(relatedRecord.id, relatedRecord);
			}
		};

		for (const link of bundle.fixLinks) {
			if (link.issue.id === record.id) add(link.userStory);
			if (link.userStory.id === record.id) add(link.issue);
		}
		for (const link of bundle.subIssueLinks) {
			if (link.issue.id === record.id) add(link.parent);
			if (link.parent.id === record.id) add(link.issue);
		}
		for (const link of bundle.blockerLinks) {
			if (link.source.id === record.id) add(link.target);
			if (link.target.id === record.id) add(link.source);
		}
		for (const link of bundle.constrainsLinks) {
			if (link.adr.id === record.id) add(link.issue);
			if (link.issue.id === record.id) add(link.adr);
		}
		for (const relation of [...(store?.incomingRelationsFor(record.id) ?? []), ...(store?.outgoingRelationsFor(record.id) ?? [])]) {
			const relatedId = relation.fromId === record.id ? relation.toId : relation.fromId;
			const relatedRecord = store?.entityById.get().get(relatedId);
			if (relatedRecord) add(relatedRecord);
		}

		return [...relatedRecords.values()];
	}

	protected recordSearchRank(record: Entity, bundle: InitiativeBundle): number | null {
		const query = this.recordQuery.trim().toLowerCase();
		if (!query) {
			return 0;
		}

		const store = this.store;
		const relations = [...(store?.incomingRelationsFor(record.id) ?? []), ...(store?.outgoingRelationsFor(record.id) ?? [])];
		const { body, ...recordFields } = record;
		if (JSON.stringify(recordFields).toLowerCase().includes(query)) {
			return 0;
		}

		if (relations.some((relation) => JSON.stringify(relation).toLowerCase().includes(query))) {
			return 1;
		}

		const relatedRecords = this.relatedRecordsFor(record, bundle);
		if (relatedRecords.some((relatedRecord) => {
			const { body: relatedBody, ...relatedRecordFields } = relatedRecord;
			return JSON.stringify(relatedRecordFields).toLowerCase().includes(query);
		})) {
			return 1;
		}

		if ((body ?? "").toLowerCase().includes(query)) {
			return 2;
		}

		if (relatedRecords.some((relatedRecord) => (relatedRecord.body ?? "").toLowerCase().includes(query))) {
			return 3;
		}

		return null;
	}

	protected filterRecords(records: Entity[], bundle: InitiativeBundle): Entity[] {
		const rankedRecords: RankedRecord[] = [];

		for (const [index, record] of records.entries()) {
			if (this.recordStatus === "current-work" && record.kind === "issue" && record.status === "deferred") continue;
			if (this.recordStatus !== "all" && this.recordStatus !== "current-work" && record.status !== this.recordStatus) {
				continue;
			}

			const rank = this.recordSearchRank(record, bundle);
			if (rank !== null) {
				rankedRecords.push({ index, rank, record });
			}
		}

		return rankedRecords
			.sort((left, right) => left.rank - right.rank || left.index - right.index)
			.map(({ record }) => record);
	}

	protected filterIssueTree(nodes: IssueTreeNode[], matchingIssueIds: ReadonlySet<string>): IssueTreeNode[] {
		return nodes.flatMap((node) => {
			const children = this.filterIssueTree(node.children, matchingIssueIds);
			if (this.recordStatus === "current-work" && node.issue.status === "deferred") return children;
			if (!matchingIssueIds.has(node.issue.id) && children.length === 0) return [];

			return [{ ...node, children }];
		});
	}

	protected issueTreeForRecords(bundle: InitiativeBundle, records: Entity[]): IssueTreeNode[] {
		const orderedRecords = this.store?.sortIssuesByExpectedCompletion(records, bundle) ?? records;
		const recordsById = new Map(orderedRecords.map((record) => [record.id, record]));
		const positionById = new Map(orderedRecords.map((record, index) => [record.id, index]));
		const childrenByParentId = new Map<string, Entity[]>();
		const childIds = new Set<string>();

		for (const link of bundle.subIssueLinks) {
			const parent = recordsById.get(link.parent.id);
			const child = recordsById.get(link.issue.id);
			if (!parent || !child) continue;

			const children = childrenByParentId.get(parent.id) ?? [];
			children.push(child);
			childrenByParentId.set(parent.id, children);
			childIds.add(child.id);
		}

		const buildNode = (record: Entity, visitedIds: ReadonlySet<string>): IssueTreeNode => ({
			children: (childrenByParentId.get(record.id) ?? [])
				.filter((child) => !visitedIds.has(child.id))
				.sort((left, right) => positionById.get(left.id)! - positionById.get(right.id)!)
				.map((child) => buildNode(child, new Set([...visitedIds, child.id]))),
			issue: record
		});

		return orderedRecords.filter((record) => !childIds.has(record.id)).map((record) => buildNode(record, new Set([record.id])));
	}

	protected renderIssueTreeTab(bundle: InitiativeBundle, matchingRecords: Entity[]) {
		const matchingIssueIds = new Set(matchingRecords.map((record) => record.id));
		const nodes = this.filterIssueTree(this.issueTreeForRecords(bundle, bundle.issues), matchingIssueIds);

		return html`
		<div class="record-tree issue-tree">
			${repeat(nodes, (node) => node.issue.id, (node) => this.renderIssueBranch(node, false))}
		</div>
		`;
	}

	protected renderUserStoryTreeTab(bundle: InitiativeBundle, matchingStories: Entity[]) {
		const matchingStoryIds = new Set(matchingStories.map((story) => story.id));
		const matchingIssueIds = new Set(this.filterRecords(bundle.issues, bundle).map((issue) => issue.id));

		return html`
		<div class="record-tree">
			${bundle.userStories.flatMap((story) => {
				const issueTree = this.filterIssueTree(this.store?.issueTreeForStory(bundle, story.id) ?? [], matchingIssueIds);
				if (!matchingStoryIds.has(story.id) && issueTree.length === 0) return [];

				return html`
				<div class="story-tree-block">
					${this.renderLine(story)}
					${when(
						issueTree.length > 0,
						() => html`<div class="children issue-tree">${repeat(issueTree, (node) => node.issue.id, (node) => this.renderIssueBranch(node))}</div>`,
						() => nothing
					)}
				</div>
				`;
			})}
		</div>
		`;
	}

	protected renderRecordTab(
		title: string,
		records: Entity[],
		emptyMessage: string,
		bundle: InitiativeBundle,
		options: { treeTab?: RecordTreeTab; treeContent?: (matchingRecords: Entity[]) => TemplateResult } = {}
	) {
		const orderedRecords = title === "Issues" ? this.store?.sortIssuesByExpectedCompletion(records, bundle) ?? records : records;
		const filteredRecords = this.filterRecords(orderedRecords, bundle);
		const statuses = [...new Set(records.map((record) => record.status))].sort((left, right) => left.localeCompare(right));
		const treeView = options.treeTab ? this.getRecordView(options.treeTab) === "tree" : false;

		return html`
		<section class="record-browser record-tab">
			<agent-issues-record-filter-toolbar
				.countText=${`${filteredRecords.length} of ${records.length}`}
				.currentWorkFilter=${options.treeTab !== undefined || records.some((record) => record.kind === "issue")}
				.query=${this.recordQuery}
				.status=${this.recordStatus === "current-work" && !options.treeTab && !records.some((record) => record.kind === "issue") ? "all" : this.recordStatus}
				.statuses=${statuses}
				.title=${title}
				.treeTab=${options.treeTab ?? null}
				.treeView=${options.treeTab ? this.getRecordView(options.treeTab) : "list"}
				@record-query-change=${this.onRecordQueryChange}
				@record-status-change=${this.onRecordStatusChange}
				@record-view-change=${this.onRecordViewChange}
			></agent-issues-record-filter-toolbar>
			<div class="record-browser-list record-tab-list">
				${when(
					records.length === 0,
					() => html`<div class="empty-children">${emptyMessage}</div>`,
					() => when(
						filteredRecords.length > 0,
						() => when(
							treeView && options.treeContent,
							() => options.treeContent?.(filteredRecords) ?? nothing,
							() => repeat(filteredRecords, (record) => record.id, (record) => this.renderLine(record))
						),
						() => html`<div class="empty-children">No ${title.toLowerCase()} match this filter.</div>`
					)
				)}
			</div>
		</section>
		`;
	}

	protected renderContextTab(bundle: InitiativeBundle) {
		const context = this.store?.getContextForInitiative(bundle.initiative.id) ?? null;
		if (!context) {
			return html`
			<section class="record-tab">
				<div class="empty-children">No initiative context has been defined yet.</div>
			</section>
			`;
		}

		const query = this.recordQuery.trim().toLowerCase();
		const contextText = JSON.stringify(context.context).toLowerCase();
		const terms = context.terms.filter((term) => JSON.stringify(term).toLowerCase().includes(query));
		const showsContext = !query || contextText.includes(query);

		return html`
		<section class="record-tab">
			<div class="context-tab-toolbar">
				<label class="record-filter">
					<span class="record-filter-label">Filter context</span>
					<input
						placeholder="Filter context"
						type="search"
						.value=${this.recordQuery}
						@input=${this.onContextQueryInput}
					>
				</label>
				<span class="context-count">${terms.length} terms</span>
			</div>
			${when(
				showsContext || terms.length > 0,
				() => html`
				<div class="context-tab-summary">
					<h2>${context.context.title}</h2>
					<p>${context.context.summary}</p>
				</div>
				<div class="record-tab-list">
					${when(
						terms.length > 0,
						() => repeat(terms, (term) => term.term, (term) => html`
						<article class="context-term">
							<h3>${term.term}</h3>
							<p>${term.definition}</p>
							${when(
								term.avoid.length > 0,
								() => html`<p class="context-term-avoid">Avoid: ${term.avoid.join(", ")}</p>`,
								() => nothing
							)}
						</article>
						`),
						() => html`<div class="empty-children">No glossary terms match this filter.</div>`
					)}
				</div>
				`,
				() => html`<div class="empty-children">No initiative context matches this filter.</div>`
			)}
		</section>
		`;
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const bundle = this.activeBundle();
		if (!bundle) {
			return nothing;
		}

		const context = store.getContextForInitiative(bundle.initiative.id);
		const stats = store.initiativeStats(bundle);
		const requestedTab = store.initTab.get();
		const detailState = store.initiativeDetails.get().get(bundle.initiative.id);
		const tabState = store.initiativeTabs.get().get(`${bundle.initiative.id}:${requestedTab}`);
		const body = (bundle.initiative.body ?? "").trim();
		const bodySource = bundle.initiative.bodySource ?? "authored";
		const visibleGraphKinds = this.visibleGraphKinds;
		const graphFilterActive = visibleGraphKinds.size !== INITIATIVE_GRAPH_KINDS.length;
		const baseGraph = store.buildInitiativeGraph(bundle);
		const graph = graphFilterActive ? store.buildInitiativeGraph(bundle, visibleGraphKinds) : baseGraph;
		const hasProjectSummaryRollup = store.isSummaryInitiative(bundle.initiative.id);
		const rollup = store.projectSummaryInitiatives.get().find((candidate) => candidate.initiative.id === bundle.initiative.id);
		const debtSections = store.debtRecordSectionsFor(bundle.initiative.id);
		const debtRecords = hasProjectSummaryRollup && requestedTab === "debt"
			? bundle.entities.filter((entity) => entity.kind === "debt")
			: [...new Map(debtSections.flatMap((section) => section.records).map((record) => [record.id, record])).values()];
		const plans = bundle.entities
			.filter((entity) => entity.kind === "plan")
			.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || left.id.localeCompare(right.id));
			const tabCounts: Partial<Record<InitiativeTab, number>> = hasProjectSummaryRollup && rollup ? {
				adrs: rollup.adrCount ?? bundle.adrs.length,
				context: rollup.contextTermCount ?? context?.terms.length ?? 0,
				debt: rollup.debtCount ?? debtRecords.length,
				issues: rollup.totalIssueCount ?? rollup.issueCount,
				plans: rollup.planCount ?? plans.length,
				prds: rollup.prdCount ?? bundle.prds.length,
				userStories: rollup.userStoryCount
			} : {
				adrs: bundle.adrs.length,
				context: context?.terms.length ?? 0,
				debt: debtRecords.length,
				graph: baseGraph.nodes.length,
				issues: bundle.issues.length,
				plans: plans.length,
				prds: bundle.prds.length,
				userStories: bundle.userStories.length
			};
			const populatedInitiativeTabs: InitiativeTabDefinition[] = [
				{ label: "Overview", tab: "overview" },
				...INITIATIVE_TAB_DETAILS
					.filter(([candidate]) => {
						if (candidate === "graph") return baseGraph.edges.length > 0;
						if (candidate === "context") return context?.context.exists === true;
						return (tabCounts[candidate] ?? 0) > 0;
					})
					.map(([candidate, label]) => ({ label, recordCount: tabCounts[candidate], tab: candidate }))
			];
			const initiativeTabs: InitiativeTabDefinition[] = hasProjectSummaryRollup
				? [{ label: "Overview", tab: "overview" }, ...INITIATIVE_TAB_DETAILS.map(([tab, label]) => ({ label, recordCount: tabCounts[tab], tab }))]
				: populatedInitiativeTabs;
			const tab = initiativeTabs.some(({ tab: candidate }) => candidate === requestedTab) ? requestedTab : "overview";
			const tabLoading = tab === "overview"
				? detailState?.loading === true
				: tabState?.loading === true;

		return html`
		<div class="detail-inner">
			<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Initiatives</div>
			<h1 class="d-title">
				${bundle.initiative.title}
				<span class=${`badge ${store.badgeTone(bundle.initiative.status)}`}>${bundle.initiative.status}</span>
			</h1>

			<div class="kpis">
				<div class="kpi">
					<div class="k-num">${stats.stories}</div>
					<div class="k-label">User stories</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.issues}</div>
					<div class="k-label">Issues</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.pct}%</div>
					<div class="k-label">Complete</div>
				</div>
				<div class="kpi">
					<div class="k-num">${stats.adrs}</div>
					<div class="k-label">ADRs</div>
				</div>
			</div>

			<div class="bar">
				<span class="b-done" style=${`width:${stats.pct}%`}></span>
				<span class="b-open" style=${`width:${100 - stats.pct}%`}></span>
			</div>

			<div
				aria-label="Initiative details"
				class="subtabs"
				role="tablist"
			>
				${repeat(initiativeTabs, ({ tab: candidate }) => candidate, ({ label, recordCount, tab: candidate }) => html`
				<button
					aria-label=${candidate === tab && tabLoading
						? `${label}, loading`
						: recordCount === undefined ? label : `${label}: ${recordCount} records`}
					aria-controls=${this.getTabPanelId(candidate)}
					aria-selected=${String(tab === candidate)}
					class=${classMap({ active: tab === candidate, subtab: true })}
					data-tab=${candidate}
					id=${this.getTabButtonId(candidate)}
					@click=${this.onSetTab}
					role="tab"
				>
					<span class="subtab-label">
						<span class="subtab-label-text">${label}</span>
					</span>
					${when(
						candidate === tab && tabLoading,
						() => html`<span aria-hidden="true" class="subtab-spinner"></span>`,
						() => when(recordCount !== undefined, () => html`<span aria-hidden="true" class="subtab-count">${recordCount}</span>`, () => nothing)
					)}
				</button>
				`)}
			</div>

			<section
				aria-busy=${String(tabLoading)}
				aria-labelledby=${this.getTabButtonId(tab)}
				id=${this.getTabPanelId(tab)}
				role="tabpanel"
			>
			${when(
				requestedTab !== "overview" && Boolean(tabState?.error),
				() => html`
				<div class="local-state local-state-error" role="alert">
					<span>Could not load ${requestedTab}.</span>
					<button
						data-initiative-id=${bundle.initiative.id}
						data-tab=${requestedTab}
						@click=${this.onRetryLoad}
					>
						Retry
					</button>
				</div>
				`,
				() => nothing
			)}
			${choose(
				tab,
				[
					["overview", () => html`
					${when(
						Boolean(detailState?.error),
						() => html`
						<div class="local-state local-state-error" role="alert">
							<span>Could not load initiative details.</span>
							<button
								data-initiative-id=${bundle.initiative.id}
								@click=${this.onRetryLoad}
							>
								Retry
							</button>
						</div>
						`,
						() => nothing
					)}
					${when(
						body.length > 0,
						() => html`
						<div class="initiative-body overview-body">
							${when(bodySource === "generated", () => this.renderBodySourceNotice(), () => nothing)}
							<div class="ai-body">${unsafeHTML(renderMarkdownBody(body))}</div>
						</div>
						`,
						() => nothing
					)}
					${repeat(
						debtSections,
						(section) => section.key,
						(section) => this.renderOverviewSection(
							section.key,
							section.title,
							html`
							<div class="sec-body">
								${repeat(section.records, (record) => record.id, (record) => this.renderLine(record))}
							</div>
							`,
							{ count: String(section.records.length) }
						)
					)}
					`],
					["issues", () => this.renderRecordTab("Issues", bundle.issues, "No issues attached.", bundle, {
						treeContent: (matchingRecords) => this.renderIssueTreeTab(bundle, matchingRecords),
						treeTab: "issues"
					})],
					["plans", () => this.renderRecordTab("Plans", plans, "No Plans attached.", bundle)],
					["prds", () => this.renderRecordTab("PRDs", bundle.prds, "No PRDs attached.", bundle)],
					["adrs", () => this.renderRecordTab("ADRs", bundle.adrs, "No ADRs recorded.", bundle)],
					["context", () => html`
					${this.renderContextTab(bundle)}
					`],
					["userStories", () => this.renderRecordTab("User stories", bundle.userStories, "No user stories attached.", bundle, {
						treeContent: (matchingRecords) => this.renderUserStoryTreeTab(bundle, matchingRecords),
						treeTab: "userStories"
					})],
					["debt", () => this.renderRecordTab("Debt", debtRecords, "No debt recorded.", bundle)],
					["graph", () => html`
					<div class="ai-graph-wrap">
						<div class="graph-scroll-content">
							<div class="ai-graph-legend">
								<agent-issues-relationship-graph-filters
									.kinds=${INITIATIVE_GRAPH_KINDS}
									.visibleKinds=${visibleGraphKinds}
									@graph-kind-toggle=${this.onToggleGraphKind}
								></agent-issues-relationship-graph-filters>
								<span class="ai-graph-hint">Click any node to open it</span>
							</div>
							${when(
								graph.nodes.length > 0,
								() => html`
								<div class="graph-host">
									<agent-issues-relationship-graph
										.graph=${graph}
										@node-open=${this.onNodeOpen}
									></agent-issues-relationship-graph>
								</div>
								`,
								() => html`<div class="empty-children">No graph records match the selected filters.</div>`
							)}
						</div>
					</div>
					`]
				]
			)}
			</section>
		</div>
		`;
	}

	static styles = [
		issueBrowserTypographyStyles,
		issueBrowserControlStyles,
		css`
		:host {
			display: block;
		}
		.detail-inner {
			max-width: 920px;
			margin: 0 auto;
			padding: 28px 32px 64px;
		}
		.ai-crumbs {
			color: var(--muted);
			font-size: 12px;
		}
		.d-title {
			display: flex;
			gap: 12px;
			align-items: center;
			margin: 6px 0 0;
			font-size: 24px;
		}
		.kpis {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 12px;
			margin-top: 20px;
		}
		.kpi {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.k-num {
			font-size: 22px;
			font-weight: 700;
		}
		.k-label {
			margin-top: 2px;
			color: var(--muted);
			font-size: 12px;
		}
		.bar {
			display: flex;
			overflow: hidden;
			height: 8px;
			margin-top: 16px;
			border-radius: 999px;
			background: #eaeef2;
		}
		.b-done {
			background: var(--done);
		}
		.b-open {
			background: var(--success);
		}
		.subtabs {
			display: flex;
			flex-wrap: wrap;
			column-gap: 18px;
			row-gap: 4px;
			margin-top: 22px;
			border-bottom: 1px solid var(--border-muted);
		}
		.subtab {
			position: relative;
			flex: 0 0 auto;
			padding: 8px 24px;
			border: 0;
			border-bottom: 2px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
				text-align: center;
		}
		.subtab-label {
			display: inline-block;
		}
		.subtab-spinner {
			box-sizing: border-box;
			position: absolute;
			top: 2px;
			right: 4px;
			width: 14px;
			height: 14px;
			border: 2px solid var(--border);
			border-top-color: var(--accent);
			border-radius: 50%;
			animation: tab-loading-spin 700ms linear infinite;
		}
		@keyframes tab-loading-spin {
			to {
				transform: rotate(360deg);
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.subtab-spinner {
				animation: none;
			}
		}
		.subtab.active {
			border-bottom-color: #fd8c73;
			color: var(--text);
		}
		.subtab.active .subtab-label-text {
			text-shadow: -0.25px 0 currentColor, 0.25px 0 currentColor;
		}
		.record-tab {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.local-state {
			margin-top: 18px;
			padding: 12px 16px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
		}
		.local-state-error {
			display: flex;
			gap: 12px;
			align-items: center;
			justify-content: space-between;
			color: var(--danger);
		}
		.local-state-error button {
			padding: 6px 10px;
			border: 1px solid currentColor;
			border-radius: 6px;
			background: transparent;
			color: inherit;
			cursor: pointer;
			font: inherit;
		}
		.context-tab-toolbar {
			display: flex;
			gap: 12px;
			align-items: end;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border-muted);
		}
		.record-filter {
			display: grid;
			gap: 4px;
		}
		.record-filter:first-child {
			flex: 1;
		}
		.record-filter-label {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.record-filter input,
		.record-filter select {
			box-sizing: border-box;
			min-height: 32px;
			padding: 6px 8px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			font: inherit;
		}
		.context-count {
			padding-bottom: 7px;
			color: var(--muted);
			font-size: 12px;
			white-space: nowrap;
		}
		.record-tab-list {
			display: grid;
			gap: 8px;
			padding: 8px;
		}
		.record-tree {
			display: grid;
			gap: 8px;
		}
		.context-tab-summary {
			padding: 14px 16px 0;
		}
		.context-tab-summary h2,
		.context-term h3 {
			margin: 0;
			font-size: 14px;
		}
		.context-tab-summary p,
		.context-term p {
			margin: 6px 0 0;
			color: var(--muted);
			font-size: 13px;
		}
		.context-term .context-term-avoid {
			color: var(--danger);
		}
		.context-term {
			padding: 10px 8px;
			border-bottom: 1px solid var(--border-muted);
		}
		.context-term:last-child {
			border-bottom: 0;
		}
		.sec {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 12px;
			background: var(--surface);
		}
		.sec-toggle {
			display: flex;
			gap: 12px;
			align-items: center;
			justify-content: space-between;
			width: stretch;
			padding: 12px 16px;
			border: 0;
			border-bottom: 1px solid var(--border-muted);
			background: transparent;
			color: var(--text);
			cursor: pointer;
			font: inherit;
			text-align: left;
		}
		.sec-toggle:hover {
			background: var(--surface-muted);
		}
		.sec-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.sec-title {
			font-weight: 600;
		}
		.sec-count {
			color: var(--muted);
			font-size: 12px;
			font-weight: 400;
		}
		.sec-chevron {
			color: var(--muted);
			font-size: 14px;
			line-height: 1;
			transform: rotate(90deg);
			transition: transform 120ms ease;
		}
		.sec-chevron.collapsed {
			transform: rotate(0deg);
		}
		.sec-body {
			padding: 8px;
		}
		.overview-body {
			margin-top: 18px;
		}
		.context-sec {
			padding: 16px;
		}
		.story-head:hover,
		.child:hover {
			border-color: var(--accent);
			background: var(--surface-muted);
		}
		.story-head.is-active-ref,
		.child.is-active-ref,
		.handoff-focus.is-active-ref {
			border-color: var(--accent);
			background: var(--surface-muted);
			box-shadow: inset 3px 0 0 0 var(--accent);
		}
		.issue-branch {
			display: grid;
			gap: 8px;
		}
		.issue-branch-row {
			display: flex;
			gap: 8px;
			align-items: stretch;
		}
		.branch-toggle,
		.branch-spacer {
			flex-shrink: 0;
			width: 24px;
			height: 24px;
			margin-top: 8px;
		}
		.branch-toggle {
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
			line-height: 1;
		}
		.branch-toggle:hover {
			border-color: var(--accent);
			color: var(--accent);
		}
		.issue-branch-children {
			display: grid;
			gap: 8px;
			margin-left: 22px;
			padding-left: 12px;
			border-left: 1px solid var(--border-muted);
		}
		.children {
			padding: 0 8px 8px 28px;
		}
		.issue-tree {
			display: grid;
			gap: 8px;
		}
		.empty-children {
			padding: 12px 8px;
			color: var(--muted);
			font-size: 13px;
		}
		@media (max-width: 640px) {
			.detail-inner {
				padding: 20px 16px 40px;
			}
			.kpis {
				grid-template-columns: repeat(2, 1fr);
			}
			.context-tab-toolbar {
				align-items: stretch;
				flex-direction: column;
			}
			.context-count {
				padding-bottom: 0;
			}
		}
		.child {
			display: flex;
			gap: 12px;
			align-items: center;
			width: stretch;
			padding: 10px 12px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			color: inherit;
			cursor: pointer;
			font: inherit;
			text-align: left;
		}
		.child-title {
			flex: 1;
			font-weight: 600;
		}
		.idtag {
			min-width: 56px;
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.subtab-count {
			box-sizing: border-box;
			display: inline-grid;
			min-width: 16px;
			height: 16px;
			padding: 0 3px;
			place-items: center;
			position: absolute;
			top: 1px;
			right: 3px;
			border-radius: 50%;
			background: var(--accent);
			color: var(--surface);
			font-size: 10px;
			font-weight: 700;
			line-height: 1;
		}
		.handoff {
			padding: 14px 16px;
			border: 1px solid var(--border-muted);
			border-radius: 10px;
			background: var(--surface);
		}
		.handoff + .handoff {
			margin-top: 10px;
		}
		.handoff-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.handoff-summary {
			flex: 1;
			font-weight: 600;
		}
		.handoff-time {
			color: var(--muted);
			font-size: 12px;
		}
		.handoff-focus {
			display: inline-flex;
			gap: 8px;
			align-items: center;
			margin-top: 8px;
			padding: 4px 8px;
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: transparent;
			cursor: pointer;
			font: inherit;
			color: var(--text);
		}
		.handoff-focus-title {
			color: var(--muted);
			font-size: 13px;
		}
		.handoff-body {
			margin-top: 10px;
		}
		.ai-body-source {
			display: flex;
			gap: 10px;
			align-items: center;
			margin-bottom: 14px;
			padding: 10px 12px;
			border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
			border-radius: 10px;
			background: color-mix(in srgb, var(--surface-muted) 76%, white 24%);
		}
		.ai-body-source-badge {
			padding: 4px 8px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--accent) 16%, white 84%);
			color: var(--accent-strong, var(--accent));
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-body-source-copy {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.ai-body {
			max-width: 75ch;
			color: var(--text);
			font-size: 14px;
			line-height: 1.6;
		}
		.ai-body > :first-child {
			margin-top: 0;
		}
		.ai-body > :last-child {
			margin-bottom: 0;
		}
		.ai-body h1,
		.ai-body h2,
		.ai-body h3 {
			margin: 16px 0 8px;
			line-height: 1.3;
		}
		.ai-body p {
			margin: 8px 0;
		}
		.ai-body ul,
		.ai-body ol {
			margin: 8px 0;
			padding-left: 22px;
		}
		.ai-body code {
			padding: 1px 5px;
			border-radius: 4px;
			background: var(--border-muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.ai-body pre {
			padding: 12px;
			border-radius: 8px;
			background: #f6f8fa;
			overflow: auto;
		}
		.ai-body pre code {
			padding: 0;
			background: transparent;
		}
		.ai-body blockquote {
			margin: 8px 0;
			padding-left: 12px;
			border-left: 3px solid var(--border);
			color: var(--muted);
		}
		.ai-body a {
			color: var(--accent, #0969da);
		}
		.ai-graph-wrap {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background:
				radial-gradient(circle, rgba(208, 215, 222, 0.5) 1px, transparent 1px) 0 0 / 22px 22px,
				var(--surface);
			overflow: auto;
		}
			.graph-scroll-content,
			.graph-host {
				width: max-content;
				min-width: 100%;
			}
		.ai-graph-legend {
			display: flex;
			gap: 16px;
			flex-wrap: wrap;
			padding: 10px 14px;
			border-bottom: 1px solid var(--border-muted);
			font-size: 12px;
			color: var(--muted);
			background: var(--surface);
			position: sticky;
			top: 0;
			z-index: 1;
		}
		.ai-graph-legend .lg {
			display: inline-flex;
			gap: 6px;
			align-items: center;
		}
		.ai-graph-legend .sw {
			width: 10px;
			height: 10px;
			border-radius: 50%;
		}
		.ai-graph-hint {
			margin-left: auto;
		}
		.graph-host {
			padding: 0;
		}
		@media (max-width: 700px) {
			.kpis {
				grid-template-columns: repeat(2, 1fr);
			}
			.detail-inner {
				padding: 20px 16px 48px;
			}
		}
		`
	];
}

customElements.define("agent-issues-initiative-detail-view", InitiativeDetailView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-initiative-detail-view": InitiativeDetailView;
	}
}