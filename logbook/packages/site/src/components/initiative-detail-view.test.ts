import { afterEach, describe, expect, it } from "vitest";

import "./initiative-detail-view.js";
import type { Entity, InitiativeBundle, Snapshot } from "../models.js";
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

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		contexts: {
			initiatives: [],
			shared: {
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
			}
		},
		entities: [],
		generatedAt: "2026-01-01T00:00:00.000Z",
		initiatives: [],
		issueComments: overrides.issueComments ?? {},
		orphans: [],
		projectAdrs: [],
		relations: [],
		users: overrides.users ?? [],
		...overrides
	};
}

function makeStore(bundle: InitiativeBundle): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.snapshot.set(makeSnapshot({ initiatives: [bundle] }));
	store.selectInitiative(bundle.initiative.id);
	return store;
}

async function mountView(store: AgentIssuesStore) {
	const view = document.createElement("agent-issues-initiative-detail-view");
	view.store = store;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

function recordItems(view: HTMLElement): HTMLElement[] {
	return [...(view.shadowRoot?.querySelectorAll<HTMLElement>(".record-tab-list agent-issues-record-list-item") ?? [])];
}

function tabLabels(view: HTMLElement) {
	return [...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".subtab") ?? [])]
		.map((button) => button.querySelector(".subtab-label")?.textContent?.trim());
}

function tabRecordCounts(view: HTMLElement) {
	return Object.fromEntries(
		[...(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".subtab") ?? [])]
			.flatMap((button) => {
				const count = button.querySelector(".subtab-count")?.textContent?.trim();
				return count ? [[button.dataset.tab, count]] : [];
			})
	);
}

function updateRecordFilter(view: HTMLElement, detail: { query?: string; status?: string }) {
	const toolbar = view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar");
	if (detail.query !== undefined) {
		toolbar?.dispatchEvent(new CustomEvent("record-query-change", { detail: { query: detail.query } }));
	}
	if (detail.status !== undefined) {
		toolbar?.dispatchEvent(new CustomEvent("record-status-change", { detail: { status: detail.status } }));
	}
}

function updateRecordView(view: HTMLElement, tab: "issues" | "userStories", viewMode: "list" | "tree") {
	view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.dispatchEvent(
		new CustomEvent("record-view-change", { detail: { tab, view: viewMode } })
	);
}

afterEach(() => {
	document.body.replaceChildren();
	window.location.hash = "";
});

