import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import { createEntityDetailRenderer, type EntityDetailTab, type DetailIssueTreeNode as IssueTreeNode, type DetailRecordSection, type RecordView } from "./entity-detail-renderers.js";
import "./record-browser-elements.js";
import "./relationship-graph.js";
import "./relationship-graph-filters.js";
import { PROJECT_GRAPH_KINDS, type ContextDetails, type Entity, type InitiativeBundle, type IssueComment, type PlanEntry, type ProjectGraphKind, type RelationshipGraph } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

type RankedRecord = { index: number; rank: number; record: Entity };

class IssueDetailView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false },
		entityId: { attribute: false },
		cascade: { attribute: false },
		activeChildId: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;
	public entityId: string | null = null;
	public cascade = false;
	public activeChildId: string | null = null;
	protected collapsedIssueIds = new Set<string>();
	public entityDetailTab: EntityDetailTab = "overview";
	protected recordQuery = "";
	protected recordStatus = "current-work";
	protected issueRecordView: RecordView = "tree";
	protected userStoryRecordView: RecordView = "tree";
	public visibleGraphKinds = new Set<ProjectGraphKind>(PROJECT_GRAPH_KINDS);

	protected focusPlanEntry(entryId: string, selector = ".ai-plan-entry") {
		const element = [...this.renderRoot.querySelectorAll<HTMLElement>(selector)]
			.find((candidate) => candidate.dataset.planEntryId === entryId);
		if (!element) {
			return;
		}

		const disclosure = element.closest<HTMLDetailsElement>("details");
		if (disclosure) {
			disclosure.open = true;
		}
		element.classList.remove("is-plan-entry-target");
		void element.offsetWidth;
		element.classList.add("is-plan-entry-target");
		element.focus({ preventScroll: true });
		if (typeof element.scrollIntoView === "function") {
			element.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}

	protected focusIssueComment(commentId: string) {
		const element = [...this.renderRoot.querySelectorAll<HTMLElement>(".ai-comment")]
			.find((candidate) => candidate.dataset.commentId === commentId);
		if (!element) {
			return;
		}

		element.classList.remove("is-comment-target");
		void element.offsetWidth;
		element.classList.add("is-comment-target");
		element.focus({ preventScroll: true });
		if (typeof element.scrollIntoView === "function") {
			element.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}

	protected focusNestedTarget() {
		for (const element of this.renderRoot.querySelectorAll<HTMLElement>(".is-comment-target, .is-plan-entry-target")) {
			element.classList.remove("is-comment-target", "is-plan-entry-target");
		}

		const target = this.store?.selectedNestedTarget.get();
		if (target?.type === "plan-entry") {
			this.focusPlanEntry(target.id);
			return;
		}
		if (target?.type === "issue-comment") {
			this.focusIssueComment(target.id);
		}
	}

	protected override updated() {
		this.focusNestedTarget();
	}

	protected onBackClick = () => {
		this.store?.closeEntity();
	};

	protected onRetryEntityDetail = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.entityId;
		if (entityId) {
			void this.store?.retryEntityDetail(entityId);
		}
	};

	protected onSelectEntityClick = (event: Event) => {
		if (this.cascade) {
			const target = event.currentTarget as HTMLElement;
			const childId = target.dataset.id;
			if (!childId) {
				return;
			}

			if (target.dataset.crossLink === "true") {
				this.store?.reRootCascade(childId);
			} else if (this.entityId) {
				this.store?.drillCascade(this.entityId, childId);
			}

			return;
		}

		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (entityId) {
			this.store?.selectEntityFromRecord(entityId);
		}
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

	protected onSetIssueTab = (event: Event) => {
		const tab = (event.currentTarget as HTMLElement).dataset.tab as EntityDetailTab | undefined;
		if (!tab) return;

		this.entityDetailTab = tab;
		this.recordQuery = "";
		this.recordStatus = tab === "issues" || tab === "userStories" ? "current-work" : "all";
		const entityId = this.entityId ?? this.store?.selectedId.get();
		if (entityId) {
			this.store?.requestEntityTab(entityId, tab);
		}
		this.requestUpdate();
	};

	protected onRecordQueryChange = (event: Event) => {
		this.recordQuery = (event as CustomEvent<{ query: string }>).detail.query;
		this.requestUpdate();
	};

	protected onContextQueryInput = (event: Event) => {
		this.recordQuery = (event.target as HTMLInputElement).value;
		this.requestUpdate();
	};

	protected onRecordStatusChange = (event: Event) => {
		this.recordStatus = (event as CustomEvent<{ status: string }>).detail.status;
		this.requestUpdate();
	};

	protected onRecordViewChange = (event: Event) => {
		const { tab, view } = (event as CustomEvent<{ tab: string; view: RecordView }>).detail;

		if (tab === "issues") {
			this.issueRecordView = view;
		} else {
			this.userStoryRecordView = view;
		}
		this.requestUpdate();
	};

	protected onRecordOpen = (event: Event) => {
		const { crossLink, record } = (event as CustomEvent<{ crossLink: boolean; record: Entity }>).detail;
		if (this.cascade) {
			if (crossLink) {
				this.store?.reRootCascade(record.id);
			} else if (this.entityId) {
				this.store?.drillCascade(this.entityId, record.id);
			}
			return;
		}

		this.store?.selectEntityFromRecord(record.id);
	};

	protected onNodeOpen = (event: Event) => {
		const id = (event as CustomEvent<{ id: string }>).detail.id;
		if (id) this.store?.selectEntity(id);
	};

	protected onPlanEntryJump = (event: Event) => {
		const entryId = (event.currentTarget as HTMLElement).dataset.planEntryId;
		if (!entryId) return;

		this.focusPlanEntry(entryId, ".ai-plan-history .ai-plan-entry");
	};

	protected onToggleGraphKind = (event: Event) => {
		const kind = (event as CustomEvent<{ kind: ProjectGraphKind }>).detail.kind;
		if (!kind) return;

		const visibleKinds = new Set(this.visibleGraphKinds);
		if (visibleKinds.has(kind)) {
			visibleKinds.delete(kind);
		} else {
			visibleKinds.add(kind);
		}
		this.visibleGraphKinds = visibleKinds;
		this.requestUpdate();
	};

	public renderBodySourceNotice() {
		return html`
		<div class="ai-body-source ai-body-source-generated">
			<span class="ai-body-source-badge">Generated fallback</span>
			<span class="ai-body-source-copy">Generated from tracker metadata because no authored body was present.</span>
		</div>
		`;
	}

	public renderRef(record: Entity, crossLink = false) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class=${`ai-ref ${record.id === this.activeChildId ? "is-active-ref" : ""}`}
			data-id=${record.id}
			data-cross-link=${crossLink ? "true" : nothing}
			@click=${this.onSelectEntityClick}
		>
			<span class="r-id">${store.shortRef(record)}</span>
			<span class="r-title">${record.title}</span>
			<span class=${`badge ${store.badgeTone(record.status)}`}>${record.status}</span>
		</button>
		`;
	}

	protected renderRecordLine(record: Entity, crossLink = false) {
		const store = this.store;
		if (!store) return nothing;

		return html`
		<agent-issues-record-list-item
			.active=${record.id === this.activeChildId}
			.crossLink=${crossLink}
			.record=${record}
			.reference=${store.shortRef(record)}
			.statusTone=${store.badgeTone(record.status)}
			class=${classMap({ "is-active-ref": record.id === this.activeChildId, line: true, "record-row": true })}
			data-id=${record.id}
			@record-open=${this.onRecordOpen}
		></agent-issues-record-list-item>
		`;
	}

	protected getTabButtonId(entityId: string, tab: EntityDetailTab): string {
		return `issue-detail-${entityId}-${tab}-tab`;
	}

	protected getTabPanelId(entityId: string, tab: EntityDetailTab): string {
		return `issue-detail-${entityId}-${tab}-panel`;
	}

	protected relatedRecordsFor(record: Entity, bundle: InitiativeBundle | null): Entity[] {
		const store = this.store;
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
		for (const relation of [...(store?.incomingRelationsFor(record.id) ?? []), ...(store?.outgoingRelationsFor(record.id) ?? [])]) {
			const relatedId = relation.fromId === record.id ? relation.toId : relation.fromId;
			const relatedRecord = store?.entityById.get().get(relatedId);
			if (relatedRecord) add(relatedRecord);
		}

		return [...relatedRecords.values()];
	}

	protected recordSearchRank(record: Entity, bundle: InitiativeBundle | null): number | null {
		const query = this.recordQuery.trim().toLowerCase();
		if (!query) return 0;

		const store = this.store;
		const relations = [...(store?.incomingRelationsFor(record.id) ?? []), ...(store?.outgoingRelationsFor(record.id) ?? [])];
		const { body, ...recordFields } = record;
		if (JSON.stringify(recordFields).toLowerCase().includes(query)) return 0;
		if (relations.some((relation) => JSON.stringify(relation).toLowerCase().includes(query))) return 1;

		const relatedRecords = this.relatedRecordsFor(record, bundle);
		if (relatedRecords.some((relatedRecord) => {
			const { body: relatedBody, ...relatedRecordFields } = relatedRecord;
			return JSON.stringify(relatedRecordFields).toLowerCase().includes(query);
		})) return 1;
		if ((body ?? "").toLowerCase().includes(query)) return 2;
		if (relatedRecords.some((relatedRecord) => (relatedRecord.body ?? "").toLowerCase().includes(query))) return 3;

		return null;
	}

	protected filterRecords(records: Entity[], bundle: InitiativeBundle | null): Entity[] {
		const rankedRecords: RankedRecord[] = [];

		for (const [index, record] of records.entries()) {
			if (this.recordStatus === "current-work" && record.kind === "issue" && record.status === "deferred") continue;
			if (this.recordStatus !== "all" && this.recordStatus !== "current-work" && record.status !== this.recordStatus) continue;

			const rank = this.recordSearchRank(record, bundle);
			if (rank !== null) rankedRecords.push({ index, rank, record });
		}

		return rankedRecords
			.sort((left, right) => left.rank - right.rank || left.index - right.index)
			.map(({ record }) => record);
	}

	protected getRecordView(tab: "issues" | "userStories"): RecordView {
		return tab === "issues" ? this.issueRecordView : this.userStoryRecordView;
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

	public renderRecordBrowser(
		title: string,
		records: Entity[],
		emptyMessage: string,
		bundle: InitiativeBundle | null,
		options: {
			crossLinkRecordIds?: ReadonlySet<string>;
			treeTab?: "issues" | "userStories";
			treeContent?: (matchingRecords: Entity[]) => TemplateResult;
		} = {}
	) {
		const orderedRecords = title === "Issues" && bundle ? this.store?.sortIssuesByExpectedCompletion(records, bundle) ?? records : records;
		const filteredRecords = this.filterRecords(orderedRecords, bundle);
		const statuses = [...new Set(records.map((record) => record.status))].sort((left, right) => left.localeCompare(right));
		const treeView = options.treeTab ? this.getRecordView(options.treeTab) === "tree" : false;

		return html`
		<section class="ai-record-tab record-browser">
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
			<div class="ai-record-list record-browser-list">
				${when(
					records.length === 0,
					() => html`<div class="ai-empty">${emptyMessage}</div>`,
					() => when(
						filteredRecords.length > 0,
						() => when(
							treeView && options.treeContent,
							() => options.treeContent?.(filteredRecords) ?? nothing,
							() => repeat(filteredRecords, (record) => record.id, (record) => this.renderRecordLine(record, options.crossLinkRecordIds?.has(record.id)))
						),
						() => html`<div class="ai-empty">No ${title.toLowerCase()} match this filter.</div>`
					)
				)}
			</div>
		</section>
		`;
	}

	public renderContextTab(context: ContextDetails | null) {
		if (!context) {
			return html`<section class="ai-record-tab"><div class="ai-empty">No inherited initiative context is available.</div></section>`;
		}

		const query = this.recordQuery.trim().toLowerCase();
		const contextText = JSON.stringify(context.context).toLowerCase();
		const terms = context.terms.filter((term) => JSON.stringify(term).toLowerCase().includes(query));
		const showsContext = !query || contextText.includes(query);

		return html`
		<section class="ai-record-tab">
			<div class="ai-record-toolbar">
				<label class="ai-record-filter">
					<span>Filter context</span>
					<input
						placeholder="Filter context"
						type="search"
						.value=${this.recordQuery}
						@input=${this.onContextQueryInput}
					>
				</label>
				<span class="ai-record-count">${terms.length} terms</span>
			</div>
			${when(
				showsContext || terms.length > 0,
				() => html`
				<div class="ai-context-summary">
					<h2>${context.context.title}</h2>
					<p>${context.context.summary}</p>
				</div>
				<div class="ai-record-list">
					${when(
						terms.length > 0,
						() => repeat(terms, (term) => term.term, (term) => html`
						<article class="ai-context-term">
							<h3>${term.term}</h3>
							<p>${term.definition}</p>
							${when(term.avoid.length > 0, () => html`<p class="ai-context-avoid">Avoid: ${term.avoid.join(", ")}</p>`, () => nothing)}
						</article>
						`),
						() => html`<div class="ai-empty">No glossary terms match this filter.</div>`
					)}
				</div>
				`,
				() => html`<div class="ai-empty">No inherited context matches this filter.</div>`
			)}
		</section>
		`;
	}

	protected renderIssueTreeNode(node: IssueTreeNode): TemplateResult {
		const isCollapsed = this.collapsedIssueIds.has(node.issue.id);

		return html`
		<div class="ai-issue-tree-node">
			<div class="ai-issue-tree-row">
				${when(
					node.children.length > 0,
					() => html`
					<button
						class="branch-toggle"
						data-id=${node.issue.id}
						aria-expanded=${String(!isCollapsed) as "true" | "false"}
						@click=${this.onToggleIssueBranch}
					>
						${isCollapsed ? "+" : "-"}
					</button>
					`,
					() => html`<span class="branch-spacer"></span>`
				)}
				${this.renderRef(node.issue)}
			</div>
			${when(
				node.children.length > 0 && !isCollapsed,
				() => html`
				<div class="ai-issue-tree-children">
					${repeat(node.children, (child) => child.issue.id, (child) => this.renderIssueTreeNode(child))}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	public renderIssueTree(nodes: IssueTreeNode[]): TemplateResult {
		return html`${repeat(nodes, (node) => node.issue.id, (node) => this.renderIssueTreeNode(node))}`;
	}

	public renderIssueTreeForRecords(bundle: InitiativeBundle, records: Entity[], matchingRecords: Entity[]): TemplateResult {
		const matchingIssueIds = new Set(matchingRecords.map((record) => record.id));
		return this.renderIssueTree(this.filterIssueTree(this.issueTreeForRecords(bundle, records), matchingIssueIds));
	}

	public renderRefSections(sections: DetailRecordSection[]): TemplateResult {
		return html`
		${repeat(
			sections,
			(section) => section.key,
			(section) => html`
			<section class="ai-sec">
				<h2>${section.title}</h2>
				<div class="ai-refs">
					${repeat(section.records, (record) => record.id, (record) => this.renderRef(record, section.crossLink))}
				</div>
			</section>
			`
		)}
		`;
	}

	public renderGraphTab(graph: RelationshipGraph): TemplateResult {
		return html`
		<div class="ai-graph-wrap">
			<div class="ai-graph-legend">
				<agent-issues-relationship-graph-filters
					.kinds=${[...PROJECT_GRAPH_KINDS]}
					.visibleKinds=${this.visibleGraphKinds}
					@graph-kind-toggle=${this.onToggleGraphKind}
				></agent-issues-relationship-graph-filters>
			</div>
			${when(
				graph.nodes.length > 0,
				() => html`
				<div class="ai-graph-host">
					<agent-issues-relationship-graph
						.graph=${graph}
						@node-open=${this.onNodeOpen}
					></agent-issues-relationship-graph>
				</div>
				`,
				() => html`<div class="ai-empty">No graph records match the selected filters.</div>`
			)}
		</div>
		`;
	}

	public renderTabButton(tab: EntityDetailTab, label: string, active: boolean, recordCount?: number): TemplateResult {
		const entityId = this.entityId ?? this.store?.selectedId.get();
		const accessibleLabel = recordCount === undefined ? label : `${label}: ${recordCount} records`;
		if (!entityId) return html``;

		return html`
		<button
			aria-label=${accessibleLabel}
			aria-controls=${this.getTabPanelId(entityId, tab)}
			aria-selected=${String(active)}
			class=${classMap({ active, "ai-subtab": true })}
			data-tab=${tab}
			id=${this.getTabButtonId(entityId, tab)}
			@click=${this.onSetIssueTab}
			role="tab"
		>
			<span class="ai-subtab-label">${label}</span>
			${when(recordCount !== undefined, () => html`<span aria-hidden="true" class="ai-subtab-count">${recordCount}</span>`, () => nothing)}
		</button>
		`;
	}

	protected displayUser(userId: string): string {
		return this.store?.displayUser(userId, this.entityId ?? this.store.selectedId.get() ?? "") ?? userId;
	}

	public renderIssueComment(comment: IssueComment): TemplateResult {
		return html`
		<article
			class="ai-comment"
			data-comment-id=${comment.id}
			tabindex="-1"
		>
			<div class="ai-comment-reference">${comment.reference}</div>
			${when(
				comment.tombstone,
				() => html`<div class="ai-comment-deleted">Deleted ${comment.updatedAt}</div>`,
				() => html`<div class="ai-comment-body">${comment.body ?? ""}</div>`
			)}
			<div class="ai-comment-provenance">
				Created by ${this.displayUser(comment.createdBy)}
				Updated by ${this.displayUser(comment.updatedBy)}
			</div>
			${when(
				comment.referencedIssueIds.length > 0,
				() => html`<div class="ai-comment-references">References: ${comment.referencedIssueIds.join(", ")}</div>`,
				() => nothing
			)}
		</article>
		`;
	}

	public renderPlanEntry(entry: PlanEntry): TemplateResult {
		const planEntries = this.store?.planEntriesFor(entry.planId) ?? [];
		const entriesById = new Map(planEntries.map((candidate) => [candidate.id, candidate]));
		const referencedEntities = entry.referencedEntityIds.map((id) => {
			const entity = this.store?.entityForId(id);
			return { entity, id };
		});
		const supersededEntries = entry.supersededEntryIds.map((id) => {
			const supersededEntry = entriesById.get(id);
			return {
				id,
				label: supersededEntry?.shortReference ?? supersededEntry?.reference ?? id,
				reference: supersededEntry?.reference ?? id
			};
		});
		return html`
		<article
			class="ai-plan-entry"
			data-plan-entry-id=${entry.id}
			tabindex="-1"
		>
			<header class="ai-plan-entry-header">
				<span
					class="ai-plan-entry-reference"
					title=${entry.reference}
				>
					${entry.shortReference ?? entry.reference}
				</span>
			</header>
			${when(
				entry.tombstone,
				() => html`<div class="ai-plan-entry-deleted">Deleted entry</div>`,
				() => html`<div class="ai-plan-entry-body">${entry.body ?? ""}</div>`
			)}
			${when(
				referencedEntities.length > 0 || supersededEntries.length > 0,
				() => html`
				<footer class="ai-plan-entry-meta">
				${when(
					referencedEntities.length > 0,
					() => html`
					<div class="ai-plan-entry-meta-row">
						<span class="ai-plan-entry-meta-label">References</span>
						<span class="ai-plan-entry-link-list">
							${repeat(
								referencedEntities,
								({ id }) => id,
								({ entity, id }) => when(
									entity !== null,
									() => html`
									<button
										class="ai-plan-entry-link"
										data-id=${id}
										@click=${this.onSelectEntityClick}
									>
										${this.store?.shortRef(entity!)} ${entity!.title}
									</button>
									`,
									() => html`<span class="ai-plan-entry-unresolved">${id}</span>`
								)
							)}
						</span>
					</div>
					`,
					() => nothing
				)}
				${when(
					supersededEntries.length > 0,
					() => html`
					<div class="ai-plan-entry-meta-row">
						<span class="ai-plan-entry-meta-label">Supersedes</span>
						<span class="ai-plan-entry-link-list">
							${repeat(
								supersededEntries,
								({ id }) => id,
								({ id, label, reference }) => html`
								<button
									aria-label=${`Go to superseded Plan entry ${label}`}
									class="ai-plan-entry-link"
									data-plan-entry-id=${id}
									title=${reference}
									@click=${this.onPlanEntryJump}
								>
									${label}
								</button>
								`
							)}
						</span>
					</div>
					`,
					() => nothing
				)}
				</footer>
				`,
				() => nothing
			)}
		</article>
		`;
	}

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const entityId = this.entityId ?? store.selectedId.get();
		const entity = store.entityForId(entityId);
		const detailState = entityId ? store.entityDetails.get().get(entityId) : null;
		if (!entity) {
			return html`
			<div class="detail-inner">
				${when(
					detailState?.error,
					() => html`
					<div class="ai-empty">
						<p>Could not load this record.</p>
						<button
							class="ai-back"
							data-entity-id=${entityId ?? nothing}
							@click=${this.onRetryEntityDetail}
						>
							Retry
						</button>
					</div>
					`,
					() => html`<div class="ai-empty">Loading record...</div>`
				)}
			</div>
			`;
		}
		if (store.selectedNestedTarget.get()?.type === "plan-entry") {
			this.entityDetailTab = "plan";
		}

		const bundle = store.bundleForEntityId(entityId);
		const isAdrSection = store.activeSection.get() === "adrs";
		const scopeLabel = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Initiatives";
		const backLabel = store.entityBackTarget.get()?.title ?? scopeLabel;
		const crumbScope = isAdrSection ? "ADRs" : bundle?.initiative.title ?? "Workspace";
		const meta = store.detailMetaFor(entity.id);
		const renderer = createEntityDetailRenderer(store, entity, this);

		return html`
		<div class="detail-inner">
			${when(
				detailState?.loading === true,
				() => html`<p class="ai-load-state">Refreshing record...</p>`,
				() => nothing
			)}
			${when(
				detailState?.error,
				() => html`
				<div class="ai-load-state ai-load-error">
					<span>Could not refresh this record.</span>
					<button
						class="ai-back"
						data-entity-id=${entity.id}
						@click=${this.onRetryEntityDetail}
					>
						Retry
					</button>
				</div>
				`,
				() => nothing
			)}
			${when(
				!this.cascade,
				() => html`
				<button
					class="ai-back"
					@click=${this.onBackClick}
				>
					← Back to ${backLabel}
				</button>
				`
			)}
			<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · ${crumbScope}</div>
			<div class="ai-kind">${store.formatKindLabel(entity.kind)}</div>
			<h1 class="ai-d-title">
				${entity.title}
				<span class=${`badge ${store.badgeTone(entity.status)}`}>${entity.status}</span>
				<span class="ai-id">${store.shortRef(entity)}</span>
			</h1>
			<div class="ai-meta">
				${repeat(
					meta,
					([key]) => key,
					([key, value]) => html`
					<div class="m">
						<span class="k">${key}</span>
						<span class="v">${value}</span>
					</div>
					`
				)}
			</div>
			${renderer.renderDetail()}
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
		.ai-back {
			display: inline-flex;
			gap: 6px;
			align-items: center;
			margin-bottom: 12px;
			border: 0;
			background: none;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.ai-back:hover {
			color: var(--accent);
		}
		.ai-load-state {
			display: flex;
			gap: 8px;
			align-items: center;
			margin: 0 0 12px;
			color: var(--muted);
			font-size: 13px;
		}
		.ai-load-error {
			color: var(--danger);
		}
		.ai-crumbs {
			margin-bottom: 12px;
			color: var(--muted);
			font-size: 12px;
		}
		.ai-kind {
			color: var(--muted);
			font-size: 12px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-d-title {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			align-items: center;
			margin: 6px 0 0;
			font-size: 24px;
		}
		.ai-d-title .ai-id {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 14px;
			font-weight: 400;
		}
		.ai-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 28px;
			margin: 16px 0 4px;
			padding: 14px 0;
			border-top: 1px solid var(--border-muted);
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-meta .m {
			display: flex;
			flex-direction: column;
			gap: 3px;
		}
		.ai-meta .m .k {
			color: var(--muted);
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-meta .m .v {
			font-weight: 600;
		}
		.ai-subtabs {
			display: flex;
			flex-wrap: wrap;
			gap: 18px;
			margin-top: 22px;
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-subtab {
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
		.ai-subtab-count {
			box-sizing: border-box;
			display: inline-grid;
			min-width: 16px;
			height: 16px;
			padding: 0 3px;
			place-items: center;
			position: absolute;
			top: 1px;
			right: 1px;
			border-radius: 50%;
			background: var(--accent);
			color: var(--surface);
			font-size: 10px;
			font-weight: 700;
			line-height: 1;
		}
		.ai-subtab.active {
			border-bottom-color: var(--accent);
			color: var(--text);
			font-weight: 600;
		}
		.ai-record-tab {
			margin-top: 18px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.ai-record-toolbar {
			display: flex;
			gap: 12px;
			align-items: end;
			padding: 12px 16px;
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-record-filter {
			display: grid;
			gap: 4px;
		}
		.ai-record-filter:first-child {
			flex: 1;
		}
		.ai-record-filter > span {
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.ai-record-filter input,
		.ai-record-filter select {
			box-sizing: border-box;
			min-height: 32px;
			padding: 6px 8px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			font: inherit;
		}
		.ai-record-view-toggle {
			display: inline-flex;
			align-self: end;
			overflow: hidden;
			border: 1px solid var(--border);
			border-radius: 6px;
		}
		.ai-record-view-button {
			min-height: 32px;
			padding: 6px 10px;
			border: 0;
			border-right: 1px solid var(--border);
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.ai-record-view-button:last-child {
			border-right: 0;
		}
		.ai-record-view-button.active {
			background: var(--surface-muted);
			color: var(--text);
			font-weight: 600;
		}
		.ai-record-count {
			padding-bottom: 7px;
			color: var(--muted);
			font-size: 12px;
			white-space: nowrap;
		}
		.ai-record-list,
		.ai-record-tree {
			display: grid;
			gap: 8px;
			padding: 8px;
		}
		.ai-context-summary {
			padding: 14px 16px 0;
		}
		.ai-context-summary h2,
		.ai-context-term h3 {
			margin: 0;
			font-size: 14px;
		}
		.ai-context-summary p,
		.ai-context-term p {
			margin: 6px 0 0;
			color: var(--muted);
			font-size: 13px;
		}
		.ai-context-avoid {
			color: var(--danger);
		}
		.ai-context-term {
			padding: 10px 8px;
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-context-term:last-child {
			border-bottom: 0;
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
		.ai-graph-legend {
			display: flex;
			gap: 16px;
			flex-wrap: wrap;
			padding: 10px 14px;
			border-bottom: 1px solid var(--border-muted);
			background: var(--surface);
		}
		.ai-graph-host {
			width: max-content;
			min-width: 100%;
			padding: 14px 0;
		}
		.ai-sec {
			margin-top: 24px;
		}
		.ai-sec h2 {
			margin: 0 0 10px;
			font-size: 15px;
		}
		.ai-conversation {
			display: grid;
			gap: 12px;
		}
		.ai-comment {
			padding: 12px;
			border: 1px solid var(--border-muted);
			border-radius: 6px;
		}
		.ai-comment:focus {
			outline: 2px solid var(--focus-ring);
			outline-offset: -2px;
		}
		.ai-comment.is-comment-target {
			animation: plan-entry-target 1.8s ease-out;
		}
		.ai-comment-reference,
		.ai-comment-references,
		.ai-comment-provenance,
		.ai-comment-deleted {
			color: var(--muted);
			font-size: 12px;
		}
		.ai-comment-reference,
		.ai-comment-references {
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		}
		.ai-comment-deleted {
			margin: 8px 0;
			font-style: italic;
		}
		.ai-comment-provenance {
			display: grid;
			gap: 2px;
		}
		.ai-comment-body {
			margin: 8px 0;
			white-space: pre-wrap;
		}
		.ai-plan-current,
		.ai-plan-history {
			display: grid;
			gap: 12px;
		}
		.ai-plan-group {
			border-top: 1px solid var(--border-muted);
		}
		.ai-plan-group:last-of-type {
			border-bottom: 1px solid var(--border-muted);
		}
		.ai-plan-group summary,
		.ai-plan-history summary {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			padding: 10px 0;
			font-size: 13px;
			font-weight: 700;
			cursor: pointer;
		}
		.ai-plan-count {
			min-width: 24px;
			padding: 2px 7px;
			border-radius: 999px;
			background: var(--surface-strong);
			color: var(--muted);
			font-size: 11px;
			text-align: center;
		}
		.ai-plan-entries {
			display: grid;
			gap: 2px;
			overflow: hidden;
			margin-bottom: 12px;
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: var(--border-muted);
		}
		@supports (row-rule: 2px solid transparent) {
			.ai-plan-entries {
				background: transparent;
				row-rule: 2px solid var(--border-muted);
			}
			.ai-plan-entries[data-plan-group="decisions"] {
				row-rule: none;
			}
		}
		.ai-plan-entries[data-plan-group="decisions"] {
			gap: 12px;
			overflow: visible;
			padding: 10px;
			border: 0;
			border-radius: 0;
			background: var(--surface-muted);
		}
		.ai-plan-entry {
			display: grid;
			gap: 10px;
			padding: 14px 16px;
			background: var(--surface);
		}
		.ai-plan-decision-pair {
			display: grid;
			overflow: hidden;
			border: 1px solid var(--border-muted);
			border-radius: 6px;
			background: var(--surface);
			box-shadow: 0 1px 2px rgba(31, 35, 40, 0.05);
		}
		.ai-plan-decision-question {
			background: var(--surface-muted);
		}
		.ai-plan-decision-question .ai-plan-entry {
			background: transparent;
		}
		.ai-plan-decision-answer {
			border-top: 2px solid var(--border-muted);
		}
		.ai-plan-decision-pair-label {
			padding: 12px 16px 0;
			color: var(--muted);
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ai-plan-entry:focus {
			outline: 2px solid var(--focus-ring);
			outline-offset: -2px;
		}
		.ai-plan-entry.is-plan-entry-target {
			animation: plan-entry-target 1.8s ease-out;
		}
		.ai-plan-entry-meta {
			display: grid;
			gap: 8px;
			padding-top: 10px;
			border-top: 1px solid var(--border-muted);
			color: var(--muted);
			font-size: 11px;
		}
		.ai-plan-entry-header {
			display: flex;
			align-items: center;
		}
		.ai-plan-entry-reference {
			display: inline-flex;
			width: max-content;
			padding: 3px 8px;
			border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
			border-radius: 999px;
			background: var(--accent-soft);
			color: var(--accent);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 10px;
			font-weight: 700;
		}
		.ai-plan-entry-meta-row {
			display: grid;
			grid-template-columns: 70px minmax(0, 1fr);
			gap: 10px;
			align-items: baseline;
		}
		.ai-plan-entry-link-list {
			display: flex;
			flex-wrap: wrap;
			gap: 5px 12px;
			min-width: 0;
			overflow-wrap: anywhere;
		}
		.ai-plan-entry-meta-label {
			font-weight: 700;
		}
		.ai-plan-entry-link {
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--accent);
			cursor: pointer;
			font: inherit;
			font-weight: 600;
			text-align: left;
		}
		.ai-plan-entry-link:hover {
			text-decoration: underline;
		}
		.ai-plan-entry-link:focus-visible {
			outline: 2px solid var(--focus-ring);
			outline-offset: 2px;
		}
		.ai-plan-entry-unresolved {
			overflow-wrap: anywhere;
		}
		.ai-plan-entry-deleted {
			color: var(--muted);
			font-style: italic;
		}
		.ai-plan-entry-body {
			line-height: 1.55;
			overflow-wrap: anywhere;
			white-space: pre-wrap;
		}
		@keyframes plan-entry-target {
			0% {
				background: color-mix(in srgb, var(--accent-soft) 72%, var(--surface));
				box-shadow: inset 3px 0 0 var(--accent);
			}
			100% {
				background: var(--surface);
				box-shadow: inset 3px 0 0 transparent;
			}
		}
		.ai-body {
			max-width: 75ch;
			line-height: 1.6;
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
		.ai-body > :first-child {
			margin-top: 0;
		}
		.ai-body > :last-child {
			margin-bottom: 0;
		}
		.ai-body h1,
		.ai-body h2,
		.ai-body h3 {
			margin: 22px 0 10px;
			line-height: 1.3;
		}
		.ai-body h1 {
			font-size: 19px;
		}
		.ai-body h2 {
			font-size: 16px;
		}
		.ai-body h3 {
			font-size: 14px;
		}
		.ai-body p {
			margin: 0 0 12px;
			color: var(--text);
		}
		.ai-body ul,
		.ai-body ol {
			margin: 0 0 12px;
			padding-left: 18px;
			line-height: 1.7;
		}
		.ai-body a {
			color: var(--accent);
		}
		.ai-body code {
			padding: 2px 5px;
			border-radius: 5px;
			background: var(--surface-muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 0.9em;
		}
		.ai-body pre {
			overflow: auto;
			margin: 0 0 12px;
			padding: 12px 14px;
			border: 1px solid var(--border-muted);
			border-radius: 8px;
			background: var(--surface-muted);
		}
		.ai-body pre code {
			padding: 0;
			background: none;
		}
		.ai-body blockquote {
			margin: 0 0 12px;
			padding: 2px 0 2px 14px;
			border-left: 3px solid var(--border);
			color: var(--muted);
		}
		.ai-refs {
			display: grid;
			gap: 8px;
		}
		.ai-story-block {
			display: grid;
			gap: 8px;
		}
		.ai-story-issues {
			display: grid;
			gap: 8px;
			margin-left: 18px;
			padding-left: 14px;
			border-left: 1px solid var(--border-muted);
		}
		.ai-issue-tree {
			display: grid;
			gap: 8px;
		}
		.ai-issue-tree-node {
			display: grid;
			gap: 8px;
		}
		.ai-issue-tree-row {
			display: flex;
			gap: 8px;
			align-items: flex-start;
		}
		.ai-issue-tree-children {
			display: grid;
			gap: 8px;
			margin-left: 18px;
			padding-left: 14px;
			border-left: 1px solid var(--border-muted);
		}
		.branch-toggle,
		.branch-spacer {
			flex-shrink: 0;
			width: 24px;
			height: 24px;
			margin-top: 10px;
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
		.ai-ref {
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
		.ai-ref:hover {
			border-color: var(--accent);
			background: var(--surface-muted);
		}
		.ai-ref.is-active-ref {
			border-color: var(--accent);
			background: var(--surface-muted);
			box-shadow: inset 3px 0 0 0 var(--accent);
		}
		.ai-ref .r-id {
			min-width: 56px;
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.ai-ref .r-title {
			flex: 1;
			font-weight: 600;
		}
		.ai-empty {
			color: var(--muted);
			font-size: 13px;
		}
		@media (max-width: 700px) {
			.detail-inner {
				padding: 20px 16px 48px;
			}
			.ai-record-toolbar {
				align-items: stretch;
				flex-direction: column;
			}
			.ai-record-count {
				padding-bottom: 0;
			}
			.ai-body-source {
				flex-direction: column;
				align-items: flex-start;
			}
		}
		`
	];
}

customElements.define("agent-issues-detail-view", IssueDetailView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-detail-view": IssueDetailView;
	}
}
