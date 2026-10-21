import { afterEach, describe, expect, it, vi } from "vitest";

import "./issue-detail-view.js";
import type { ContextDetails, Entity, InitiativeBundle, Relation, Snapshot } from "../models.js";
import { AgentIssuesStore } from "../services/agent-issues-store.js";

function makeEntity(overrides: Partial<Entity> & Pick<Entity, "id">): Entity {
	return {
		body: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		kind: "issue",
		status: "todo",
		title: `Title for ${overrides.id}`,
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides
	};
}

function makeRelation(fromId: string, type: string, toId: string): Relation {
	return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
}

function makeBundle(initiative: Entity, overrides: Partial<InitiativeBundle> = {}): InitiativeBundle {
	return {
		adrs: [],
		blockerLinks: [],
		constrainsLinks: [],
		entities: [initiative],
		fixLinks: [],
		initiative,
		issues: [],
		prds: [],
		subIssueLinks: [],
		userStories: [],
		...overrides
	};
}

function makeSharedContext(): ContextDetails {
	return {
		context: {
			createdAt: null,
			exists: false,
			key: "shared",
			scopeEntityId: null,
			scopeKind: "default",
			scopeLabel: "Shared",
			summary: "",
			title: "Shared Context",
			updatedAt: null
		},
		terms: []
	};
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		contexts: { initiatives: [], shared: makeSharedContext() },
		entities: [],
		generatedAt: "2026-01-01T00:00:00.000Z",
		initiatives: [],
		issueComments: {},
		orphans: [],
		projectAdrs: [],
		relations: [],
		users: [],
		...overrides
	};
}

function makeStore(snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.snapshot.set(snapshot);
	return store;
}