describe("initiative detail overview tab", () => {
	it("renders a Project Summary rollup with its cached detail without a snapshot", async () => {
		const initiative = makeEntity({
			body: "Loaded on selection.",
			id: "INIT1",
			kind: "initiative",
			status: "active",
			title: "Console Viewer"
		});
		const initiativeSummary = {
			createdAt: initiative.createdAt,
			id: initiative.id,
			kind: initiative.kind,
			status: initiative.status,
			title: initiative.title,
			updatedAt: initiative.updatedAt
		};
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.initiativeDetails.set(new Map([[initiative.id, { detail: { initiative }, error: null, loading: false }]]));
		store.selectedInitiativeId.set(initiative.id);

		const view = await mountView(store);

		expect(view.shadowRoot?.querySelector(".d-title")?.textContent).toContain("Console Viewer");
		expect(view.shadowRoot?.querySelector(".initiative-body")?.textContent).toContain("Loaded on selection.");
	});

	it("shows local loading feedback while initiative detail loads", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = {
			createdAt: initiative.createdAt,
			id: initiative.id,
			kind: initiative.kind,
			status: initiative.status,
			title: initiative.title,
			updatedAt: initiative.updatedAt
		};
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.initiativeDetails.set(new Map([[initiative.id, { detail: null, error: null, loading: true }]]));
		store.selectedInitiativeId.set(initiative.id);

		const view = await mountView(store);

		const activeTab = view.shadowRoot?.querySelector<HTMLElement>('.subtab.active');
		expect(activeTab?.querySelector(".subtab-spinner")).not.toBeNull();
		expect(activeTab?.getAttribute("aria-label")).toContain("loading");
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy")).toBe("true");
		expect(view.shadowRoot?.querySelector(".local-state:not(.local-state-error)")).toBeNull();
	});

	it("shows scoped tab loading progress in the tab control without inserting panel content", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 1, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.initiativeTabs.set(new Map([[`${initiative.id}:issues`, { data: null, error: null, loading: true }]]));
		store.selectedInitiativeId.set(initiative.id);
		store.initTab.set("issues");

		const view = await mountView(store);
		const activeTab = view.shadowRoot?.querySelector<HTMLElement>('.subtab.active');

		expect(activeTab?.textContent).toContain("Issues");
		expect(activeTab?.querySelector(".subtab-spinner")).not.toBeNull();
		expect(activeTab?.getAttribute("aria-label")).toContain("loading");
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy")).toBe("true");
		expect(view.shadowRoot?.querySelector(".local-state:not(.local-state-error)")).toBeNull();
	});

	it("makes deferred record tabs available from a Project Summary rollup", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ adrCount: 2, completedIssueCount: 0, contextTermCount: 8, debtCount: 3, initiative: initiativeSummary, issueCount: 0, totalIssueCount: 1, planCount: 5, prdCount: 6, userStoryCount: 7 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.selectedInitiativeId.set(initiative.id);

		const view = await mountView(store);

		expect(tabLabels(view)).toContain("Issues");
		expect(tabRecordCounts(view)).toEqual({ adrs: "2", context: "8", debt: "3", issues: "1", plans: "5", prds: "6", userStories: "7" });
		expect(view.shadowRoot?.querySelector(".kpi:last-child .k-num")?.textContent).toBe("2");
	});

	it("renders records from the active scoped tab cache", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Load details" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 1, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.initiativeTabs.set(new Map([[`${initiative.id}:issues`, { data: { records: [issue], relations: [], tab: "issues" }, error: null, loading: false }]]));
		store.selectedInitiativeId.set(initiative.id);
		store.initTab.set("issues");

		const view = await mountView(store);
		updateRecordView(view, "issues", "list");
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector<HTMLElement>('.record-tab-list agent-issues-record-list-item[data-id="ISS1"]')).not.toBeNull();
	});

	it("shows an inline retry action when the active scoped tab fails", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		store.initiativeTabs.set(new Map([[`${initiative.id}:issues`, { data: null, error: "Request failed", loading: false }]]));
		store.selectedInitiativeId.set(initiative.id);
		store.initTab.set("issues");

		const view = await mountView(store);

		expect(view.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Could not load issues.");
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[role="alert"] button')?.textContent).toContain("Retry");
	});

	it("renders an explicitly supplied initiative id without relying on the global selection", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.",
			bodySource: "authored",
			id: "INIT2",
			kind: "initiative",
			status: "active",
			title: "Status derivation"
		});
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(makeSnapshot({ initiatives: [makeBundle(initiative)] }));
		const view = document.createElement("agent-issues-initiative-detail-view") as HTMLElement & {
			store: AgentIssuesStore;
			initiativeId: string | null;
			updateComplete: Promise<unknown>;
		};
		view.store = store;
		view.initiativeId = "INIT2";
		document.body.appendChild(view);
		await view.updateComplete;

		expect(view.shadowRoot?.querySelector(".d-title")?.textContent).toContain("Status derivation");
		expect(store.selectedInitiativeId.get()).toBeNull();
	});

	it("renders the authored markdown body of the selected initiative", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **initiative** detail pane.",
			bodySource: "authored",
			id: "INIT1",
			kind: "initiative",
			status: "active",
			title: "Console Viewer"
		});
		const store = makeStore(makeBundle(initiative));

		const view = await mountView(store);
		await view.updateComplete;

		const body = view.shadowRoot?.querySelector(".initiative-body .ai-body");
		expect(body?.querySelector("h2")?.textContent?.trim()).toBe("Plan");
		expect(body?.querySelector("strong")?.textContent?.trim()).toBe("initiative");
		expect(view.shadowRoot?.querySelector(".initiative-body .ai-body-source")).toBeNull();
	});

	it("keeps initiative Context in its tab instead of changing the header", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const bundle = makeBundle(initiative);
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(makeSnapshot({
			contexts: {
				initiatives: [{
					context: {
						createdAt: null,
						exists: true,
						key: initiative.id,
						scopeEntityId: initiative.id,
						scopeKind: "initiative",
						scopeLabel: initiative.title,
						summary: "## Purpose\n\nBuild the **viewer**.\n\n- Show records",
						title: "Console Viewer Context",
						updatedAt: null
					},
					terms: []
				}],
				shared: makeSnapshot().contexts.shared
			},
			initiatives: [bundle]
		}));
		store.selectInitiative(initiative.id);

		const view = await mountView(store);
		expect(view.shadowRoot?.querySelector(".d-sub")).toBeNull();

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="context"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector(".context-tab-summary")?.textContent).toContain("Console Viewer Context");
		expect(view.shadowRoot?.querySelector(".context-tab-summary")?.textContent).toContain("Build the **viewer**");
	});

	it("renders the overview body flat, without a boxed collapsible section", async () => {
		const initiative = makeEntity({
			body: "Overview of the work.\n\n## Plan\n\nShip the **initiative** detail pane.",
			bodySource: "authored",
			id: "INIT1",
			kind: "initiative",
			status: "active",
			title: "Console Viewer"
		});
		const store = makeStore(makeBundle(initiative));

		const view = await mountView(store);
		await view.updateComplete;

		const overview = view.shadowRoot?.querySelector(".initiative-body");
		expect(overview?.classList.contains("sec")).toBe(false);
		expect(view.shadowRoot?.querySelector('.sec-toggle[data-section-id="overview-body"]')).toBeNull();
	});

	it("keeps the overview free of record sections that have dedicated tabs", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", status: "draft", title: "Graph PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "SVG graph layout" });
		const store = makeStore(makeBundle(initiative, { adrs: [adr], issues: [issue], prds: [prd], userStories: [story] }));

		const view = await mountView(store);
		const overviewText = view.shadowRoot?.querySelector('[role="tabpanel"]')?.textContent ?? "";

		expect(overviewText).not.toContain("User stories & issues");
		expect(overviewText).not.toContain("Unassigned issues");
		expect(overviewText).not.toContain("Graph PRD");
		expect(overviewText).not.toContain("SVG graph layout");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="prds"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('.record-tab-list .line[data-id="PRD1"]')).not.toBeNull();
	});

	it("shows initiative-owned Plans and restores the initiative after closing a plan", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "ready", title: "Viewer implementation" });
		const bundle = makeBundle(initiative, { entities: [initiative, plan] });
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(makeSnapshot({ entities: [initiative, plan], initiatives: [bundle] }));
		store.selectInitiative(initiative.id);
		const view = await mountView(store);

		expect(tabLabels(view)).toEqual(["Overview", "Plans", "Graph"]);
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="plans"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-tab-list .line[data-id="PLAN1"]')).not.toBeNull();

		store.selectEntity(plan.id);
		store.closeEntity();
		expect(store.activePage.get()).toBe("initiative");
		expect(store.selectedInitiativeId.get()).toBe(initiative.id);
	});

	it("renders owned and resolved debt in distinct initiative sections", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const ownedDebt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open", title: "Replace legacy storage" });
		const resolvedDebt = makeEntity({ category: "process", id: "DEBT2", kind: "debt", priority: "medium", status: "resolved", title: "Document incident response" });
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, ownedDebt, resolvedDebt],
				initiatives: [makeBundle(initiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: ownedDebt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: resolvedDebt.id, type: "resolves" }
				]
			})
		);
		store.selectInitiative(initiative.id);
		const view = await mountView(store);

		const sectionTitles = [...(view.shadowRoot?.querySelectorAll(".sec-title") ?? [])].map((title) => title.textContent?.trim());
		expect(sectionTitles).toEqual(expect.arrayContaining(["Owned debt", "Resolves debt"]));
		expect(view.shadowRoot?.querySelector<HTMLElement>('.line[data-id="DEBT1"]')?.shadowRoot?.textContent).toContain("Replace legacy storage");
		expect(view.shadowRoot?.querySelector<HTMLElement>('.line[data-id="DEBT2"]')?.shadowRoot?.textContent).toContain("Document incident response");
	});

});

describe("initiative detail record tabs", () => {
	it("hides deferred issues by default and permits Deferred and All statuses filters", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active" });
		const current = makeEntity({ id: "ISS1", kind: "issue", status: "todo" });
		const deferred = makeEntity({ id: "ISS2", kind: "issue", status: "deferred" });
		const nested = makeEntity({ id: "ISS3", kind: "issue", status: "todo" });
		const bundle = makeBundle(initiative, { issues: [current, deferred, nested], subIssueLinks: [{ parent: deferred, issue: nested }] });
		const store = makeStore(bundle);
		const view = await mountView(store);
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-tree [data-id="ISS2"]')).toBeNull();
		expect(view.shadowRoot?.querySelector('.record-tree [data-id="ISS3"]')).not.toBeNull();
		updateRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id).sort()).toEqual(["ISS1", "ISS3"]);
		updateRecordFilter(view, { status: "deferred" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2"]);
		updateRecordFilter(view, { status: "all" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id).sort()).toEqual(["ISS1", "ISS2", "ISS3"]);
		expect(store.initiativeStats(bundle)).toMatchObject({ issues: 2, done: 0, pct: 0 });
		expect(store.initiativeStats(makeBundle(initiative, { issues: [deferred] }))).toMatchObject({ issues: 0, done: 0, pct: 0 });
	});

	it("orders issues by expected completion through their blockers", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const completedBlocker = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Completed blocker" });
		const completedIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Completed issue" });
		const availableIssue = makeEntity({ id: "ISS3", kind: "issue", status: "todo", title: "Available issue" });
		const blockedIssue = makeEntity({ id: "ISS4", kind: "issue", status: "blocked", title: "Blocked issue" });
		const laterIssue = makeEntity({ id: "ISS5", kind: "issue", status: "blocked", title: "Later issue" });
		const unfinishedBlocker = makeEntity({ id: "ISS6", kind: "issue", status: "todo", title: "Unfinished stale blocker" });
		const bundle = makeBundle(initiative, {
			blockerLinks: [
				{ source: completedBlocker, target: completedIssue },
				{ source: unfinishedBlocker, target: completedIssue },
				{ source: availableIssue, target: blockedIssue },
				{ source: blockedIssue, target: laterIssue }
			],
			issues: [laterIssue, blockedIssue, availableIssue, completedIssue, unfinishedBlocker, completedBlocker]
		});
		const view = await mountView(makeStore(bundle));

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateRecordView(view, "issues", "list");
		await view.updateComplete;

		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS1", "ISS2", "ISS3", "ISS4", "ISS5", "ISS6"]);
	});

	it("ranks direct non-body field matches ahead of body matches", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const bodyMatch = makeEntity({ body: "This issue includes the priority phrase in its body.", id: "ISS1", kind: "issue", status: "todo", title: "Body match" });
		const fieldMatch = makeEntity({ category: "priority phrase", id: "ISS2", kind: "issue", status: "todo", title: "Field match" });
		const store = makeStore(makeBundle(initiative, { issues: [bodyMatch, fieldMatch] }));
		const view = await mountView(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateRecordView(view, "issues", "list");
		await view.updateComplete;
		updateRecordFilter(view, { query: "priority phrase" });
		await view.updateComplete;

		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2", "ISS1"]);
	});

	it("filters every entity field and directly linked record fields", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ body: "A companion phrase exists only on this related story.", id: "US1", kind: "userStory", status: "draft", title: "Filter related records" });
		const parentIssue = makeEntity({ body: "Parent metadata", id: "ISS_FULL_REFERENCE_123", kind: "issue", status: "todo", title: "Parent issue" });
		const childIssue = makeEntity({ body: "Child issue body field", id: "ISS2", kind: "issue", status: "todo", title: "Child issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: childIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);
		const view = await mountView(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateRecordView(view, "issues", "list");
		await view.updateComplete;
		updateRecordFilter(view, { query: "iss_full_reference_123" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS_FULL_REFERENCE_123", "ISS2"]);

		updateRecordFilter(view, { query: "companion phrase" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2"]);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="userStories"]')?.click();
		await view.updateComplete;
		updateRecordFilter(view, { query: "child issue body field" });
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-tab-list agent-issues-record-list-item[data-id="US1"]')).not.toBeNull();
	});

	it("switches issues and user stories between list and tree views", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Show issue hierarchy" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Parent issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Child issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: childIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});
		const store = makeStore(bundle);
		const view = await mountView(store);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLElement & { treeView: string }>("agent-issues-record-filter-toolbar")?.treeView).toBe("tree");
		expect(view.shadowRoot?.querySelector('.record-tree.issue-tree .issue-branch-children .child[data-id="ISS2"]')).not.toBeNull();
		updateRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector(".record-tree")).toBeNull();

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="userStories"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLElement & { treeView: string }>("agent-issues-record-filter-toolbar")?.treeView).toBe("tree");
		expect(view.shadowRoot?.querySelector('.story-tree-block agent-issues-record-list-item[data-id="US1"]')).not.toBeNull();
		expect(view.shadowRoot?.querySelector('.story-tree-block .issue-branch-children .child[data-id="ISS2"]')).not.toBeNull();
	});

	it("shows each related record type in a filterable tab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const todoIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Build filtered list" });
		const doneIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Ship the component" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", status: "accepted", title: "Use entity tabs" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Filter initiative records" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Unify record filters" });
		const bundle = makeBundle(initiative, {
			adrs: [adr],
			issues: [todoIssue, doneIssue],
			userStories: [story]
		});
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, todoIssue, doneIssue, adr, story, debt],
				initiatives: [bundle],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" }]
			})
		);
		store.selectInitiative(initiative.id);
		const view = await mountView(store);

		expect(tabLabels(view)).toEqual(["Overview", "Issues", "ADRs", "Graph", "User stories", "Debt"]);
		expect(tabRecordCounts(view)).toEqual({ adrs: "1", debt: "1", graph: "6", issues: "2", userStories: "1" });
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.getAttribute("aria-label")).toBe("Issues: 2 records");
		expect(view.shadowRoot?.querySelector('[data-tab="issues"] .subtab-count')?.getAttribute("aria-hidden")).toBe("true");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateRecordView(view, "issues", "list");
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2", "ISS1"]);

		updateRecordFilter(view, { query: "ship" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2"]);

		updateRecordFilter(view, { status: "done" });
		await view.updateComplete;
		expect(recordItems(view).map((item) => item.dataset.id)).toEqual(["ISS2"]);

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="debt"]')?.click();
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector('.record-tab-list agent-issues-record-list-item[data-id="DEBT1"]')).not.toBeNull();
		expect(view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.query).toBe("");
		expect(view.shadowRoot?.querySelector("agent-issues-record-filter-toolbar")?.status).toBe("all");
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="debt"]')?.getAttribute("aria-selected")).toBe("true");
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("initiative-tab-debt");

		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
		await view.updateComplete;
		updateRecordFilter(view, { query: "missing" });
		await view.updateComplete;
		expect(view.shadowRoot?.textContent).toContain("No issues match this filter.");
	});
});

	it("hides initiative tabs that have no useful data", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Standalone initiative" });
		const store = makeStore(makeBundle(initiative));
		const view = await mountView(store);

		expect(tabLabels(view)).toEqual(["Overview"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("initiative-tab-overview");
	});

	it("falls back to Overview when the selected tab loses its data", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Changing initiative" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Temporary issue" });
		const store = makeStore(makeBundle(initiative, { issues: [issue] }));
		store.setInitTab("issues");
		const view = await mountView(store);

		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.getAttribute("aria-selected")).toBe("true");
		store.snapshot.set(makeSnapshot({ initiatives: [makeBundle(initiative)] }));
		await view.updateComplete;

		expect([...view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []].map((tab) => tab.textContent?.trim())).toEqual(["Overview"]);
		expect(view.shadowRoot?.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("initiative-tab-overview");
	});