async function mountDetail(store: AgentIssuesStore) {
	const view = document.createElement("agent-issues-detail-view");
	view.store = store;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

function tabLabels(view: HTMLElement) {
	return [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
		.map((tab) => tab.querySelector(".ai-subtab-label")?.textContent?.trim());
}

function tabRecordCounts(view: HTMLElement) {
	return Object.fromEntries(
		[...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
			.flatMap((tab) => {
				const count = tab.querySelector(".ai-subtab-count")?.textContent?.trim();
				return count ? [[tab.dataset.tab, count]] : [];
			})
	);
}

function updateIssueRecordFilter(view: HTMLElement, detail: { query?: string; status?: string }) {
	const toolbar = view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar");
	if (detail.query !== undefined) {
		toolbar?.dispatchEvent(new CustomEvent("record-query-change", { detail: { query: detail.query } }));
	}
	if (detail.status !== undefined) {
		toolbar?.dispatchEvent(new CustomEvent("record-status-change", { detail: { status: detail.status } }));
	}
}

function updateIssueRecordView(view: HTMLElement, tab: "issues" | "userStories", viewMode: "list" | "tree") {
	view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.dispatchEvent(
		new CustomEvent("record-view-change", { detail: { tab, view: viewMode } })
	);
}

afterEach(() => {
	document.body.replaceChildren();
	window.location.hash = "";
	vi.restoreAllMocks();
});

describe("entity detail pane", () => {
	it("provides User stories with shared tabs and their linked issue hierarchy", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ body: "User story overview content.", id: "US1", kind: "userStory", status: "draft", title: "Complete the workflow" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Implement the workflow" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Verify the workflow" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: parentIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(makeSnapshot({ entities: [initiative, story, parentIssue, childIssue], initiatives: [bundle] }));
		store.selectEntity(story.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')?.textContent).toContain("User story overview content.");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLElement & { treeView: string }>("agent-issues-record-filter-toolbar")?.treeView).toBe("tree");
	});

	it("provides ADRs with the shared record tabs, filters, and issue hierarchy", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const adr = makeEntity({ body: "ADR overview content.", id: "ADR1", kind: "adr", status: "current", title: "Use shared detail tabs" });
		const parentIssue = makeEntity({ category: "searchable architecture field", id: "ISS1", kind: "issue", status: "todo", title: "Apply decision" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Verify decision" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Decision outcome" });
		const bundle = makeBundle(initiative, {
			adrs: [adr],
			constrainsLinks: [{ adr, issue: parentIssue }],
			fixLinks: [{ issue: parentIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(makeSnapshot({ entities: [initiative, adr, parentIssue, childIssue, story], initiatives: [bundle] }));
		store.selectEntity(adr.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues", "User stories"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')?.textContent).toContain("ADR overview content.");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		updateIssueRecordFilter(view, { query: "searchable architecture field" });
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id)).toEqual(["ISS1", "ISS2"]);

		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-record-tree .ai-issue-tree-children .ai-ref[data-id="ISS2"]')).not.toBeNull();

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="userStories"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLElement & { treeView: string }>("agent-issues-record-filter-toolbar")?.treeView).toBe("tree");
		updateIssueRecordView(view, "userStories", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="US1"]')).not.toBeNull();
	});

	it("orders the entity Issues tab by expected completion through blockers", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use completion order" });
		const availableIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Available issue" });
		const blockedIssue = makeEntity({ id: "ISS2", kind: "issue", status: "blocked", title: "Blocked issue" });
		const laterIssue = makeEntity({ id: "ISS3", kind: "issue", status: "blocked", title: "Later issue" });
		const completedBlocker = makeEntity({ id: "ISS4", kind: "issue", status: "done", title: "Completed blocker" });
		const completedIssue = makeEntity({ id: "ISS5", kind: "issue", status: "done", title: "Completed issue" });
		const bundle = makeBundle(initiative, {
			adrs: [adr],
			blockerLinks: [
				{ source: completedBlocker, target: completedIssue },
				{ source: availableIssue, target: blockedIssue },
				{ source: blockedIssue, target: laterIssue }
			],
			constrainsLinks: [
				{ adr, issue: laterIssue },
				{ adr, issue: blockedIssue },
				{ adr, issue: availableIssue },
				{ adr, issue: completedIssue },
				{ adr, issue: completedBlocker }
			],
			issues: [laterIssue, blockedIssue, availableIssue, completedIssue, completedBlocker]
		});
		const store = makeStore(makeSnapshot({
			entities: [initiative, adr, availableIssue, blockedIssue, laterIssue, completedBlocker, completedIssue],
			initiatives: [bundle]
		}));
		store.selectEntity(adr.id);
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;

		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id))
			.toEqual(["ISS4", "ISS5", "ISS1", "ISS2", "ISS3"]);

		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll(".ai-record-tree .ai-ref .r-id") ?? []].map((record) => record.textContent?.trim()))
			.toEqual([completedBlocker, completedIssue, availableIssue, blockedIssue, laterIssue].map((issue) => store.shortRef(issue)));
	});

	it("provides filterable record tabs and ranked issue and user-story trees", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ category: "priority phrase", id: "ISS_FULL_REFERENCE_123", kind: "issue", status: "todo", title: "Parent issue" });
		const childIssue = makeEntity({ body: "priority phrase appears only in this body", id: "ISS2", kind: "issue", status: "done", title: "Child issue" });
		const deferredIssue = makeEntity({ id: "ISS3", kind: "issue", status: "deferred", title: "Later child" });
		const nestedIssue = makeEntity({ id: "ISS4", kind: "issue", status: "todo", title: "Current descendant" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Keep issue work visible" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use record tabs" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "active", title: "Related delivery plan" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, childIssue, deferredIssue, nestedIssue, story, adr, plan],
			initiatives: [makeBundle(initiative, {
				constrainsLinks: [{ adr, issue: parentIssue }],
				fixLinks: [{ issue: childIssue, userStory: story }],
				issues: [parentIssue, childIssue, deferredIssue, nestedIssue],
				subIssueLinks: [{ issue: childIssue, parent: parentIssue }, { issue: deferredIssue, parent: parentIssue }, { issue: nestedIssue, parent: deferredIssue }],
				userStories: [story]
			})],
			relations: [makeRelation(parentIssue.id, "blocks", plan.id)]
		});
		const store = makeStore(snapshot);
		store.selectEntity(parentIssue.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues", "Plans", "ADRs", "User stories", "Graph"]);
		expect(tabRecordCounts(view)).toEqual({ adrs: "1", issues: "3", plans: "1", userStories: "1" });
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.getAttribute("aria-label")).toBe("Issues: 3 records");
		expect(view.shadowRoot?.querySelector('[data-tab="issues"] .ai-subtab-count')?.getAttribute("aria-hidden")).toBe("true");
		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="adrs"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="ADR1"]')).not.toBeNull();
		updateIssueRecordFilter(view, { query: "record tabs" });
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="ADR1"]')).not.toBeNull();

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="ISS3"]')).toBeNull();
		updateIssueRecordFilter(view, { status: "deferred" });
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id)).toEqual(["ISS3"]);
		updateIssueRecordFilter(view, { status: "all" });
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id).sort()).toEqual(["ISS2", "ISS3", "ISS4"]);
		updateIssueRecordFilter(view, { status: "current-work" });
		updateIssueRecordFilter(view, { query: "priority phrase" });
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id)).toEqual(["ISS2"]);
		updateIssueRecordFilter(view, { status: "done" });
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll<HTMLElement>(".record-browser-list .record-row") ?? []].map((record) => record.dataset.id)).toEqual(["ISS2"]);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="plans"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="PLAN1"]')).not.toBeNull();
		expect(view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.query).toBe("");
		expect(view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.status).toBe("all");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-ref[data-id="ISS3"]')).toBeNull();
		expect(view.shadowRoot?.querySelector('.ai-ref[data-id="ISS4"]')).not.toBeNull();

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="userStories"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "userStories", "tree");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-story-block .ai-ref[data-id="US1"]')).not.toBeNull();
		expect(view.shadowRoot?.querySelector('.ai-story-issues .ai-ref[data-id="ISS2"]')).not.toBeNull();
	});

	it("hides issue tabs that have no useful data", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Standalone issue" });
		const store = makeStore(makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		}));
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("issue-detail-ISS1-overview-tab");
	});

	it("falls back to Overview when the selected issue tab loses its data", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Changing issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Temporary child" });
		const store = makeStore(makeSnapshot({
			entities: [initiative, issue, childIssue],
			initiatives: [makeBundle(initiative, { issues: [issue, childIssue], subIssueLinks: [{ issue: childIssue, parent: issue }] })]
		}));
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.getAttribute("aria-selected")).toBe("true");
		store.snapshot.set(makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		}));
		await view.updateComplete;

		expect([...view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []].map((tab) => tab.textContent?.trim())).toEqual(["Overview"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("issue-detail-ISS1-overview-tab");
	});

	it("renders and filters the issue-local relationship graph", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render local graph" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Open graph records" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue, story],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [makeRelation(issue.id, "fixes", story.id)]
		});
		const store = makeStore(snapshot);
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="graph"]')?.click();
		await view.updateComplete;
		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph?.shadowRoot?.querySelectorAll(".ai-node").length).toBe(2);

		const filters = view.shadowRoot?.querySelector("agent-issues-relationship-graph-filters");
		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector("agent-issues-relationship-graph")?.shadowRoot?.querySelector('.ai-node[data-id="ISS1"]') ?? null).toBeNull();
		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="story"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="graph"]')?.getAttribute("aria-selected")).toBe("true");
		expect(view.shadowRoot?.textContent).toContain("No graph records match the selected filters.");

		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="story"]')?.click();
		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await view.updateComplete;
		view.shadowRoot?.querySelector("agent-issues-relationship-graph")?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="US1"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedId.get()).toBe(story.id);
	});

	it("renders an entity graph from scoped detail relations without a snapshot", async () => {
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render local graph" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Open graph records" });
		const { body: _body, bodySource: _bodySource, ...storySummary } = story;
		const store = new AgentIssuesStore();
		store.entityDetails.set(new Map([[
			issue.id,
			{
				detail: {
					entity: issue,
					incoming: [],
					outgoing: [{ entity: storySummary, relationType: "fixes" }],
					planEntries: []
				},
				error: null,
				loading: false
			}
		]]));
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		expect(store.snapshot.get()).toBeNull();
		expect(tabLabels(view)).toContain("Graph");
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="graph"]')?.click();
		await view.updateComplete;
		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph?.shadowRoot?.querySelectorAll(".ai-node").length).toBe(2);
		expect(graph?.shadowRoot?.querySelectorAll(".ai-edge").length).toBe(1);
		expect(graph?.shadowRoot?.querySelector('[data-id="ISS1"]')).not.toBeNull();
		expect(graph?.shadowRoot?.querySelector('[data-id="US1"]')).not.toBeNull();

		const replacementStory = makeEntity({ id: "US2", kind: "userStory", status: "draft", title: "Refresh graph records" });
		const { body: _replacementBody, bodySource: _replacementBodySource, ...replacementStorySummary } = replacementStory;
		store.entityDetails.set(new Map([[
			issue.id,
			{
				detail: {
					entity: issue,
					incoming: [],
					outgoing: [{ entity: replacementStorySummary, relationType: "fixes" }],
					planEntries: []
				},
				error: null,
				loading: false
			}
		]]));
		await view.updateComplete;
		const refreshedGraph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(refreshedGraph?.shadowRoot?.querySelector('[data-id="US1"]')).toBeNull();
		expect(refreshedGraph?.shadowRoot?.querySelector('[data-id="US2"]')).not.toBeNull();
	});

	it("renders a Plan's generated current groups and complete entry history in its Plan tab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Plan owner" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "in-progress", title: "Plan record" });
		const question = {
			body: "Which entries are current?",
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "ENTRY1",
			planId: plan.id,
			reference: "PLAN_ENTRY_QUESTION",
			referencedEntityIds: [],
			role: "question" as const,
			shortReference: "PLAN_ENTRY_OLD",
			scopeDirection: null,
			supersededEntryIds: [],
			tombstone: false,
			updatedAt: "2026-01-01T00:00:00.000Z"
		};
		const decision = {
			body: "Show active groups and history.",
			createdAt: "2026-01-02T00:00:00.000Z",
			id: "ENTRY2",
			planId: plan.id,
			reference: "PLAN_ENTRY_DECISION",
			referencedEntityIds: [initiative.id],
			role: "decision" as const,
			shortReference: "PLAN_ENTRY_SHORT",
			scopeDirection: null,
			supersededEntryIds: [question.id],
			tombstone: false,
			updatedAt: "2026-01-02T00:00:00.000Z"
		};
		const deleted = {
			body: undefined,
			createdAt: "2026-01-03T00:00:00.000Z",
			id: "ENTRY3",
			planId: plan.id,
			reference: "PLAN_ENTRY_DELETED",
			referencedEntityIds: [],
			role: "consideration" as const,
			scopeDirection: null,
			supersededEntryIds: [],
			tombstone: true,
			updatedAt: "2026-01-03T00:00:00.000Z"
		};
		const store = makeStore(makeSnapshot({
			entities: [initiative, plan],
			initiatives: [makeBundle(initiative, { entities: [initiative, plan] })],
			planEntries: [question, decision, deleted]
		}));
		store.selectEntity(plan.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toContain("Plan");
		expect(view.shadowRoot?.querySelector(".ai-plan-current")).toBeNull();
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plan"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLDetailsElement>(".ai-plan-group")?.open).toBe(false);
		expect(view.shadowRoot?.querySelector(".ai-plan-group .ai-plan-count")?.textContent).toBe("1");
		expect(view.shadowRoot?.querySelector<HTMLDetailsElement>(".ai-plan-history")?.open).toBe(false);
		expect(view.shadowRoot?.querySelector(".ai-plan-history .ai-plan-count")?.textContent).toBe("3");
		expect(view.shadowRoot?.querySelector(".ai-plan-current")?.textContent).toContain("Decisions");
		expect(view.shadowRoot?.querySelector(".ai-plan-current")?.textContent).toContain(decision.body);
		expect(view.shadowRoot?.querySelector(".ai-plan-current")?.textContent).toContain(question.body);
		expect([...view.shadowRoot?.querySelectorAll(".ai-plan-decision-pair-label") ?? []].map((label) => label.textContent?.trim())).toEqual(["Question", "Decision"]);
		expect(view.shadowRoot?.querySelector('.ai-plan-decision-question .ai-plan-entry[data-plan-entry-id="ENTRY1"]')).not.toBeNull();
		const currentEntry = view.shadowRoot?.querySelector('.ai-plan-decision-answer .ai-plan-entry[data-plan-entry-id="ENTRY2"]');
		expect([...currentEntry?.children ?? []].map((child) => child.className)).toEqual(["ai-plan-entry-header", "ai-plan-entry-body", "ai-plan-entry-meta"]);
		expect(currentEntry?.querySelector(".ai-plan-entry-reference")?.textContent?.trim()).toBe(decision.shortReference);
		expect(currentEntry?.querySelector(".ai-plan-entry-reference")?.getAttribute("title")).toBe(decision.reference);
		expect(view.shadowRoot?.querySelector('.ai-plan-current .ai-plan-entry-link[data-id="INIT1"]')?.textContent).toContain(initiative.title);
		const currentGroup = view.shadowRoot?.querySelector<HTMLDetailsElement>(".ai-plan-group");
		currentGroup!.open = true;
		view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-plan-current .ai-plan-entry-link[data-plan-entry-id="ENTRY1"]')?.click();
		const history = view.shadowRoot?.querySelector<HTMLDetailsElement>(".ai-plan-history");
		const supersededEntry = history?.querySelector<HTMLElement>('[data-plan-entry-id="ENTRY1"]');
		expect(history?.open).toBe(true);
		expect(supersededEntry?.classList.contains("is-plan-entry-target")).toBe(true);
		expect(view.shadowRoot?.activeElement).toBe(supersededEntry);
		expect(view.shadowRoot?.querySelector(".ai-plan-history")?.textContent).toContain(question.shortReference);
		expect(view.shadowRoot?.querySelector(".ai-plan-history")?.textContent).toContain(deleted.reference);
		expect(view.shadowRoot?.querySelector(".ai-plan-history")?.textContent).toContain("Deleted");
		view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-plan-current .ai-plan-entry-link[data-id="INIT1"]')?.click();
		expect(store.selectedInitiativeId.get()).toBe(initiative.id);
	});

	it("renders and appends scoped Plan-entry pages without a snapshot", async () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "in-progress", title: "Scoped Plan" });
		const question = {
			body: "Which entries are current?",
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "ENTRY1",
			planId: plan.id,
			reference: "PLAN_ENTRY_QUESTION",
			referencedEntityIds: [],
			role: "question" as const,
			shortReference: "PLAN_ENTRY_QUESTION_SHORT",
			scopeDirection: null,
			supersededEntryIds: [],
			tombstone: false,
			updatedAt: "2026-01-01T00:00:00.000Z"
		};
		const decision = {
			...question,
			body: "Use scoped pages.",
			createdAt: "2026-01-02T00:00:00.000Z",
			id: "ENTRY2",
			reference: "PLAN_ENTRY_DECISION",
			role: "decision" as const,
			shortReference: "PLAN_ENTRY_DECISION_SHORT",
			supersededEntryIds: [question.id]
		};
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			plan.id,
			{ detail: { entity: plan, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		store.planEntryPages.set(new Map([[
			plan.id,
			{ data: { entries: [decision], nextBefore: "cursor-1", total: 2 }, error: null, loading: false }
		]]));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ entries: [question], nextBefore: null, total: 2 }), { status: 200 }));
		store.selectEntity(plan.id);
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plan"]')?.click();
		await view.updateComplete;
		expect(store.snapshot.get()).toBeNull();
		expect(view.shadowRoot?.querySelector(".ai-plan-history .ai-plan-count")?.textContent).toBe("1");
		expect(view.shadowRoot?.querySelector(".ai-plan-current")?.textContent).toContain(decision.body);
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-plan-current .ai-plan-entry-link[data-plan-entry-id="ENTRY1"]')?.textContent?.trim()).toBe(question.id);
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-plan-tab > button")?.textContent).toContain("Load more entries");

		view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-plan-tab > button")?.click();
		await vi.waitFor(() => expect(store.planEntriesFor(plan.id)).toEqual([decision, question]));
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector(".ai-plan-history .ai-plan-count")?.textContent).toBe("2");
		expect(view.shadowRoot?.querySelector(".ai-plan-group .ai-plan-count")?.textContent).toBe("1");
		expect(view.shadowRoot?.querySelector(".ai-plan-decision-question")?.textContent).toContain(question.body);
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-plan-current .ai-plan-entry-link[data-plan-entry-id="ENTRY1"]')?.textContent?.trim()).toBe(question.shortReference);
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-plan-tab > button")).toBeNull();
	});

	it("opens and highlights a deep-linked Plan entry", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const entry = {
			body: "Define durable result routes.",
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "ENTRY1",
			planId: plan.id,
			reference: "PLAN_ENTRY_1",
			referencedEntityIds: [],
			role: "decision" as const,
			scopeDirection: null,
			shortReference: "PLAN_ENTRY_1",
			supersededEntryIds: [],
			tombstone: false,
			updatedAt: "2026-01-01T00:00:00.000Z"
		};
		const store = makeStore(makeSnapshot({
			entities: [initiative, plan],
			initiatives: [makeBundle(initiative, { entities: [initiative, plan] })],
			planEntries: [entry]
		}));
		store.openSearchTarget({ type: "plan-entry", planId: plan.id, entryId: entry.id });

		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="plan"]')?.getAttribute("aria-selected")).toBe("true");
		const target = view.shadowRoot?.querySelector<HTMLElement>('[data-plan-entry-id="ENTRY1"]');
		expect(target?.classList.contains("is-plan-entry-target")).toBe(true);
		expect(view.shadowRoot?.activeElement).toBe(target);

		store.selectEntity(plan.id);
		await view.updateComplete;

		expect(target?.classList.contains("is-plan-entry-target")).toBe(false);
	});

	it("renders the kind label, title, id, and a status badge for the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const root = view.shadowRoot;
		expect(root?.querySelector(".ai-kind")?.textContent?.trim()).toBe("Issue");
		expect(root?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
		expect(root?.querySelector(".ai-d-title .ai-id")?.textContent?.trim()).toBe(store.shortRef(issue));
		expect(root?.querySelector(".ai-d-title .badge")?.textContent?.trim()).toBe("todo");
	});

	it("renders debt metadata and its owner, resolver, context, and handoff links", async () => {
		const owner = makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Platform" });
		const resolver = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Modernize storage" });
		const relatedIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Retire legacy adapter" });
		const handoff = makeEntity({ id: "HO1", kind: "handoff", status: "active", title: "Investigate storage debt" });
		const debt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open", title: "Replace legacy storage" });
		const store = makeStore(
			makeSnapshot({
				entities: [owner, resolver, relatedIssue, handoff, debt],
				relations: [
					makeRelation(owner.id, "records", debt.id),
					makeRelation(resolver.id, "resolves", debt.id),
					makeRelation(debt.id, "relatesTo", relatedIssue.id),
					makeRelation(handoff.id, "handsOff", debt.id)
				]
			})
		);
		store.selectEntity(debt.id);
		const view = await mountDetail(store);

		const metadata = view.shadowRoot?.querySelector(".ai-meta")?.textContent;
		expect(metadata).toContain("technical");
		expect(metadata).toContain("high");
		expect(metadata).toContain("Platform");
		expect([...view.shadowRoot?.querySelectorAll(".ai-meta .k") ?? []].map((label) => label.textContent?.trim())).toEqual([
			"Initiative",
			"Category",
			"Priority",
			"Lifecycle",
			"Owner",
			"Created",
			"Updated"
		]);
		expect(tabLabels(view)).toEqual(["Overview", "Issues", "Related", "Graph"]);
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="related"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="PROJ1"]')).not.toBeNull();
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="HO1"]')).not.toBeNull();
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="ISS1"]')).not.toBeNull();
		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-record-tree .ai-ref[data-id="ISS1"]')).not.toBeNull();
	});

	it("keeps a Plan's body in Overview and its projection in the dedicated Plan tab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Plan owner" });
		const plan = makeEntity({ body: "Plan overview content.", id: "PLAN1", kind: "plan", status: "in-progress", title: "Plan record" });
		const followUpPlan = makeEntity({ id: "PLAN2", kind: "plan", status: "ready", title: "Follow-up plan" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", status: "draft", title: "Plan requirements" });
		const store = makeStore(makeSnapshot({
			entities: [initiative, plan, followUpPlan, prd],
			initiatives: [makeBundle(initiative, { entities: [initiative, plan], prds: [prd] })],
			planEntries: [{
				body: "Ship the plan.",
				createdAt: "2026-01-01T00:00:00.000Z",
				id: "ENTRY1",
				planId: plan.id,
				reference: "PLAN_ENTRY_DECISION",
				referencedEntityIds: [],
				role: "decision",
				scopeDirection: null,
				supersededEntryIds: [],
				tombstone: false,
				updatedAt: "2026-01-01T00:00:00.000Z"
			}],
			relations: [
				makeRelation(plan.id, "informs", prd.id),
				makeRelation(plan.id, "continues", followUpPlan.id)
			]
		}));
		store.selectEntity(plan.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Plan", "Plans", "PRDs", "Graph"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')?.textContent).toContain("Plan overview content.");
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-plan-current')).toBeNull();
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plan"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-plan-current')?.textContent).toContain("Decisions");
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')).toBeNull();
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plans"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="PLAN2"]')).not.toBeNull();
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="prds"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="PRD1"]')).not.toBeNull();
	});

	it("shows linked Plans in the entity detail tabs", async () => {
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Implement the workflow" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "ready", title: "Workflow implementation" });
		const store = makeStore(makeSnapshot({
			entities: [issue, plan],
			relations: [makeRelation(issue.id, "implements", plan.id)]
		}));
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Plans", "Graph"]);
		expect(tabRecordCounts(view)).toMatchObject({ plans: "1" });
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plans"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="PLAN1"]')).not.toBeNull();
	});

	it("provides Handoffs with shared data-aware tabs", async () => {
		const handoff = makeEntity({ body: "Handoff overview content.", id: "HO1", kind: "handoff", status: "active", title: "Resume work" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Continue implementation" });
		const store = makeStore(makeSnapshot({
			entities: [handoff, issue],
			relations: [makeRelation(handoff.id, "handsOff", issue.id)]
		}));
		store.selectEntity(handoff.id);
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')?.textContent).toContain("Handoff overview content.");
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-browser-list .record-row[data-id="ISS1"]')).not.toBeNull();
	});

	it("renders a specialized issue type", async () => {
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Choose architecture", type: "pioneer-map" });
		const store = makeStore(makeSnapshot({ entities: [issue] }));
		store.selectEntity(issue.id);
		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector(".ai-meta")?.textContent).toContain("pioneer-map");
	});

	it("shows directly owned debt in a project detail without a resolver section", async () => {
		const project = makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Platform" });
		const debt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open", title: "Replace legacy storage" });
		const store = makeStore(
			makeSnapshot({
				entities: [project, debt],
				relations: [makeRelation(project.id, "records", debt.id)]
			})
		);
		store.selectEntity(project.id);
		const view = await mountDetail(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".ai-sec h2") ?? [])].map((node) => node.textContent?.trim());
		expect(sectionTitles).toContain("Owned debt");
		expect(sectionTitles).not.toContain("Resolves debt");
		expect(view.shadowRoot?.querySelector(".ai-sec")?.textContent).toContain("Replace legacy storage");
		(view.shadowRoot?.querySelector<HTMLButtonElement>('.ai-ref[data-id="DEBT1"]'))?.click();
		expect(store.selectedId.get()).toBe(debt.id);
	});

	it("shows owned and resolved debt in separate epic and issue details", async () => {
		for (const ownerKind of ["epic", "issue"] as const) {
			const owner = makeEntity({ id: `${ownerKind.toUpperCase()}1`, kind: ownerKind, status: "active", title: `${ownerKind} owner` });
			const ownedDebt = makeEntity({ category: "technical", id: `${ownerKind.toUpperCase()}-DEBT1`, kind: "debt", priority: "high", status: "open", title: `${ownerKind} owned debt` });
			const resolvedDebt = makeEntity({ category: "process", id: `${ownerKind.toUpperCase()}-DEBT2`, kind: "debt", priority: "medium", status: "resolved", title: `${ownerKind} resolved debt` });
			const store = makeStore(
				makeSnapshot({
					entities: [owner, ownedDebt, resolvedDebt],
					relations: [
						makeRelation(owner.id, "records", ownedDebt.id),
						makeRelation(owner.id, "resolves", resolvedDebt.id)
					]
				})
			);
			store.selectEntity(owner.id);
			const view = await mountDetail(store);
			if (ownerKind === "issue") {
				view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="debt"]')?.click();
				await view.updateComplete;
				expect(view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.countText).toBe("2 of 2");
			} else {
				const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".ai-sec h2") ?? [])].map((node) => node.textContent?.trim());
				expect(sectionTitles).toEqual(expect.arrayContaining(["Owned debt", "Resolves debt"]));
				expect(sectionTitles).not.toContain("Records");
			}
			if (ownerKind === "issue") {
				expect(view.shadowRoot?.querySelector<HTMLElement>(`.record-browser-list .record-row[data-id="${ownedDebt.id}"]`)?.shadowRoot?.textContent).toContain(ownedDebt.title);
				expect(view.shadowRoot?.querySelector<HTMLElement>(`.record-browser-list .record-row[data-id="${resolvedDebt.id}"]`)?.shadowRoot?.textContent).toContain(resolvedDebt.title);
			} else {
				expect(view.shadowRoot?.textContent).toContain(ownedDebt.title);
				expect(view.shadowRoot?.textContent).toContain(resolvedDebt.title);
			}
			document.body.replaceChildren();
		}
	});

	it("renders an issue's newest comment page in chronological order", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Discuss detail rendering" });
		const referencedIssue = makeEntity({ id: "ISS10", kind: "issue", status: "todo", title: "Referenced issue" });
		const snapshot: Snapshot = {
			...makeSnapshot({
				entities: [initiative, issue, referencedIssue],
				initiatives: [makeBundle(initiative, { issues: [issue, referencedIssue] })]
			}),
			issueComments: {
				ISS9: {
					comments: [
						{
							body: "First comment.",
							createdAt: "2026-01-01T00:00:00.000Z",
							createdBy: "user-1",
							contentHash: "hash-1",
							id: "comment-1",
							issueId: "ISS9",
							reference: "COM_FIRST",
							referencedIssueIds: ["ISS10"],
							revision: 1,
							tombstone: false,
							updatedAt: "2026-01-01T00:00:00.000Z",
							updatedBy: "user-1"
						},
						{
							body: "Second comment.",
							createdAt: "2026-01-02T00:00:00.000Z",
							createdBy: "user-1",
							contentHash: "hash-2",
							id: "comment-2",
							issueId: "ISS9",
							reference: "COM_SECOND",
							referencedIssueIds: [],
							revision: 1,
							tombstone: false,
							updatedAt: "2026-01-02T00:00:00.000Z",
							updatedBy: "user-1"
						}
					],
					nextBefore: null,
					total: 2,
					users: []
				}
			},
			users: []
		};
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const comments = [...(view.shadowRoot?.querySelectorAll(".ai-comment") ?? [])].map((comment) => comment.textContent?.trim());
		expect(comments).toEqual([
			expect.stringContaining("COM_FIRST"),
			expect.stringContaining("COM_SECOND")
		]);
		expect(comments[0]).toContain("First comment.");
		expect(comments[0]).toContain("ISS10");
	});

	it("focuses and highlights a deep-linked issue comment", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Discuss detail rendering" });
		const comment = {
			body: "Use a durable nested route.",
			contentHash: "hash-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			createdBy: "user-1",
			id: "COMMENT1",
			issueId: issue.id,
			reference: "COM_1",
			referencedIssueIds: [],
			revision: 1,
			tombstone: false,
			updatedAt: "2026-01-01T00:00:00.000Z",
			updatedBy: "user-1"
		};
		const store = makeStore(makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })],
			issueComments: { [issue.id]: { comments: [comment], nextBefore: null, total: 1, users: [] } }
		}));
		store.openSearchTarget({ type: "issue-comment", issueId: issue.id, commentId: comment.id });

		const view = await mountDetail(store);

		const target = view.shadowRoot?.querySelector<HTMLElement>('[data-comment-id="COMMENT1"]');
		expect(target?.classList.contains("is-comment-target")).toBe(true);
		expect(view.shadowRoot?.activeElement).toBe(target);
	});

	it("resolves comment provenance and preserves a deleted-comment placeholder", async () => {
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Discuss detail rendering" });
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			issue.id,
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		store.issueCommentPages.set(new Map([[
			issue.id,
			{
				data: {
					comments: [{
						body: "Hidden deleted body.",
						contentHash: "hash-deleted",
						createdAt: "2026-01-01T00:00:00.000Z",
						createdBy: "user-1",
						id: "comment-deleted",
						issueId: "ISS9",
						reference: "COM_DELETED",
						referencedIssueIds: [],
						revision: 2,
						tombstone: true,
						updatedAt: "2026-01-03T00:00:00.000Z",
						updatedBy: "missing-user"
					}],
					users: [
						{ authenticationSubject: "ada", displayName: "Ada", id: "user-1", updatedAt: "2026-01-01T00:00:00.000Z" }
					],
					nextBefore: null,
					total: 1
				},
				error: null,
				loading: false
			}
		]]));
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const comment = view.shadowRoot?.querySelector(".ai-comment");
		expect(store.snapshot.get()).toBeNull();
		expect(comment?.textContent).toContain("COM_DELETED");
		expect(comment?.textContent).toContain("Deleted 2026-01-03T00:00:00.000Z");
		expect(comment?.textContent).toContain("Created by Ada");
		expect(comment?.textContent).toContain("Updated by missing-user");
		expect(comment?.textContent).not.toContain("Hidden deleted body.");
	});

	it("uses the real status vocabulary for the title badge across record kinds", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const adr = makeEntity({ id: "ADR4", kind: "adr", status: "current", title: "Adopt signals" });
		const snapshot = makeSnapshot({
			entities: [initiative, adr],
			initiatives: [makeBundle(initiative, { adrs: [adr] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ADR4");
		const view = await mountDetail(store);

		const badge = view.shadowRoot?.querySelector(".ai-d-title .badge");
		expect(badge?.textContent?.trim()).toBe("current");
		expect(badge?.classList.contains("success")).toBe(true);
	});

	it("renders an explicitly supplied entity id without relying on the global selection", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view") as HTMLElement & {
			store: AgentIssuesStore;
			entityId: string | null;
			updateComplete: Promise<unknown>;
		};
		view.store = store;
		view.entityId = "ISS9";
		document.body.appendChild(view);
		await view.updateComplete;

		const root = view.shadowRoot;
		expect(root?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
		expect(root?.querySelector(".ai-d-title .ai-id")?.textContent?.trim()).toBe(store.shortRef(issue));
		expect(store.selectedId.get()).toBeNull();
	});

	it("shows issues that fix a User story in its shared Issues tab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US7", kind: "userStory", status: "draft", title: "Open any record" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, story, issue],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [makeRelation("ISS9", "fixes", "US7")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("US7");
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		const ref = view.shadowRoot?.querySelector<HTMLElement>('.record-browser-list .record-row[data-id="ISS9"]');
		expect(ref?.shadowRoot?.querySelector(".idtag")?.textContent?.trim()).toBe(store.shortRef(issue));
		expect(ref?.shadowRoot?.querySelector(".line-title")?.textContent?.trim()).toBe("Wire the detail pane");
	});

	it("returns to the source record after opening a linked child record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US7", kind: "userStory", status: "draft", title: "Open any record" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, story, issue],
			initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
			relations: [makeRelation("ISS9", "fixes", "US7")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("US7");
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		const ref = view.shadowRoot?.querySelector<HTMLElement>('.record-browser-list .record-row[data-id="ISS9"]');
		ref?.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
		await view.updateComplete;

		expect(store.selectedId.get()).toBe("ISS9");
		expect(view.shadowRoot?.querySelector(".ai-d-title")?.textContent).toContain("Wire the detail pane");
		expect(view.shadowRoot?.querySelector(".ai-back")?.textContent).toContain("Open any record");

		view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-back")?.click();
		await view.updateComplete;

		expect(store.selectedId.get()).toBe("US7");
		expect(view.shadowRoot?.querySelector(".ai-d-title")?.textContent).toContain("Open any record");
	});

	it("renders sub-issues as a nested tree for a parent issue", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const nestedSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Nested sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, nestedSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, nestedSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: nestedSubIssue, parent: subIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS1");
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;
		const nestedRefs = [...(view.shadowRoot?.querySelectorAll(".ai-record-tree .ai-ref .r-id") ?? [])].map((node) => node.textContent?.trim());
		expect(nestedRefs).toEqual([store.shortRef(subIssue), store.shortRef(nestedSubIssue)]);
		expect(view.shadowRoot?.querySelector(".ai-issue-tree-children .ai-ref .r-id")?.textContent?.trim()).toBe(store.shortRef(nestedSubIssue));
	});

	it("excludes the open issue from its related Issues tab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const openIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Open issue" });
		const relatedIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Related issue" });
		const store = makeStore(makeSnapshot({
			entities: [initiative, openIssue, relatedIssue],
			initiatives: [makeBundle(initiative, {
				issues: [openIssue, relatedIssue],
				subIssueLinks: [{ issue: relatedIssue, parent: openIssue }]
			})]
		}));
		store.selectEntity(openIssue.id);
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector(`.record-row[data-id="${openIssue.id}"]`)).toBeNull();
		expect(view.shadowRoot?.querySelector(`.record-row[data-id="${relatedIssue.id}"]`)).not.toBeNull();
	});

	it("renders the parent issue section when a sub-issue is open", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue],
			initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue], subIssueLinks: [{ issue: subIssue, parent: parentIssue }] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS2");
		const view = await mountDetail(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLElement>('.record-browser-list .record-row[data-id="ISS1"]')?.shadowRoot?.querySelector(".idtag")?.textContent?.trim()).toBe(store.shortRef(parentIssue));
	});

	it("highlights the child reference matching the active child id", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const otherSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Other sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, otherSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, otherSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: otherSubIssue, parent: parentIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS1";
		view.activeChildId = "ISS2";
		document.body.appendChild(view);
		await view.updateComplete;
		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;

		const activeRef = view.shadowRoot?.querySelector('.ai-ref[data-id="ISS2"]');
		const otherRef = view.shadowRoot?.querySelector('.ai-ref[data-id="ISS3"]');
		expect(activeRef?.classList.contains("is-active-ref")).toBe(true);
		expect(otherRef?.classList.contains("is-active-ref")).toBe(false);
	});

	it("re-roots the cascade when a cross-link reference is clicked", async () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" });
		const issue = makeEntity({ id: "ISS18", kind: "issue", status: "todo", title: "Cascade skeleton" });
		const blocker = makeEntity({ id: "ISS40", kind: "issue", status: "todo", title: "Cross-linked issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue, blocker],
			initiatives: [makeBundle(initiative, { issues: [issue, blocker] })],
			relations: [makeRelation("ISS40", "blocks", "ISS18")]
		});
		const store = makeStore(snapshot);
		store.cascadePath.set(["INIT4", "ISS18"]);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS18";
		view.cascade = true;
		document.body.appendChild(view);
		await view.updateComplete;

		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "list");
		await view.updateComplete;
		const crossRef = view.shadowRoot?.querySelector<HTMLElement>('.record-browser-list .record-row[data-id="ISS40"]');
		crossRef?.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
		await view.updateComplete;

		expect(store.reRootTrail.get()).toEqual([["INIT4", "ISS18"]]);
		expect(store.cascadePath.get()).toEqual(["ISS40"]);
	});

	it("provides PRDs with shared record tabs and created story issue trees", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ body: "PRD overview content.", id: "PRD1", kind: "prd", status: "draft", title: "Console graph PRD" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, prd, story, parentIssue, subIssue],
			initiatives: [
				makeBundle(initiative, {
					fixLinks: [{ issue: parentIssue, userStory: story }],
					issues: [parentIssue, subIssue],
					prds: [prd],
					subIssueLinks: [{ issue: subIssue, parent: parentIssue }],
					userStories: [story]
				})
			],
			relations: [makeRelation("PRD1", "creates", "US1")]
		});
		const store = makeStore(snapshot);
		store.selectEntity("PRD1");
		const view = await mountDetail(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues", "User stories", "Graph"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"] .ai-body')?.textContent).toContain("PRD overview content.");
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="userStories"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "userStories", "tree");
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector('.ai-story-block .ai-ref[data-id="US1"]')).not.toBeNull();
		expect([...view.shadowRoot?.querySelectorAll('.ai-story-issues .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual([store.shortRef(parentIssue), store.shortRef(subIssue)]);
	});

	it("collapses and expands nested sub-issues in the issue detail tree", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Sub-issue" });
		const nestedSubIssue = makeEntity({ id: "ISS3", kind: "issue", status: "done", title: "Nested sub-issue" });
		const snapshot = makeSnapshot({
			entities: [initiative, parentIssue, subIssue, nestedSubIssue],
			initiatives: [
				makeBundle(initiative, {
					issues: [parentIssue, subIssue, nestedSubIssue],
					subIssueLinks: [
						{ issue: subIssue, parent: parentIssue },
						{ issue: nestedSubIssue, parent: subIssue }
					]
				})
			]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS1");
		const view = await mountDetail(store);
		view.shadowRoot?.querySelector<HTMLButtonElement>('[role="tab"][data-tab="issues"]')?.click();
		await view.updateComplete;
		updateIssueRecordView(view, "issues", "tree");
		await view.updateComplete;

		const toggle = view.shadowRoot?.querySelector<HTMLButtonElement>('.branch-toggle[data-id="ISS2"]');
		toggle?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.ai-issue-tree-children .ai-ref .r-id')?.textContent?.trim()).not.toBe(store.shortRef(nestedSubIssue));
		expect([...view.shadowRoot?.querySelectorAll('.ai-issue-tree .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual([store.shortRef(subIssue)]);

		toggle?.click();
		await view.updateComplete;
		expect([...view.shadowRoot?.querySelectorAll('.ai-issue-tree .ai-ref .r-id') ?? []].map((node) => node.textContent?.trim())).toEqual([store.shortRef(subIssue), store.shortRef(nestedSubIssue)]);
	});

	it("offers a back control that closes the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const back = view.shadowRoot?.querySelector<HTMLButtonElement>(".ai-back");
		expect(back?.textContent).toContain("Console Viewer");
		back?.click();
		await view.updateComplete;

		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
	});

	it("omits the back control when rendered as a cascade column", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		const view = document.createElement("agent-issues-detail-view");
		view.store = store;
		view.entityId = "ISS9";
		view.cascade = true;
		document.body.appendChild(view);
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector(".ai-back")).toBeNull();
	});

	it("renders the authored markdown body of the open record", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **detail** pane.",
			bodySource: "authored",
			id: "ISS9",
			kind: "issue",
			status: "todo",
			title: "Wire the detail pane"
		});
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		const body = view.shadowRoot?.querySelector(".ai-body");
		expect(body?.querySelector("h2")?.textContent?.trim()).toBe("Plan");
		expect(body?.querySelector("strong")?.textContent?.trim()).toBe("detail");
		expect(view.shadowRoot?.querySelector(".ai-body-source")).toBeNull();
	});

	it("marks generated bodies so fallback content is distinguishable from authored prose", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nInfer the next slice from linked records.",
			bodySource: "generated",
			id: "ISS9",
			kind: "issue",
			status: "todo",
			title: "Wire the detail pane"
		});
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector(".ai-body-source-badge")?.textContent?.trim()).toBe("Generated fallback");
		expect(view.shadowRoot?.querySelector(".ai-body-source-copy")?.textContent).toContain("no authored body was present");
	});

	it("omits the body section when the record has no authored body", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ body: "", id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [initiative, issue],
			initiatives: [makeBundle(initiative, { issues: [issue] })]
		});
		const store = makeStore(snapshot);
		store.selectEntity("ISS9");
		const view = await mountDetail(store);

		expect(view.shadowRoot?.querySelector(".ai-body")).toBeNull();
	});
});