describe("initiative detail graph tab", () => {
	it("renders the relationship graph with a node per record on the graph subtab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			userStories: [story]
		});
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const nodes = view.shadowRoot?.querySelectorAll("agent-issues-relationship-graph") ?? [];
		expect(nodes.length).toBe(1);
		const svgNodes = nodes[0]?.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect(svgNodes.length).toBe(3);
	});

	it("uses the shared graph filter controls to hide an initiative graph column", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			userStories: [story]
		});
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const filters = view.shadowRoot?.querySelector("agent-issues-relationship-graph-filters");
		expect([...filters?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".graph-kind-chip") ?? []].map((chip) => chip.textContent?.trim())).toEqual([
			"Initiative",
			"Plan",
			"PRD",
			"ADR",
			"User story",
			"Issue",
			"Debt"
		]);

		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph?.shadowRoot?.querySelector('.ai-node[data-id="ISS1"]')).toBeNull();
		expect([...graph?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? []].map((node) => node.textContent?.trim())).not.toContain("Issues");

		for (const chip of filters?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.graph-kind-chip[aria-pressed="true"]') ?? []) {
			chip.click();
		}
		await view.updateComplete;
		expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[data-tab="graph"]')?.getAttribute("aria-selected")).toBe("true");
		expect(view.shadowRoot?.textContent).toContain("No graph records match the selected filters.");
	});

	it("renders sub-issues in their own graph column", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }]
		});
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const labels = [...(graph?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? [])].map((node) => node.textContent?.trim());

		expect(labels).toContain("Sub-issues");
	});

	it("opens a record when its graph node is clicked", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const bundle = makeBundle(initiative, { issues: [issue] });
		const store = makeStore(bundle);
		store.setInitTab("graph");

		const view = await mountView(store);
		await view.updateComplete;

		const graph = view.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const issueNode = graph?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ISS1"]');
		issueNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

		expect(store.selectedId.get()).toBe("ISS1");
	});
});

describe("initiative detail context tab", () => {
	it("renders the initiative glossary on the context subtab", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const bundle = makeBundle(initiative);
		const store = new AgentIssuesStore();
		store.connected = true;
		store.snapshot.set(
			makeSnapshot({
				contexts: {
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT1",
								scopeEntityId: "INIT1",
								scopeKind: "initiative",
								scopeLabel: "Console Viewer",
								summary: "How the console viewer is structured.",
								title: "Console Viewer Context",
								updatedAt: null
							},
							terms: [{ avoid: ["dashboard"], createdAt: "", definition: "The three-pane browser.", term: "Console", updatedAt: "" }]
						}
					],
					shared: makeSnapshot().contexts.shared
				},
				initiatives: [bundle]
			})
		);
		store.selectInitiative(initiative.id);
		store.setInitTab("context");

		const view = await mountView(store);
		await view.updateComplete;

		const text = view.shadowRoot?.querySelector(".record-tab")?.textContent ?? "";
		expect(text).toContain("How the console viewer is structured.");
		expect(text).toContain("Console");
		expect(text).toContain("The three-pane browser.");
		expect(text).toContain("dashboard");
	});
});
