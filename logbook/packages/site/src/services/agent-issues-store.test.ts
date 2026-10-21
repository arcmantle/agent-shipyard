import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, InitiativeBundle, Relation, Snapshot } from "../models.js";
import { AgentIssuesStore } from "./agent-issues-store.js";

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

function stubEventSource(): void {
	vi.stubGlobal(
		"EventSource",
		class {
			public onerror: (() => void) | null = null;
			public onmessage: ((event: MessageEvent<string>) => void) | null = null;

			public close() {}
		}
	);
}

beforeEach(() => {
	stubEventSource();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("personal instruction routing", () => {
	it("discards an instruction source response after the owner scope changes", async () => {
		let resolveSource!: (response: Response) => void;
		const pendingSource = new Promise<Response>((resolve) => { resolveSource = resolve; });
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).startsWith("/api/instructions/source")) return pendingSource;
			return new Response(JSON.stringify({ kind: "available", projects: [] }));
		});
		const store = new AgentIssuesStore();
		store.selectedTenant.set("owner-a");
		store.activePage.set("instructions");
		const read = store.selectInstruction("skill/prepare");
		await store.selectTenant("owner-b");
		resolveSource(new Response(JSON.stringify({ key: "skill/prepare", body: "Owner A content", version: "0.2.0" })));
		await read;
		expect(store.instructionSource.get()).toBeNull();
		expect(store.instructionCatalog.get()).toBeNull();
		expect(store.selectedInstructionKey.get()).toBeNull();
		expect(store.instructionSourceLoading.get()).toBe(false);
	});

	it("restores a direct personal instruction route without loading project data", async () => {
		window.history.replaceState({}, "", "/#tenant=demo&page=instructions&category=skill&instruction=skill%2Fprepare");
		const historyLength = window.history.length;
		const item = { key: "skill/prepare", kind: "skill", body: "# Prepare", source: { type: "default", revision: 1, contentHash: "hash" } };
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname === "/api/instructions/catalog") return new Response(JSON.stringify({ version: "0.2.0", items: [item], owner: { type: "local" } }));
			expect(url.pathname).toBe("/api/instructions/source");
			return new Response(JSON.stringify({ ...item, version: "0.2.0" }));
		});
		const store = new AgentIssuesStore();
		await store.onBrowserNavigation();
		expect(store.activePage.get()).toBe("instructions");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.instructionCategory.get()).toBe("skill");
		expect(store.instructionSource.get()?.body).toBe("# Prepare");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(window.history.length).toBe(historyLength);
		window.history.replaceState({}, "", "/");
	});
});

describe("global search request lifecycle", () => {
	it("searches a one-character query after the debounce delay", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ results: [], state: "available" }), { status: 200 }));

		store.setGlobalSearchQuery("a");
		await vi.advanceTimersByTimeAsync(149);
		expect(fetchMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/search?tenant=demo&project=PROJ1&query=a"),
			expect.objectContaining({ cache: "no-store" })
		);
		expect(store.globalSearchResponse.get()).toEqual({ results: [], state: "available" });
	});

	it("searches all tenant projects with selected record-kind filters", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ results: [], state: "available" }), { status: 200 }));

		store.setGlobalSearchScope("all-projects");
		store.setGlobalSearchSourceTypes(["plan-entry", "context"]);
		store.setGlobalSearchQuery("planning");
		await vi.advanceTimersByTimeAsync(150);

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/search?tenant=demo&project=PROJ1&query=planning&scope=all-projects&sourceTypes=plan-entry%2Ccontext"),
			expect.objectContaining({ cache: "no-store" })
		);
	});

	it("keeps the last valid results when a later query has a parse error", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({
				results: [{ id: "search-ISS1" }],
				state: "available"
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				error: { end: 9, message: "Expected a term after OR.", start: 7 },
				state: "parse-error"
			}), { status: 200 }));

		store.setGlobalSearchQuery("planning");
		await vi.advanceTimersByTimeAsync(150);
		store.setGlobalSearchQuery("planning OR");
		await vi.advanceTimersByTimeAsync(150);

		expect(store.globalSearchResponse.get()).toEqual({
			error: { end: 9, message: "Expected a term after OR.", start: 7 },
			state: "parse-error"
		});
		expect(store.globalSearchResults.get()).toEqual([{ id: "search-ISS1" }]);
	});

	it("keeps results from a newer query when an older request resolves later", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		let resolveFirstResponse: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirstResponse = resolve;
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: [], state: "available" }), { status: 200 }));

		store.setGlobalSearchQuery("a");
		await vi.advanceTimersByTimeAsync(150);
		store.setGlobalSearchQuery("b");
		await vi.advanceTimersByTimeAsync(150);
		resolveFirstResponse!(new Response(JSON.stringify({ state: "rebuilding" }), { status: 200 }));
		await vi.runAllTimersAsync();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.globalSearchResponse.get()).toEqual({ results: [], state: "available" });
	});

	it("loads the typed provider capability for the selected tenant", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ state: "unsupported" }), { status: 200 }));

		await store.reloadGlobalSearchCapability();

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/search/capability?tenant=demo"),
			expect.objectContaining({ cache: "no-store" })
		);
		expect(store.globalSearchCapability.get()).toEqual({ state: "unsupported" });
	});

	it("delays progress feedback while a search request is pending", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));

		store.setGlobalSearchQuery("a");
		await vi.advanceTimersByTimeAsync(150);
		expect(store.globalSearchProgress.get()).toBe(false);

		await vi.advanceTimersByTimeAsync(150);
		expect(store.globalSearchProgress.get()).toBe(true);
	});

	it("retries the latest valid request after an operational error", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ results: [], state: "available" }), { status: 200 }));

		store.setGlobalSearchQuery("a");
		await vi.advanceTimersByTimeAsync(150);
		expect(store.globalSearchResponse.get()).toEqual({ state: "operational-error" });

		await store.retryGlobalSearch();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.globalSearchResponse.get()).toEqual({ results: [], state: "available" });
	});

	it("cancels pending global search work when the store disconnects", async () => {
		vi.useFakeTimers();
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));

		store.setGlobalSearchQuery("a");
		await vi.advanceTimersByTimeAsync(150);
		const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

		store.disconnect();

		expect(signal.aborted).toBe(true);
	});

	it("stores recently opened global search record identities for the current project", () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.globalSearchQuery.set("private query text");

		store.openSearchTarget({ entityId: "ISS1", type: "entity" });

		expect(JSON.parse(window.localStorage.getItem("agent-issues-global-search-recents:demo:PROJ1") ?? "[]")).toEqual([
			{ entityId: "ISS1", type: "entity" }
		]);
	});
});

describe("short entity references", () => {
	it("separates the kind prefix from the display code", () => {
		const store = new AgentIssuesStore();

		expect(store.shortRef({ id: "issue-identifier", kind: "issue" })).toMatch(/^ISS_[0-9A-HJKMNP-TV-Z]{6}$/);
	});
});

describe("debt records", () => {
		it("defaults to open debt records", () => {
			const openDebt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Replace legacy storage" });
			const resolvedDebt = makeEntity({ id: "DEBT2", kind: "debt", status: "resolved", title: "Remove temporary endpoint" });
			const store = new AgentIssuesStore();
			store.snapshot.set(makeSnapshot({ entities: [openDebt, resolvedDebt] }));

			expect(store.debtRecords.get()).toEqual([openDebt]);
		});

		it("combines lifecycle, category, and priority filters", () => {
			const matchingDebt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open" });
			const categoryMismatch = makeEntity({ category: "process", id: "DEBT2", kind: "debt", priority: "high", status: "open" });
			const priorityMismatch = makeEntity({ category: "technical", id: "DEBT3", kind: "debt", priority: "low", status: "open" });
			const lifecycleMismatch = makeEntity({ category: "technical", id: "DEBT4", kind: "debt", priority: "high", status: "resolved" });
			const store = new AgentIssuesStore();
			store.snapshot.set(makeSnapshot({ entities: [matchingDebt, categoryMismatch, priorityMismatch, lifecycleMismatch] }));

			store.setDebtFilter("category", "technical");
			store.setDebtFilter("priority", "high");

			expect(store.debtRecords.get()).toEqual([matchingDebt]);
		});
});

describe("initiative relationship graph model", () => {
	it("uses in-force and archived tones for ADR lifecycle states", () => {
		const store = new AgentIssuesStore();

		expect(store.statusTone("current")).toBe("success");
		expect(store.badgeTone("current")).toBe("success");
		expect(store.statusTone("archived")).toBe("neutral");
		expect(store.badgeTone("archived")).toBe("neutral");
	});

	it("lays the initiative, its PRDs/ADRs, stories, and issues into ordered columns", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "done", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			adrs: [adr],
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			prds: [prd],
			userStories: [story]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"]);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("INIT1")).toBe(0);
		expect(nodeColumns.get("PRD1")).toBe(1);
		expect(nodeColumns.get("ADR1")).toBe(1);
		expect(nodeColumns.get("US1")).toBe(2);
		expect(nodeColumns.get("ISS1")).toBe(3);
	});

	it("connects each issue to the user story it fixes", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render nodes" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue, userStory: story }],
			issues: [issue],
			userStories: [story]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.edges).toContainEqual({ from: "US1", to: "ISS1" });
	});

	it("shows sub-issues in later columns and connects parent issues to them", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", status: "done", title: "Sub-issue" });
		const bundle = makeBundle(initiative, {
			issues: [parentIssue, subIssue],
			subIssueLinks: [{ issue: subIssue, parent: parentIssue }]
		});
		const store = new AgentIssuesStore();

		const graph = store.buildInitiativeGraph(bundle);

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Sub-issues", "Debt records"]);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("ISS1")).toBe(3);
		expect(nodeColumns.get("ISS2")).toBe(4);
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "ISS1" });
		expect(graph.edges).toContainEqual({ from: "ISS1", to: "ISS2" });
	});

	it("renders initiative-owned debt with its ownership relation", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Replace legacy storage" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, debt],
				initiatives: [makeBundle(initiative)],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" }]
			})
		);

		const graph = store.buildInitiativeGraph(makeBundle(initiative));

		expect(graph.columns).toEqual(["Initiative", "Plans, PRDs & ADRs", "User stories", "Issues", "Debt records"]);
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ col: 4, id: debt.id, kind: "debt", label: debt.title })
		);
		expect(graph.edges).toContainEqual({ from: initiative.id, label: "records", to: debt.id });
	});

	it("renders debt remediation and context links within the initiative graph", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Replace storage" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue, debt],
				initiatives: [makeBundle(initiative, { issues: [issue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: issue.id, toId: debt.id, type: "resolves" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: debt.id, toId: issue.id, type: "relatesTo" }
				]
			})
		);

		const graph = store.buildInitiativeGraph(makeBundle(initiative, { issues: [issue] }));

		expect(graph.edges).toEqual(
			expect.arrayContaining([
				{ from: issue.id, label: "resolves", to: debt.id },
				{ from: debt.id, label: "relatesTo", to: issue.id }
			])
		);
	});
});

describe("project relationship graph model", () => {
	it("lays project decisions beneath the project and work beneath each epic", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", status: "ready", title: "Viewer implementation plan" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const initiativeAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Render graph nodes" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const bundle = makeBundle(initiative, { adrs: [initiativeAdr], entities: [initiative, plan, prd, initiativeAdr, story, issue], fixLinks: [{ issue, userStory: story }], issues: [issue], prds: [prd], userStories: [story] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic],
				initiatives: [bundle],
				projectAdrs: [projectAdr],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: plan.id, toId: prd.id, type: "informs" }
				]
			})
		);

		const graph = store.buildProjectGraph();

		expect(graph.columns).toEqual(["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories", "Issues"]);
		const projectNode = graph.nodes.find((node) => node.kind === "project");
		expect(projectNode?.col).toBe(0);
		const nodeColumns = new Map(graph.nodes.map((node) => [node.id, node.col]));
		expect(nodeColumns.get("EPIC1")).toBe(1);
		expect(nodeColumns.get("INIT1")).toBe(2);
		expect(nodeColumns.get("PLAN1")).toBe(3);
		expect(nodeColumns.get("PRD1")).toBe(3);
		expect(nodeColumns.get("ADR1")).toBe(3);
		expect(nodeColumns.get("ADR2")).toBe(1);
		expect(nodeColumns.get("US1")).toBe(4);
		expect(nodeColumns.get("ISS1")).toBe(5);
		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "EPIC1" });
		expect(graph.edges).toContainEqual({ from: "EPIC1", to: "INIT1" });
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "INIT1:PLAN1" });
		expect(graph.edges).toContainEqual({ from: "INIT1:PLAN1", label: "informs", to: "INIT1:PRD1" });
		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "ADR2" });
		expect(graph.edges).toContainEqual({ from: "INIT1:US1", to: "INIT1:ISS1" });

		store.toggleProjectGraphKind("issue");
		const graphWithoutIssues = store.buildProjectGraph();
		expect(graphWithoutIssues.columns).toEqual(["Project", "Epics", "Initiatives", "Plans, PRDs & ADRs", "User stories"]);
		expect(graphWithoutIssues.nodes.map((node) => node.id)).not.toContain("ISS1");
		expect(graphWithoutIssues.edges).not.toContainEqual({ from: "INIT1:US1", to: "INIT1:ISS1" });
	});

	it("connects the project to each epic, epics to initiatives, and initiatives to their records", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const bundle = makeBundle(initiative, { prds: [prd] });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("content-hub");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic],
				initiatives: [bundle],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" }]
			})
		);

		const graph = store.buildProjectGraph();
		const projectNode = graph.nodes.find((node) => node.kind === "project");

		expect(graph.edges).toContainEqual({ from: projectNode?.key, to: "EPIC1" });
		expect(graph.edges).toContainEqual({ from: "EPIC1", to: "INIT1" });
		expect(graph.edges).toContainEqual({ from: "INIT1", to: "INIT1:PRD1" });
	});

	it("renders debt ownership, remediation, and context links", () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Replace storage" });
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [epic, initiative, issue, debt],
				initiatives: [makeBundle(initiative, { issues: [issue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: debt.id, type: "records" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: issue.id, toId: debt.id, type: "resolves" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: debt.id, toId: issue.id, type: "relatesTo" }
				]
			})
		);

		const graph = store.buildProjectGraph();

		expect(graph.columns).toContain("Debt records");
		expect(graph.nodes).toContainEqual(
			expect.objectContaining({ col: graph.columns.indexOf("Debt records"), id: debt.id, kind: "debt", label: debt.title })
		);
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				{ from: initiative.id, label: "records", to: debt.id },
				{ from: `${initiative.id}:${issue.id}`, label: "resolves", to: debt.id },
				{ from: debt.id, label: "relatesTo", to: `${initiative.id}:${issue.id}` }
			])
		);
	});

	it("filters debt and its edges from the project graph", () => {
		const debt = makeEntity({ id: "DEBT1", kind: "debt", status: "open", title: "Retire legacy storage" });
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.snapshot.set(
			makeSnapshot({
				entities: [debt],
				relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "PROJ1", toId: debt.id, type: "records" }]
			})
		);

		store.toggleProjectGraphKind("debt");
		const graph = store.buildProjectGraph();

		expect(graph.nodes.map((node) => node.kind)).not.toContain("debt");
		expect(graph.edges).not.toContainEqual(expect.objectContaining({ label: "records", to: debt.id }));
	});
});

describe("project context discovery", () => {
	it("includes child sub-issues beneath a fixing parent issue in a story tree", () => {
		const store = new AgentIssuesStore();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "draft", title: "Explore the graph" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", status: "blocked", title: "Parent issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Child issue" });
		const bundle = makeBundle(initiative, {
			fixLinks: [{ issue: parentIssue, userStory: story }],
			issues: [parentIssue, childIssue],
			subIssueLinks: [{ issue: childIssue, parent: parentIssue }],
			userStories: [story]
		});

		const tree = store.issueTreeForStory(bundle, story.id);

		expect(tree).toHaveLength(1);
		expect(tree[0]?.issue.id).toBe("ISS1");
		expect(tree[0]?.children.map((node) => node.issue.id)).toEqual(["ISS2"]);
	});

	it("labels decomposed issues as sub-issues and parent issues in linked sections", () => {
		const store = new AgentIssuesStore();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", title: "Sub-issue" });

		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, parentIssue, subIssue],
				initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: initiative.id, toId: parentIssue.id, type: "tracks" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: parentIssue.id, toId: subIssue.id, type: "decomposes" }
				]
			})
		);

		store.selectedId.set(parentIssue.id);
		expect(store.linkedRecordSections().map((section) => section.title)).toContain("Sub-issues");

		store.selectedId.set(subIssue.id);
		expect(store.linkedRecordSections().map((section) => section.title)).toContain("Parent issue");
	});

	it("groups shared and initiative-scoped terms and flags duplicates", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				contexts: {
					shared: {
						context: {
							createdAt: null,
							exists: true,
							key: "default",
							scopeEntityId: null,
							scopeKind: "default",
							scopeLabel: "Shared",
							summary: "Project language.",
							title: "Shared Context",
							updatedAt: null
						},
						terms: [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }]
					},
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT1",
								scopeEntityId: "INIT1",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [
								{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" },
								{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }
							]
						}
					]
				}
			})
		);

		const entries = store.projectContextTerms.get();
		expect(entries.map((entry) => entry.term)).toEqual(["Order", "Settlement"]);

		const order = entries.find((entry) => entry.term === "Order");
		expect(order?.hasDuplicates).toBe(true);
		expect(order?.hasSharedSource).toBe(true);
		expect(order?.hasConflictingDefinitions).toBe(true);
		expect(order?.sources.map((source) => source.scopeLabel)).toEqual(["Shared", "Payments"]);
	});
});

describe("id-driven detail resolution", () => {
	it("resolves the owning bundle for an arbitrary entity id without using the selection", () => {
		const firstInitiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const secondInitiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire the detail pane" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [firstInitiative, secondInitiative, issue],
				initiatives: [
					makeBundle(firstInitiative),
					makeBundle(secondInitiative, { issues: [issue] })
				]
			})
		);

		const bundle = store.bundleForEntityId("ISS9");

		expect(bundle?.initiative.id).toBe("INIT2");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven relations resolution", () => {
	it("resolves outgoing and incoming relations for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", title: "Wire detail" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, story, issue],
				initiatives: [makeBundle(initiative, { issues: [issue], userStories: [story] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS9", toId: "US1", type: "fixes" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT1", toId: "ISS9", type: "tracks" }
				]
			})
		);

		expect(store.outgoingRelationsFor("ISS9").map((relation) => relation.toId)).toEqual(["US1"]);
		expect(store.incomingRelationsFor("ISS9").map((relation) => relation.fromId)).toEqual(["INIT1"]);
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven linked record sections", () => {
	it("groups linked records for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", title: "Parent issue" });
		const subIssue = makeEntity({ id: "ISS2", kind: "issue", title: "Sub-issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, parentIssue, subIssue],
				initiatives: [makeBundle(initiative, { issues: [parentIssue, subIssue] })],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "INIT1", toId: "ISS1", type: "tracks" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "ISS1", toId: "ISS2", type: "decomposes" }
				]
			})
		);

		const titles = store.linkedRecordSectionsFor("ISS1").map((section) => section.title);

		expect(titles).toContain("Sub-issues");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven detail meta", () => {
	it("builds meta naming the owning initiative for an arbitrary id without using the selection", () => {
		const initiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const issue = makeEntity({ id: "ISS9", kind: "issue", status: "todo", title: "Wire detail" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue],
				initiatives: [makeBundle(initiative, { issues: [issue] })]
			})
		);

		const meta = new Map(store.detailMetaFor("ISS9"));

		expect(meta.get("Initiative")).toBe(`${store.shortRef(initiative)} Status derivation`);
		expect(meta.get("Status")).toBe("todo");
		expect(store.selectedId.get()).toBeNull();
	});
});

describe("id-driven initiative bundle", () => {
	it("resolves an initiative bundle for an arbitrary initiative id without using the selection", () => {
		const firstInitiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const secondInitiative = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Status derivation" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [firstInitiative, secondInitiative],
				initiatives: [makeBundle(firstInitiative), makeBundle(secondInitiative)]
			})
		);

		const bundle = store.bundleForInitiativeId("INIT2");

		expect(bundle?.initiative.id).toBe("INIT2");
		expect(store.selectedInitiativeId.get()).toBeNull();
	});
});

describe("progressive initiative detail loading", () => {
	it("prefetches initiative tabs one at a time without duplicating a tab opened early", async () => {
		vi.useFakeTimers();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 1, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
			const path = String(resource);
			if (path.includes("/api/initiative-detail")) {
				return new Response(JSON.stringify({ initiative }), { status: 200 });
			}
			const tab = new URL(path, "http://localhost").searchParams.get("tab");
			return new Response(JSON.stringify({ records: [], relations: [], tab }), { status: 200 });
		});

		store.selectInitiative(initiative.id);
		await vi.advanceTimersByTimeAsync(0);
		store.setInitTab("adrs");
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/initiative-tab")).length).toBe(1);

		for (let index = 0; index < 10; index += 1) {
			await vi.advanceTimersByTimeAsync(400);
		}

		const tabRequests = fetchMock.mock.calls
			.map(([resource]) => String(resource))
			.filter((path) => path.includes("/api/initiative-tab"));
		expect(new Set(tabRequests.map((path) => new URL(path, "http://localhost").searchParams.get("tab")))).toEqual(
			new Set(["issues", "plans", "prds", "adrs", "context", "userStories", "debt", "graph"])
		);
		expect(tabRequests.filter((path) => path.includes("tab=adrs"))).toHaveLength(1);
	});

	it("cancels remaining initiative tab prefetch when another initiative opens", async () => {
		vi.useFakeTimers();
		const first = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "First" });
		const second = makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Second" });
		const toSummary = (initiative: Entity) => ({ createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt });
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 2 },
			epics: [{ epic: { ...toSummary(first), id: "EPIC1", kind: "epic" }, initiatives: [first, second].map((initiative) => ({ completedIssueCount: 0, initiative: toSummary(initiative), issueCount: 0, userStoryCount: 0 })) }],
			kind: "available",
			project: { ...toSummary(first), id: "PROJ1", kind: "project" }
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
			const path = String(resource);
			const initiative = path.includes("INIT2") ? second : first;
			if (path.includes("/api/initiative-detail")) return new Response(JSON.stringify({ initiative }), { status: 200 });
			return new Response(JSON.stringify({ records: [], relations: [], tab: new URL(path, "http://localhost").searchParams.get("tab") }), { status: 200 });
		});

		store.selectInitiative(first.id);
		await vi.advanceTimersByTimeAsync(400);
		store.selectInitiative(second.id);
		await vi.advanceTimersByTimeAsync(4000);

		const firstTabRequests = fetchMock.mock.calls.filter(([resource]) => String(resource).includes("initiative=INIT1&tab="));
		expect(firstTabRequests).toHaveLength(1);
	});

	it("does not duplicate a tab request while its background prefetch is pending", async () => {
		vi.useFakeTimers();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 1, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		let resolveIssues: (response: Response) => void;
		const issuesResponse = new Promise<Response>((resolve) => {
			resolveIssues = resolve;
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((resource) => {
			const path = String(resource);
			if (path.includes("/api/initiative-detail")) return Promise.resolve(new Response(JSON.stringify({ initiative }), { status: 200 }));
			if (path.includes("tab=issues")) return issuesResponse;
			return Promise.resolve(new Response(JSON.stringify({ records: [], relations: [], tab: new URL(path, "http://localhost").searchParams.get("tab") }), { status: 200 }));
		});

		store.selectInitiative(initiative.id);
		await vi.advanceTimersByTimeAsync(400);
		store.setInitTab("issues");
		await vi.advanceTimersByTimeAsync(2000);

		let tabRequests = fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/initiative-tab"));
		expect(tabRequests).toHaveLength(1);
		expect(String(tabRequests[0]?.[0])).toContain("tab=issues");

		resolveIssues!(new Response(JSON.stringify({ records: [], relations: [], tab: "issues" }), { status: 200 }));
		await vi.advanceTimersByTimeAsync(400);
		tabRequests = fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/initiative-tab"));
		expect(tabRequests).toHaveLength(2);
		expect(String(tabRequests[1]?.[0])).toContain("tab=plans");
	});

	it("waits for initiative detail before it starts tab prefetch", async () => {
		vi.useFakeTimers();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		let resolveDetail: (response: Response) => void;
		const detailResponse = new Promise<Response>((resolve) => {
			resolveDetail = resolve;
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((resource) => {
			const path = String(resource);
			if (path.includes("/api/initiative-detail")) return detailResponse;
			return Promise.resolve(new Response(JSON.stringify({ records: [], relations: [], tab: "issues" }), { status: 200 }));
		});

		store.selectInitiative(initiative.id);
		await vi.advanceTimersByTimeAsync(800);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		resolveDetail!(new Response(JSON.stringify({ initiative }), { status: 200 }));
		await vi.advanceTimersByTimeAsync(400);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/initiative-tab");
	});

	it("loads direct initiative routes in detail, active tab, then prefetch order", async () => {
		vi.useFakeTimers();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.connected = true;
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		let resolveDetail: (response: Response) => void;
		const detailResponse = new Promise<Response>((resolve) => {
			resolveDetail = resolve;
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((resource) => {
			const path = String(resource);
			if (path.includes("/api/initiative-detail")) return detailResponse;
			return Promise.resolve(new Response(JSON.stringify({ records: [], relations: [], tab: new URL(path, "http://localhost").searchParams.get("tab") }), { status: 200 }));
		});
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=adrs");

		await store.onPopState();
		await vi.advanceTimersByTimeAsync(800);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		resolveDetail!(new Response(JSON.stringify({ initiative }), { status: 200 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1]?.[0])).toContain("tab=adrs");

		await vi.advanceTimersByTimeAsync(400);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(String(fetchMock.mock.calls[2]?.[0])).toContain("tab=issues");
	});

	it("loads only the selected initiative detail from a Project Summary rollup", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const initiativeSummary = {
			createdAt: initiative.createdAt,
			id: initiative.id,
			kind: initiative.kind,
			status: initiative.status,
			title: initiative.title,
			updatedAt: initiative.updatedAt
		};
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ initiative }), { status: 200 }));

		store.selectInitiative(initiative.id);
		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/initiative-detail?initiative=INIT1&tenant=demo"),
				expect.objectContaining({ cache: "no-store" })
			);
		});

		expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/tabs/"), expect.anything());
	});

	it("loads an activated tab once and reuses its cached data", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const initiativeSummary = {
			createdAt: initiative.createdAt,
			id: initiative.id,
			kind: initiative.kind,
			status: initiative.status,
			title: initiative.title,
			updatedAt: initiative.updatedAt
		};
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ initiative }), { status: 200 }));

		store.selectInitiative(initiative.id);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ records: [], relations: [], tab: "issues" }), { status: 200 }));

		store.setInitTab("issues");
		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/initiative-tab?initiative=INIT1&tab=issues&tenant=demo"),
			expect.objectContaining({ cache: "no-store" })
			);
		});
		store.setInitTab("overview");
		store.setInitTab("issues");

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a failed initiative detail request", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ initiative }), { status: 200 }));

		store.selectInitiative(initiative.id);
		await vi.waitFor(() => expect(store.initiativeDetails.get().get(initiative.id)?.error).toBe("Request failed for /api/initiative-detail?initiative=INIT1&tenant=demo&project=PROJ1"));

		await store.retryInitiativeDetail(initiative.id);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.initiativeDetailForId(initiative.id)).toEqual({ initiative });
	});

	it("clears the active initiative when its detail is unavailable", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic", title: "Viewer work" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project", title: "Project" }
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ kind: "unavailable" }), { status: 200 }));

		store.selectInitiative(initiative.id);

		await vi.waitFor(() => expect(store.selectedInitiativeId.get()).toBeNull());
		expect(store.activePage.get()).toBe("list");
	});
});

describe("progressive entity detail loading", () => {
	it("loads a selected entity through its scoped detail route", async () => {
		const entity = makeEntity({ id: "ISS1", title: "Scoped entity" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ entity }), { status: 200 }));

		store.selectEntity(entity.id);

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/entity-detail?entity=ISS1&tenant=demo&project=PROJ1"),
				expect.objectContaining({ cache: "no-store" })
			);
			expect(store.entityForId(entity.id)).toEqual(entity);
		});
	});

	it("exposes local relations from a selected entity detail response", async () => {
		const entity = makeEntity({ id: "ISS1", title: "Scoped entity" });
		const parent = makeEntity({ id: "INIT1", kind: "initiative", title: "Scoped initiative" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			entity,
			incoming: [{ entity: parent, relationType: "tracks" }],
			outgoing: [],
			planEntries: []
		}), { status: 200 }));

		store.selectEntity(entity.id);

		await vi.waitFor(() => {
			expect(store.incomingRelationsFor(entity.id)).toEqual([
				{ createdAt: entity.createdAt, fromId: parent.id, toId: entity.id, type: "tracks" }
			]);
			expect(store.entityForId(parent.id)).toEqual({ ...parent, body: "" });
		});
	});

	it("loads a Plan-entry page only when the Plan tab opens", async () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Scoped Plan" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ entries: [], nextBefore: null, total: 0 }), { status: 200 }));

		store.requestEntityTab(plan.id, "plan");

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/plan-entries?plan=PLAN1&tenant=demo"),
				expect.objectContaining({ cache: "no-store" })
			);
			expect(store.planEntriesFor(plan.id)).toEqual([]);
		});
	});

	it("appends the next Plan-entry page through its cursor", async () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Scoped Plan" });
		const firstEntry = { body: "First", createdAt: "2026-01-01T00:00:00.000Z", id: "ENTRY1", planId: plan.id, reference: "PLAN_ENTRY_1", referencedEntityIds: [], role: "decision" as const, scopeDirection: null, supersededEntryIds: [], tombstone: false, updatedAt: "2026-01-01T00:00:00.000Z" };
		const secondEntry = { ...firstEntry, body: "Second", id: "ENTRY2", reference: "PLAN_ENTRY_2" };
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [firstEntry], nextBefore: "cursor-1", total: 2 }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [secondEntry], nextBefore: null, total: 2 }), { status: 200 }));

		store.requestEntityTab(plan.id, "plan");
		await vi.waitFor(() => expect(store.planEntriesFor(plan.id)).toEqual([firstEntry]));
		await store.loadMorePlanEntries(plan.id);

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/plan-entries?plan=PLAN1&before=cursor-1&tenant=demo"),
			expect.objectContaining({ cache: "no-store" })
		);
		expect(store.planEntriesFor(plan.id)).toEqual([firstEntry, secondEntry]);
	});

	it("preserves comment authors when it appends an older comment page", async () => {
		const firstUser = { authenticationSubject: "ada", displayName: "Ada", id: "USER1", updatedAt: "2026-01-02T00:00:00.000Z" };
		const secondUser = { authenticationSubject: "ben", displayName: "Ben", id: "USER2", updatedAt: "2026-01-01T00:00:00.000Z" };
		const firstComment = { body: "Newer", contentHash: "hash-1", createdAt: "2026-01-02T00:00:00.000Z", createdBy: firstUser.id, id: "COMMENT1", issueId: "ISS1", reference: "COM_1", referencedIssueIds: [], revision: 1, tombstone: false, updatedAt: "2026-01-02T00:00:00.000Z", updatedBy: firstUser.id };
		const secondComment = { ...firstComment, body: "Older", createdAt: "2026-01-01T00:00:00.000Z", createdBy: secondUser.id, id: "COMMENT2", reference: "COM_2", updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: secondUser.id };
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.issueCommentPages.set(new Map([[
			"ISS1",
			{ data: { comments: [firstComment], users: [firstUser], nextBefore: "cursor-1", total: 2 }, error: null, loading: false }
		]]));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ comments: [secondComment], users: [secondUser], nextBefore: null, total: 2 }), { status: 200 }));

		await store.loadMoreIssueComments("ISS1");

		expect(store.issueCommentPages.get().get("ISS1")?.data).toEqual(expect.objectContaining({
			comments: [firstComment, secondComment],
			users: [firstUser, secondUser]
		}));
	});

	it("builds the Plan projection from scoped entries without a snapshot", () => {
		const question = { body: "Which entries are current?", createdAt: "2026-01-01T00:00:00.000Z", id: "ENTRY1", planId: "PLAN1", reference: "PLAN_ENTRY_1", referencedEntityIds: [], role: "question" as const, scopeDirection: null, supersededEntryIds: [], tombstone: false, updatedAt: "2026-01-01T00:00:00.000Z" };
		const decision = { ...question, body: "Use scoped pages.", createdAt: "2026-01-02T00:00:00.000Z", id: "ENTRY2", reference: "PLAN_ENTRY_2", role: "decision" as const, supersededEntryIds: [question.id] };
		const store = new AgentIssuesStore();
		store.planEntryPages.set(new Map([[
			"PLAN1",
			{ data: { entries: [decision, question], nextBefore: null, total: 2 }, error: null, loading: false }
		]]));

		const projection = store.planProjectionFor("PLAN1");

		expect(store.snapshot.get()).toBeNull();
		expect(projection.history).toEqual([question, decision]);
		expect(projection.current.find((group) => group.key === "questions")?.entries).toEqual([]);
		expect(projection.current.find((group) => group.key === "decisions")?.entries).toEqual([decision]);
	});
});

describe("progressive project section loading", () => {
	it("projects initiative ADRs and Context terms from scoped section responses", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Payments" });
		const projectAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Project decision" });
		const initiativeAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Initiative decision" });
		const sharedContext = {
			context: {
				createdAt: null,
				exists: true,
				key: "shared",
				scopeEntityId: null,
				scopeKind: "default" as const,
				scopeLabel: "Shared",
				summary: "Project language.",
				title: "Shared Context",
				updatedAt: null
			},
			terms: [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }]
		};
		const initiativeContext = {
			context: {
				createdAt: null,
				exists: true,
				key: "INIT1",
				scopeEntityId: "INIT1",
				scopeKind: "initiative" as const,
				scopeLabel: "Payments",
				summary: "Payments language.",
				title: "Payments Context",
				updatedAt: null
			},
			terms: [{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" }]
		};
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({
				initiativeAdrs: [{ adrs: [initiativeAdr], initiative }],
				projectAdrs: [projectAdr]
			}), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				duplicateTerms: ["Order"],
				initiatives: [initiativeContext],
				shared: sharedContext,
				terms: [{
					hasConflictingDefinitions: true,
					hasDuplicates: true,
					hasSharedSource: true,
					sources: [
						{ ...sharedContext.terms[0], contextKey: "shared", contextTitle: "Shared Context", scopeEntityId: null, scopeKind: "default", scopeLabel: "Shared" },
						{ ...initiativeContext.terms[0], contextKey: "INIT1", contextTitle: "Payments Context", scopeEntityId: "INIT1", scopeKind: "initiative", scopeLabel: "Payments" }
					],
					term: "Order"
				}]
			}), { status: 200 }));

		store.selectSection("adrs");
		await vi.waitFor(() => expect(store.adrRailEntries.get()).toEqual([
			{ adr: projectAdr, scope: "project", scopeLabel: "project decision" },
			{ adr: initiativeAdr, scope: "initiative", scopeLabel: "initiative Payments" }
		]));
		expect(store.snapshot.get()).toBeNull();

		store.selectSection("context");
		await vi.waitFor(() => expect(store.projectContextTerms.get()).toEqual([
			expect.objectContaining({
				hasConflictingDefinitions: true,
				hasDuplicates: true,
				sources: [expect.objectContaining({ scopeLabel: "Shared" }), expect.objectContaining({ scopeLabel: "Payments" })],
				term: "Order"
			})
		]));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("loads project ADRs only when the ADR section opens", async () => {
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Scoped ADR" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ initiativeAdrs: [], projectAdrs: [adr] }), { status: 200 }));

		expect(fetchMock).not.toHaveBeenCalled();
		store.selectSection("adrs");

		await vi.waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining("/api/project-adrs?tenant=demo"),
				expect.objectContaining({ cache: "no-store" })
			);
			expect(store.projectAdrs.get()).toEqual([adr]);
		});
	});

	it("loads debt, context, and graph data only when their sections open", async () => {
		const debt = makeEntity({ id: "DEBT1", kind: "debt", title: "Scoped debt" });
		const context = {
			context: {
				createdAt: null,
				exists: true,
				key: "shared",
				scopeEntityId: null,
				scopeKind: "default" as const,
				scopeLabel: "Shared",
				summary: "Scoped context",
				title: "Shared context",
				updatedAt: null
			},
			terms: []
		};
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ records: [debt], relations: [] }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ duplicateTerms: [], initiatives: [], shared: context, terms: [] }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ records: [debt], relations: [] }), { status: 200 }));

		store.selectSection("debt");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/project-debt?tenant=demo"), expect.anything()));
		store.selectSection("context");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/project-context?tenant=demo"), expect.anything()));
		store.selectSection("graph");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/project-graph?tenant=demo"), expect.anything()));
	});
});

describe("browser detail routes", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("retains a Plan-entry target during direct hash navigation", async () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const store = new AgentIssuesStore();
		const planEntry = {
			body: "Define result routes.",
			createdAt: "2026-01-01T00:00:00.000Z",
			id: "ENTRY1",
			planId: plan.id,
			reference: "PLAN_ENTRY_1",
			referencedEntityIds: [],
			role: "decision" as const,
			scopeDirection: null,
			supersededEntryIds: [],
			tombstone: false,
			updatedAt: "2026-01-01T00:00:00.000Z"
		};
		store.snapshot.set(makeSnapshot({ entities: [plan], planEntries: [planEntry] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		window.location.hash = "tenant=demo&project=PROJ1&entity=PLAN1&target=plan-entry&target-id=ENTRY1";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot({ entities: [plan], planEntries: [planEntry] }) }), { status: 200 })
		);

		await store.onBrowserNavigation();

		expect(store.selectedId.get()).toBe("PLAN1");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&entity=PLAN1&target=plan-entry&target-id=ENTRY1");
		fetchMock.mockRestore();
	});

	it("falls back to a Plan when its target entry is unavailable", () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [plan] }));
		window.location.hash = "tenant=demo&project=PROJ1&entity=PLAN1&target=plan-entry&target-id=ENTRY1";

		store.onHashChange();

		expect(store.selectedId.get()).toBe("PLAN1");
		expect(store.selectedNestedTarget.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=entity&entity=PLAN1");
	});

	it("opens a Plan-entry target in its Plan", () => {
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [plan] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");

		store.openSearchTarget({ type: "plan-entry", planId: "PLAN1", entryId: "ENTRY1" });

		expect(store.selectedId.get()).toBe("PLAN1");
		expect(store.selectedNestedTarget.get()).toEqual({ id: "ENTRY1", type: "plan-entry" });
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=entity&entity=PLAN1&target=plan-entry&target-id=ENTRY1");
	});

	it("opens an entity target without nested route data", () => {
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Search result" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [issue] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");

		store.openSearchTarget({ type: "entity", entityId: issue.id });

		expect(store.selectedId.get()).toBe(issue.id);
		expect(store.selectedNestedTarget.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=entity&entity=ISS1");
	});

	it("loads the result project before opening an entity target", async () => {
		const issue = makeEntity({ id: "ISS2", kind: "issue", title: "Other project result" });
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot({ entities: [issue] }) }), { status: 200 })
		);

		await store.openSearchTarget({ type: "entity", entityId: issue.id }, "PROJ2");

		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBe(issue.id);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ2&page=entity&entity=ISS2");
		fetchMock.mockRestore();
	});

	it("keeps global search open when the result project is unavailable", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.activeSection.set("context");
		store.globalSearchOpen.set(true);
		store.globalSearchQuery.set("other project result");
		store.globalSearchResponse.set({ results: [], state: "available" });
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				kind: "available",
				project: makeEntity({ id: "PROJ1", kind: "project", title: "Current project" }),
				epics: [],
				counts: { completedInitiatives: 0, epics: 0, initiatives: 0 }
			}), { status: 200 }));

		await expect(store.openSearchTarget({ type: "entity", entityId: "ISS2" }, "PROJ2")).resolves.toBe(false);

		expect(store.selectedProjectId.get()).toBe("PROJ1");
		expect(store.activeSection.get()).toBe("context");
		expect(store.globalSearchOpen.get()).toBe(true);
		expect(store.globalSearchQuery.get()).toBe("other project result");
		expect(store.globalSearchResponse.get()).toEqual({ results: [], state: "available" });
		fetchMock.mockRestore();
	});

	it("opens an issue-comment target in its issue", () => {
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Search discussion" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [issue] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");

		store.openSearchTarget({ type: "issue-comment", issueId: "ISS1", commentId: "COMMENT1" });

		expect(store.selectedId.get()).toBe("ISS1");
		expect(store.selectedNestedTarget.get()).toEqual({ id: "COMMENT1", type: "issue-comment" });
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=entity&entity=ISS1&target=issue-comment&target-id=COMMENT1");
	});

	it("opens a context-term target in its scoped context", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ initiatives: [makeBundle(initiative)] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");

		store.openSearchTarget({ type: "context-term", scopeRef: "INIT1", term: "Search document" });

		expect(store.activeSection.get()).toBe("context");
		expect(store.contextTab.get()).toBe("initiatives");
		expect(store.selectedContextInitiativeId.get()).toBe("INIT1");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=project&section=context&target=context-term&target-id=Search%20document&target-scope=INIT1");
	});

	it("loads scoped context before completing context-term search navigation", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const shared = makeSnapshot().contexts.shared;
		const scoped = {
			context: {
				createdAt: null,
				exists: true,
				key: initiative.id,
				scopeEntityId: initiative.id,
				scopeKind: "initiative" as const,
				scopeLabel: initiative.title,
				summary: "Search terminology.",
				title: "Search context",
				updatedAt: null
			},
			terms: [{ avoid: [], createdAt: "", definition: "Visible debt records.", term: "debt graph visibility", updatedAt: "" }]
		};
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ duplicateTerms: [], initiatives: [scoped], shared, terms: [] }), { status: 200 })
		);

		await store.openSearchTarget({ type: "context-term", scopeRef: initiative.id, term: "debt graph visibility" });

		expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/project-context?tenant=demo"), expect.anything());
		expect(store.getContextForInitiative(initiative.id)).toEqual(scoped);
	});

	it("clears a nested target when navigating to another initiative", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, plan], initiatives: [makeBundle(initiative)] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.openSearchTarget({ type: "plan-entry", planId: plan.id, entryId: "ENTRY1" });

		store.selectInitiative(initiative.id);

		expect(store.selectedNestedTarget.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=overview");
	});

	it("clears a nested target when closing its owner detail", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const plan = makeEntity({ id: "PLAN1", kind: "plan", title: "Search plan" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, plan], initiatives: [makeBundle(initiative, { entities: [initiative, plan] })] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.openSearchTarget({ type: "plan-entry", planId: plan.id, entryId: "ENTRY1" });

		store.closeEntity();

		expect(store.selectedNestedTarget.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=overview");
	});

	it("returns through record navigation before closing to the initiative", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Source story" });
		const parentIssue = makeEntity({ id: "ISS1", kind: "issue", title: "Parent issue" });
		const childIssue = makeEntity({ id: "ISS2", kind: "issue", title: "Child issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({
			entities: [initiative, story, parentIssue, childIssue],
			initiatives: [makeBundle(initiative, { issues: [parentIssue, childIssue], userStories: [story] })]
		}));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectEntity(story.id);
		store.selectEntityFromRecord(parentIssue.id);
		store.selectEntityFromRecord(childIssue.id);

		expect(store.entityBackTarget.get()?.id).toBe(parentIssue.id);
		store.closeEntity();
		expect(store.selectedId.get()).toBe(parentIssue.id);
		expect(store.entityBackTarget.get()?.id).toBe(story.id);

		store.closeEntity();
		expect(store.selectedId.get()).toBe(story.id);
		expect(store.entityBackTarget.get()).toBeNull();

		store.closeEntity();
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBe(initiative.id);
	});

	it("restores a scoped context-term target from a direct hash route", () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Search work" });
		const store = new AgentIssuesStore();
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
						summary: "Search terms.",
						title: "Search Context",
						updatedAt: null
					},
					terms: [{ avoid: [], createdAt: "", definition: "A search projection.", term: "Search document", updatedAt: "" }]
				}],
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
			initiatives: [makeBundle(initiative)]
		}));
		window.location.hash = "tenant=demo&project=PROJ1&section=context&target=context-term&target-id=Search%20document&target-scope=INIT1";

		store.onHashChange();

		expect(store.activeSection.get()).toBe("context");
		expect(store.contextTab.get()).toBe("initiatives");
		expect(store.selectedContextInitiativeId.get()).toBe("INIT1");
	});

	it("removes legacy cascade state after direct hash navigation", async () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [makeEntity({ id: "ISS18" })] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		window.location.hash = "tenant=demo&project=PROJ1&entity=ISS18&cascade=INIT4~ISS18";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot({ entities: [makeEntity({ id: "ISS18" })] }) }), { status: 200 })
		);

		await store.onBrowserNavigation();

		expect(store.selectedId.get()).toBe("ISS18");
		expect(store.cascadePath.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=entity&entity=ISS18");
		fetchMock.mockRestore();
	});

	it("restores initiative and entity panels from browser navigation without changing the route", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Console Viewer" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", status: "todo", title: "Open record" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, issue], initiatives: [makeBundle(initiative, { issues: [issue] })] }));
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=issues");

		await store.onPopState();
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(store.selectedId.get()).toBeNull();
		expect(store.initTab.get()).toBe("issues");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=issues");

		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&entity=ISS1");
		await store.onPopState();

		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.selectedId.get()).toBe("ISS1");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&entity=ISS1");

		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&page=project");
		await store.onPopState();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.selectedId.get()).toBeNull();
		expect(store.activePage.get()).toBe("list");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=project");
	});

	it("keeps an explicit initiative route while asynchronous startup work begins", async () => {
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&page=initiative&initiative=INIT1&tab=adrs");
		const store = new AgentIssuesStore();
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ availableTenants: [{ displayName: "Demo", id: "demo" }], currentTenant: "demo", dbPath: "/tmp/agent-issues.db" }), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 }))
			.mockReturnValue(new Promise<Response>(() => {}));

		store.connect();

		expect(store.activePage.get()).toBe("initiative");
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(store.initTab.get()).toBe("adrs");
		await vi.waitFor(() => expect(fetchMock.mock.calls.some(([resource]) => String(resource).includes("/api/project-summary"))).toBe(true));
		expect(store.activePage.get()).toBe("initiative");
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(store.initTab.get()).toBe("adrs");
		store.disconnect();
	});

	it("restores main menu sections from browser history", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");

		store.selectSection("adrs");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=project&section=adrs");

		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1&section=graph");
		await store.onPopState();
		expect(store.activeSection.get()).toBe("graph");

		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1");
		await store.onPopState();
		expect(store.activeSection.get()).toBe("initiatives");
	});
});

describe("tenant and project route scope", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("hydrates the selected project name after opening a project hash link", async () => {
		const store = new AgentIssuesStore();
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ availableTenants: [{ displayName: "Demo", id: "demo" }], currentTenant: "demo", dbPath: "/tmp/agent-issues.db" }),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						kind: "available",
						projects: [{ completedInitiativeCount: 0, epicCount: 0, initiativeCount: 0, project: makeEntity({ id: "PROJ1", kind: "project", title: "Console Viewer" }) }]
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 }));

		await (store as unknown as { bootstrap(): Promise<void> }).bootstrap();

		expect(store.selectedProjectDisplayName.get()).toBe("Console Viewer");
		fetchMock.mockRestore();
	});

	it("opens a project from Project Summary without requesting a snapshot", async () => {
		const store = new AgentIssuesStore();
		const project = makeEntity({ id: "PROJ1", kind: "project", title: "Console Viewer" });
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Platform work" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", status: "active", title: "Progressive loading" });
		window.history.replaceState({}, "", "#tenant=demo&project=PROJ1");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ availableTenants: [{ displayName: "Demo", id: "demo" }], currentTenant: "demo", dbPath: "/tmp/agent-issues.db" }),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						kind: "available",
						projects: [{ completedInitiativeCount: 0, epicCount: 1, initiativeCount: 1, project }]
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						kind: "available",
						project,
						epics: [{ epic, initiatives: [{ initiative, issueCount: 2, completedIssueCount: 1, userStoryCount: 1 }] }],
						counts: { epics: 1, initiatives: 1, completedInitiatives: 0 }
					}),
					{ status: 200 }
				)
			);

		await (store as unknown as { bootstrap(): Promise<void> }).bootstrap();

		expect(store.projectSummary.get()).toEqual(expect.objectContaining({ project }));
		expect(store.projectSummaryEpicGroups.get()).toEqual(expect.arrayContaining([
			expect.objectContaining({ epic: expect.objectContaining({ id: epic.id }) })
		]));
		const resourcePaths = fetchMock.mock.calls.map(([resource]) => String(resource));
		expect(resourcePaths.some((resourcePath) => resourcePath.startsWith("/api/project-summary?tenant=demo&project=PROJ1&ts="))).toBe(true);
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/snapshot"))).toBe(false);
		fetchMock.mockRestore();
	});

	it("refreshes only the active entity for a matching scoped live update", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		const cachedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Cached decision" });
		const refreshedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Refreshed decision" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ADR1");
		store.entityDetails.set(new Map([[
			"ADR1",
			{ detail: { entity: cachedAdr, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ADR1"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.entityDetails.get().get("ADR1")).toEqual(expect.objectContaining({
			detail: expect.objectContaining({ entity: cachedAdr }),
			loading: true
		}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/entity-detail?entity=ADR1&tenant=demo");
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/api/project-summary");

		resolveRefresh!(new Response(JSON.stringify({ entity: refreshedAdr, incoming: [], outgoing: [], planEntries: [] }), { status: 200 }));
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.detail?.entity.title).toBe("Refreshed decision"));
	});

	it("marks an inactive entity cache stale and reloads it when opened", async () => {
		const store = new AgentIssuesStore();
		const cachedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Cached decision" });
		const refreshedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Refreshed decision" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			"ADR1",
			{ detail: { entity: cachedAdr, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ entity: refreshedAdr, incoming: [], outgoing: [], planEntries: [] }), { status: 200 })
		);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ADR1"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(store.entityDetails.get().get("ADR1")).toEqual(expect.objectContaining({ stale: true }));

		store.selectEntity("ADR1");
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.detail?.entity.title).toBe("Refreshed decision"));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a stale entity refresh after a failed reopen", async () => {
		const store = new AgentIssuesStore();
		const cachedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Cached decision" });
		const refreshedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Refreshed decision" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			"ADR1",
			{ detail: { entity: cachedAdr, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ entity: refreshedAdr, incoming: [], outgoing: [], planEntries: [] }), { status: 200 }));

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ADR1"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		store.selectEntity("ADR1");
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.error).not.toBeNull());
		expect(store.entityDetails.get().get("ADR1")).toEqual(expect.objectContaining({
			detail: expect.objectContaining({ entity: cachedAdr }),
			stale: true
		}));

		store.selectEntity("ADR1");
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.detail?.entity.title).toBe("Refreshed decision"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.entityDetails.get().get("ADR1")).toEqual(expect.objectContaining({ error: null }));
		expect(store.entityDetails.get().get("ADR1")).not.toHaveProperty("stale");
	});

	it("keeps a live stale marker when an in-flight entity refresh fails", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		const cachedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Cached decision" });
		const refreshedAdr = makeEntity({ id: "ADR1", kind: "adr", title: "Refreshed decision" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			"ADR1",
			{ detail: { entity: cachedAdr, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockReturnValueOnce(refreshResponse)
			.mockResolvedValueOnce(new Response(JSON.stringify({ entity: refreshedAdr, incoming: [], outgoing: [], planEntries: [] }), { status: 200 }));

		void store.retryEntityDetail("ADR1");
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.loading).toBe(true));
		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ADR1"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));
		resolveRefresh!(new Response(null, { status: 500 }));

		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.error).not.toBeNull());
		expect(store.entityDetails.get().get("ADR1")).toEqual(expect.objectContaining({ stale: true }));

		store.selectEntity("ADR1");
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.detail?.entity.title).toBe("Refreshed decision"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a stale initiative detail refresh after a failed reopen", async () => {
		const store = new AgentIssuesStore();
		const cachedInitiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Cached initiative" });
		const refreshedInitiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Refreshed initiative" });
		const initiativeSummary = { createdAt: cachedInitiative.createdAt, id: cachedInitiative.id, kind: cachedInitiative.kind, status: cachedInitiative.status, title: cachedInitiative.title, updatedAt: cachedInitiative.updatedAt };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		store.initiativeDetails.set(new Map([[
			"INIT1",
			{ detail: { initiative: cachedInitiative }, error: null, loading: false, stale: true }
		]]));
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ initiative: refreshedInitiative }), { status: 200 }));

		store.selectInitiative("INIT1");
		await vi.waitFor(() => expect(store.initiativeDetails.get().get("INIT1")?.error).not.toBeNull());
		expect(store.initiativeDetails.get().get("INIT1")).toEqual(expect.objectContaining({
			detail: { initiative: cachedInitiative },
			stale: true
		}));

		store.selectInitiative("INIT1");
		await vi.waitFor(() => expect(store.initiativeDetailForId("INIT1")?.initiative.title).toBe("Refreshed initiative"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.initiativeDetails.get().get("INIT1")).not.toHaveProperty("stale");
	});

	it("retries a stale initiative tab refresh after a failed reopen", async () => {
		const store = new AgentIssuesStore();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Initiative" });
		const initiativeSummary = { createdAt: initiative.createdAt, id: initiative.id, kind: initiative.kind, status: initiative.status, title: initiative.title, updatedAt: initiative.updatedAt };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedInitiativeId.set("INIT1");
		store.projectSummary.set({
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
			epics: [{ epic: { ...initiativeSummary, id: "EPIC1", kind: "epic" }, initiatives: [{ completedIssueCount: 0, initiative: initiativeSummary, issueCount: 0, userStoryCount: 0 }] }],
			kind: "available",
			project: { ...initiativeSummary, id: "PROJ1", kind: "project" }
		});
		store.initiativeTabs.set(new Map([[
			"INIT1:issues",
			{ data: { records: [], relations: [], tab: "issues" }, error: null, loading: false, stale: true }
		]]));
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ records: [makeEntity({ id: "ISS1" })], relations: [], tab: "issues" }), { status: 200 }));

		store.setInitTab("issues");
		await vi.waitFor(() => expect(store.initiativeTabs.get().get("INIT1:issues")?.error).not.toBeNull());
		expect(store.initiativeTabs.get().get("INIT1:issues")).toEqual(expect.objectContaining({ stale: true }));

		store.setInitTab("overview");
		store.setInitTab("issues");
		await vi.waitFor(() => expect(store.initiativeTabs.get().get("INIT1:issues")?.data?.records).toHaveLength(1));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(store.initiativeTabs.get().get("INIT1:issues")).not.toHaveProperty("stale");
	});

	it.each([
		{
			cache: (store: AgentIssuesStore) => store.projectAdrsCache.get(),
			data: { initiativeAdrs: [], projectAdrs: [makeEntity({ id: "ADR1", kind: "adr" })] },
			name: "ADR",
			open: (store: AgentIssuesStore) => store.selectSection("adrs"),
			seed: (store: AgentIssuesStore, data: unknown) => store.projectAdrsCache.set({ data: data as never, error: null, loading: false, stale: true })
		},
		{
			cache: (store: AgentIssuesStore) => store.projectContextCache.get(),
			data: { duplicateTerms: [], initiatives: [], shared: makeSnapshot().contexts.shared, terms: [] },
			name: "Context",
			open: (store: AgentIssuesStore) => store.selectSection("context"),
			seed: (store: AgentIssuesStore, data: unknown) => store.projectContextCache.set({ data: data as never, error: null, loading: false, stale: true })
		},
		{
			cache: (store: AgentIssuesStore) => store.projectDebtCache.get(),
			data: { records: [makeEntity({ id: "DEBT1", kind: "debt" })], relations: [] },
			name: "record",
			open: (store: AgentIssuesStore) => store.selectSection("debt"),
			seed: (store: AgentIssuesStore, data: unknown) => store.projectDebtCache.set({ data: data as never, error: null, loading: false, stale: true })
		}
	])("retries a stale project $name cache refresh after a failed reopen", async ({ cache, data, open, seed }) => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		seed(store, data);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 500 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

		open(store);
		await vi.waitFor(() => expect(cache(store).error).not.toBeNull());
		expect(cache(store)).toEqual(expect.objectContaining({ data, stale: true }));

		open(store);
		await vi.waitFor(() => expect(cache(store)).not.toHaveProperty("stale"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(cache(store).error).toBeNull();
	});

	it("retries stale Plan-entry and issue-comment page refreshes after failure", async () => {
		const store = new AgentIssuesStore();
		const issue = makeEntity({ id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			"ISS1",
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		store.planEntryPages.set(new Map([[
			"PLAN1",
			{ data: { entries: [], nextBefore: null, total: 0 }, error: null, loading: false, stale: true }
		]]));
		store.issueCommentPages.set(new Map([[
			"ISS1",
			{ data: { comments: [], nextBefore: null, total: 0, users: [] }, error: null, loading: false, stale: true }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
			const path = String(resource);
			const failedBefore = fetchMock.mock.calls.slice(0, -1).some(([previousResource]) => String(previousResource).split("&ts=")[0] === path.split("&ts=")[0]);
			if (!failedBefore) {
				return new Response(null, { status: 500 });
			}
			return new Response(JSON.stringify(path.includes("plan-entries")
				? { entries: [], nextBefore: null, total: 0 }
				: { comments: [], nextBefore: null, total: 0 }), { status: 200 });
		});

		store.requestEntityTab("PLAN1", "plan");
		store.selectEntity("ISS1");
		await vi.waitFor(() => {
			expect(store.planEntryPages.get().get("PLAN1")?.error).not.toBeNull();
			expect(store.issueCommentPages.get().get("ISS1")?.error).not.toBeNull();
		});
		expect(store.planEntryPages.get().get("PLAN1")).toEqual(expect.objectContaining({ stale: true }));
		expect(store.issueCommentPages.get().get("ISS1")).toEqual(expect.objectContaining({ stale: true }));

		store.requestEntityTab("PLAN1", "plan");
		store.selectEntity("ISS1");
		await vi.waitFor(() => {
			expect(store.planEntryPages.get().get("PLAN1")).not.toHaveProperty("stale");
			expect(store.issueCommentPages.get().get("ISS1")).not.toHaveProperty("stale");
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(store.planEntryPages.get().get("PLAN1")?.error).toBeNull();
		expect(store.issueCommentPages.get().get("ISS1")?.error).toBeNull();
	});

	it("refreshes the active initiative tab and marks its inactive tabs stale", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedInitiativeId.set("INIT1");
		store.initTab.set("issues");
		store.initiativeTabs.set(new Map([
			["INIT1:issues", { data: { tab: "issues", records: [], relations: [] }, error: null, loading: false }],
			["INIT1:graph", { data: { tab: "graph", records: [], relations: [] }, error: null, loading: false }]
		]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ISS1"],
				affectedEntityKinds: ["issue"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.initiativeTabs.get().get("INIT1:issues")).toEqual(expect.objectContaining({
			data: expect.objectContaining({ tab: "issues" }),
			loading: true
		}));
		expect(store.initiativeTabs.get().get("INIT1:graph")).toEqual(expect.objectContaining({ stale: true }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/initiative-tab?initiative=INIT1&tab=issues");

		resolveRefresh!(new Response(JSON.stringify({ tab: "issues", records: [], relations: [] }), { status: 200 }));
		await vi.waitFor(() => expect(store.initiativeTabs.get().get("INIT1:issues")?.loading).toBe(false));
	});

	it("refreshes comments for the active issue after a scoped comment update", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.issueCommentPages.set(new Map([[
			"ISS1",
			{ data: { comments: [], nextBefore: null, total: 0, users: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ISS1"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "issue-comment",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.issueCommentPages.get().get("ISS1")).toEqual(expect.objectContaining({
			data: expect.objectContaining({ total: 0 }),
			loading: true
		}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/issue-comments?issue=ISS1");

		resolveRefresh!(new Response(JSON.stringify({ comments: [], nextBefore: null, total: 0 }), { status: 200 }));
		await vi.waitFor(() => expect(store.issueCommentPages.get().get("ISS1")?.loading).toBe(false));
	});

	it("refreshes Plan entries for the active Plan after a scoped entry update", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("PLAN1");
		store.planEntryPages.set(new Map([[
			"PLAN1",
			{ data: { entries: [], nextBefore: null, total: 0 }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["PLAN1"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "plan-entry",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.planEntryPages.get().get("PLAN1")).toEqual(expect.objectContaining({
			data: expect.objectContaining({ total: 0 }),
			loading: true
		}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/plan-entries?plan=PLAN1");

		resolveRefresh!(new Response(JSON.stringify({ entries: [], nextBefore: null, total: 0 }), { status: 200 }));
		await vi.waitFor(() => expect(store.planEntryPages.get().get("PLAN1")?.loading).toBe(false));
	});

	it("refreshes the active project Context and keeps its cached content visible", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		const cachedContext = makeSnapshot().contexts.shared;
		const cachedContextSection = { duplicateTerms: [], initiatives: [], shared: cachedContext, terms: [] };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.activeSection.set("context");
		store.projectContextCache.set({ data: cachedContextSection, error: null, loading: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: [],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "context",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.projectContextCache.get()).toEqual(expect.objectContaining({ data: cachedContextSection, loading: true }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-context?tenant=demo");

		resolveRefresh!(new Response(JSON.stringify(cachedContextSection), { status: 200 }));
		await vi.waitFor(() => expect(store.projectContextCache.get().loading).toBe(false));
	});

	it("applies a local change immediately and ignores its matching live event", async () => {
		const store = new AgentIssuesStore();
		const adr = makeEntity({ id: "ADR1", kind: "adr" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ADR1");
		store.entityDetails.set(new Map([[
			"ADR1",
			{ detail: { entity: adr, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ entity: adr, incoming: [], outgoing: [], planEntries: [] }), { status: 200 })
		);
		const event = {
			affectedEntityIds: ["ADR1"],
			affectedInitiativeIds: [],
			at: "2026-08-31T00:00:00.000Z",
			category: "entity",
			correlationId: "write-1",
			projectId: "PROJ1",
			type: "snapshot-changed"
		} as const;

		(store as unknown as { applyLocalProjectChange(event: object): void }).applyLocalProjectChange(event);
		await vi.waitFor(() => expect(store.entityDetails.get().get("ADR1")?.loading).toBe(false));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("registers a site mutation before an early matching event and refreshes once", async () => {
		const store = new AgentIssuesStore();
		const originalIssue = makeEntity({ body: "Before", id: "ISS1", kind: "issue" });
		const updatedIssue = makeEntity({ body: "After", id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set(originalIssue.id);
		store.entityDetails.set(new Map([[
			originalIssue.id,
			{ detail: { entity: originalIssue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		(store as unknown as { connectEvents(): void }).connectEvents();
		let mutationEvent: object | null = null;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
			const resourcePath = String(resource);
			if (resourcePath.includes("/api/project-mutation")) {
				const request = JSON.parse(String(init?.body)) as { correlationId: string };
				mutationEvent = {
					affectedEntityIds: [originalIssue.id],
					affectedEntityKinds: ["issue"],
					affectedInitiativeIds: ["INIT1"],
					at: "2026-08-31T00:00:00.000Z",
					category: "entity",
					correlationId: request.correlationId,
					projectId: "PROJ1",
					type: "snapshot-changed"
				};
				store.events?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(mutationEvent) }));
				return new Response(JSON.stringify({ event: mutationEvent, result: { entity: updatedIssue } }), { status: 200 });
			}
			return new Response(JSON.stringify({ entity: updatedIssue, incoming: [], outgoing: [], planEntries: [] }), { status: 200 });
		});

		const result = await store.mutateProject<{ entity: Entity }>("updateEntity", {
			body: updatedIssue.body,
			entityId: updatedIssue.id,
			expectedContentHash: "hash",
			expectedRevision: 1
		});
		await vi.waitFor(() => expect(store.entityDetails.get().get(updatedIssue.id)?.loading).toBe(false));

		expect(result.entity).toEqual(updatedIssue);
		expect(fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/project-mutation"))).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/entity-detail"))).toHaveLength(1);

		store.events?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(mutationEvent) }));
		await Promise.resolve();
		expect(fetchMock.mock.calls.filter(([resource]) => String(resource).includes("/api/entity-detail"))).toHaveLength(1);
	});

	it("refreshes the active project ADR section for an ADR change", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		const cachedAdr = makeEntity({ id: "ADR1", kind: "adr" });
		const cachedAdrSection = { initiativeAdrs: [], projectAdrs: [cachedAdr] };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.activeSection.set("adrs");
		store.projectAdrsCache.set({ data: cachedAdrSection, error: null, loading: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ADR2"],
				affectedEntityKinds: ["adr"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.projectAdrsCache.get()).toEqual(expect.objectContaining({ data: cachedAdrSection, loading: true }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-adrs?tenant=demo");

		resolveRefresh!(new Response(JSON.stringify(cachedAdrSection), { status: 200 }));
		await vi.waitFor(() => expect(store.projectAdrsCache.get().loading).toBe(false));
	});

	it("refreshes the active project debt section for a debt change", async () => {
		const store = new AgentIssuesStore();
		const cachedData = { records: [makeEntity({ id: "DEBT1", kind: "debt" })], relations: [] };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.activeSection.set("debt");
		store.projectDebtCache.set({ data: cachedData, error: null, loading: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(cachedData), { status: 200 })
		);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["DEBT2"],
				affectedEntityKinds: ["debt"],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.projectDebtCache.get().loading).toBe(false));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-debt?tenant=demo");
	});

	it("refreshes the active project graph after a relation change", async () => {
		const store = new AgentIssuesStore();
		const cachedData = { records: [], relations: [] };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.activeSection.set("graph");
		store.projectGraphCache.set({ data: cachedData, error: null, loading: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(cachedData), { status: 200 })
		);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["INIT1", "ISS1"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "relation",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.projectGraphCache.get().loading).toBe(false));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-graph?tenant=demo");
	});

	it("refreshes active initiative detail without loading its tabs", async () => {
		let resolveRefresh: (response: Response) => void;
		const refreshResponse = new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		});
		const store = new AgentIssuesStore();
		const cachedInitiative = makeEntity({ id: "INIT1", kind: "initiative", body: "Cached body" });
		const refreshedInitiative = makeEntity({ id: "INIT1", kind: "initiative", body: "Refreshed body" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedInitiativeId.set("INIT1");
		store.initTab.set("overview");
		store.initiativeDetails.set(new Map([[
			"INIT1",
			{ detail: { initiative: cachedInitiative }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(refreshResponse);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["INIT1"],
				affectedEntityKinds: ["initiative"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		expect(store.initiativeDetails.get().get("INIT1")).toEqual(expect.objectContaining({
			detail: { initiative: cachedInitiative },
			loading: true
		}));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/initiative-detail?initiative=INIT1");
		expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/api/initiative-tab");

		resolveRefresh!(new Response(JSON.stringify({ initiative: refreshedInitiative }), { status: 200 }));
		await vi.waitFor(() => expect(store.initiativeDetails.get().get("INIT1")?.detail?.initiative.body).toBe("Refreshed body"));
	});

	it("refreshes only Project Summary for a bulk change", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const projectSummary = {
			kind: "available" as const,
			project: makeEntity({ id: "PROJ1", kind: "project" }),
			epics: [],
			counts: { completedInitiatives: 0, epics: 0, initiatives: 0 }
		};
		store.projectSummary.set(projectSummary);
		store.selectedInitiativeId.set("INIT1");
		store.initTab.set("issues");
		store.initiativeTabs.set(new Map([[
			"INIT1:issues",
			{ data: { tab: "issues", records: [], relations: [] }, error: null, loading: false }
		]]));
		const refreshedSummary = { ...projectSummary, counts: { completedInitiatives: 0, epics: 0, initiatives: 1 } };
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "unavailable" }), { status: 200 }))
			.mockResolvedValue(new Response(JSON.stringify(refreshedSummary), { status: 200 }));

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ISS1"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "bulk",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-summary?tenant=demo&project=PROJ1");
		await vi.waitFor(() => expect(store.syncLabel.get()).toBe("refresh failed"));
		expect(store.errorMessage.get()).toBe("Selected project is unavailable.");
		expect(store.projectSummary.get()).toBe(projectSummary);
		expect(store.initiativeTabs.get().get("INIT1:issues")?.loading).toBe(false);

		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				at: "2026-08-31T00:00:01.000Z",
				category: "bulk",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.projectSummary.get()).toEqual(refreshedSummary));
		expect(store.errorMessage.get()).toBeNull();
		expect(store.syncLabel.get()).toBe("listening");
	});

	it("ignores a background Project Summary response after project selection changes", async () => {
		const store = new AgentIssuesStore();
		const projectASummary = {
			kind: "available" as const,
			project: makeEntity({ id: "PROJ1", kind: "project" }),
			epics: [],
			counts: { completedInitiatives: 0, epics: 0, initiatives: 1 }
		};
		const projectBSummary = {
			kind: "available" as const,
			project: makeEntity({ id: "PROJ2", kind: "project" }),
			epics: [],
			counts: { completedInitiatives: 0, epics: 0, initiatives: 2 }
		};
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set(projectASummary);
		let resolveRefresh: (response: Response) => void;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
			resolveRefresh = resolve;
		}));

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				at: "2026-08-31T00:00:00.000Z",
				category: "bulk",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		store.selectedProjectId.set("PROJ2");
		store.projectSummary.set(projectBSummary);
		const response = new Response(JSON.stringify(projectASummary), { status: 200 });
		const jsonSpy = vi.spyOn(response, "json");
		resolveRefresh!(response);

		await vi.waitFor(() => expect(jsonSpy).toHaveBeenCalledTimes(1));
		await jsonSpy.mock.results[0]!.value;
		await Promise.resolve();
		await Promise.resolve();
		expect(store.projectSummary.get()).toBe(projectBSummary);
		expect(store.errorMessage.get()).toBeNull();
	});

	it("refreshes selected entity detail after a relation change", async () => {
		const store = new AgentIssuesStore();
		const issue = makeEntity({ id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.entityDetails.set(new Map([[
			"ISS1",
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ entity: issue, incoming: [], outgoing: [], planEntries: [] }), { status: 200 })
		);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["INIT1", "ISS1"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "relation",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.entityDetails.get().get("ISS1")?.loading).toBe(false));
		const resourcePaths = fetchMock.mock.calls.map(([resource]) => String(resource));
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/entity-detail?entity=ISS1"))).toBe(true);
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/project-summary"))).toBe(false);
	});

	it("reloads stale comments when a cached issue is opened", async () => {
		const store = new AgentIssuesStore();
		const issue = makeEntity({ id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.entityDetails.set(new Map([[
			"ISS1",
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		store.issueCommentPages.set(new Map([[
			"ISS1",
			{ data: { comments: [], nextBefore: null, total: 0, users: [] }, error: null, loading: false, stale: true }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ comments: [], nextBefore: null, total: 0 }), { status: 200 })
		);

		store.selectEntity("ISS1");

		await vi.waitFor(() => expect(store.issueCommentPages.get().get("ISS1")?.loading).toBe(false));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/issue-comments?issue=ISS1");
	});

	it("refreshes associated Project Summary rollups for an issue change", async () => {
		const store = new AgentIssuesStore();
		const issue = makeEntity({ id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.entityDetails.set(new Map([[
			"ISS1",
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
			const path = String(resource);
			if (path.includes("/api/project-summary")) {
				return new Response(JSON.stringify({ kind: "available", project: makeEntity({ id: "PROJ1", kind: "project" }), epics: [], counts: { epics: 0, initiatives: 0, completedInitiatives: 0 } }), { status: 200 });
			}
			if (path.includes("/api/issue-comments")) {
				return new Response(JSON.stringify({ comments: [], nextBefore: null, total: 0 }), { status: 200 });
			}
			return new Response(JSON.stringify({ entity: issue, incoming: [], outgoing: [], planEntries: [] }), { status: 200 });
		});

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["ISS1"],
				affectedEntityKinds: ["issue"],
				affectedInitiativeIds: ["INIT1"],
				affectsProjectSummary: true,
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.projectSummary.get()).toEqual(expect.objectContaining({ kind: "available" })));
		const resourcePaths = fetchMock.mock.calls.map(([resource]) => String(resource));
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/entity-detail?entity=ISS1"))).toBe(true);
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/project-summary"))).toBe(true);
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/initiative-tab"))).toBe(false);
	});

	it("refreshes Project Summary but not unrelated section caches for a contains change", async () => {
		const store = new AgentIssuesStore();
		const initiative = makeEntity({ id: "INIT1", kind: "initiative" });
		const cachedAdrSection = { initiativeAdrs: [], projectAdrs: [makeEntity({ id: "ADR1", kind: "adr" })] };
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectAdrsCache.set({ data: cachedAdrSection, error: null, loading: false });
		store.initiativeDetails.set(new Map([[
			initiative.id,
			{ detail: { initiative }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({
				counts: { completedInitiatives: 0, epics: 1, initiatives: 1 },
				epics: [],
				kind: "available",
				project: makeEntity({ id: "PROJ1", kind: "project" })
			}), { status: 200 })
		);

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["EPIC1", initiative.id],
				affectedInitiativeIds: [initiative.id],
				affectsProjectSummary: true,
				at: "2026-08-31T00:00:00.000Z",
				category: "relation",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/project-summary?tenant=demo&project=PROJ1");
		expect(store.projectAdrsCache.get()).toEqual({ data: cachedAdrSection, error: null, loading: false });
	});

	it("refreshes the selected issue detail for a Plan-entry linkage event", async () => {
		const store = new AgentIssuesStore();
		const issue = makeEntity({ id: "ISS1", kind: "issue" });
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.entityDetails.set(new Map([[
			"ISS1",
			{ detail: { entity: issue, incoming: [], outgoing: [], planEntries: [] }, error: null, loading: false }
		]]));
		store.planEntryPages.set(new Map([[
			"PLAN1",
			{ data: { entries: [], nextBefore: null, total: 0 }, error: null, loading: false }
		]]));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (resource) => {
			if (String(resource).includes("/api/issue-comments")) {
				return new Response(JSON.stringify({ comments: [], nextBefore: null, total: 0 }), { status: 200 });
			}
			return new Response(JSON.stringify({ entity: issue, incoming: [], outgoing: [], planEntries: [] }), { status: 200 });
		});

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				affectedEntityIds: ["PLAN1", "ISS1"],
				affectedEntityKinds: ["plan", "issue"],
				affectedInitiativeIds: ["INIT1"],
				at: "2026-08-31T00:00:00.000Z",
				category: "plan-entry",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));

		await vi.waitFor(() => expect(store.entityDetails.get().get("ISS1")?.loading).toBe(false));
		expect(store.planEntryPages.get().get("PLAN1")).toEqual(expect.objectContaining({ stale: true }));
		const resourcePaths = fetchMock.mock.calls.map(([resource]) => String(resource));
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/entity-detail?entity=ISS1"))).toBe(true);
		expect(resourcePaths.some((resourcePath) => resourcePath.includes("/api/plan-entries?plan=ISS1"))).toBe(false);
	});

	it("does not lose pending local correlations during a burst of writes", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "unavailable" }), { status: 200 })
		);

		for (let index = 0; index < 101; index += 1) {
			store.applyLocalProjectChange({
				affectedEntityIds: [],
				affectedInitiativeIds: [],
				at: "2026-08-31T00:00:00.000Z",
				category: "entity",
				correlationId: `write-${index}`,
				projectId: "OTHER_PROJECT",
				type: "snapshot-changed"
			});
		}

		(store as unknown as { connectEvents(): void }).connectEvents();
		store.events?.onmessage?.(new MessageEvent("message", {
			data: JSON.stringify({
				at: "2026-08-31T00:00:00.000Z",
				category: "unknown",
				correlationId: "write-0",
				projectId: "PROJ1",
				type: "snapshot-changed"
			})
		}));
		await Promise.resolve();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("records the default tenant chooser route during startup", async () => {
		window.history.replaceState({}, "", "/");
		const store = new AgentIssuesStore();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ availableTenants: [{ displayName: "Demo", id: "demo" }], currentTenant: "demo", dbPath: "/tmp/agent-issues.db" }),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 }));

		store.connect();
		await vi.waitFor(() => expect(window.location.hash).toBe("#tenant=demo"));

		store.disconnect();
		fetchMock.mockRestore();
	});

	it("opens tenant-only hash links in project chooser scope", () => {
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.entityBackStack.set(["US1"]);
		window.location.hash = "tenant=demo";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.selectedId.get()).toBeNull();
		expect(store.entityBackStack.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo");
	});

	it("preserves tenant and project while removing unavailable detail route keys", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [makeEntity({ id: "ISS1" })] }));
		window.location.hash = "tenant=demo&project=PROJ1&entity=ISS2&initiative=INIT2&cascade=INIT2~ISS2";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBe("PROJ1");
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ1&page=project");
	});

	it("migrates legacy tenant query links and existing detail hashes into the shared hash route", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [makeEntity({ id: "ISS1" })] }));
		window.history.replaceState({}, "", "?tenant=demo#entity=ISS1");

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedId.get()).toBe("ISS1");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("#tenant=demo&entity=ISS1");
	});

	it("clears project and all detail when the viewer chooses another tenant", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.globalSearchCapability.set({ state: "available" });
		store.globalSearchQuery.set("search");
		store.globalSearchResponse.set({ results: [], state: "available" });
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		store.reRootTrail.set([["INIT1", "ISS1"]]);
		store.entityBackStack.set(["US1"]);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 })
		);

		await store.selectTenant("content-hub");

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(store.reRootTrail.get()).toEqual([]);
		expect(store.entityBackStack.get()).toEqual([]);
		expect(store.globalSearchCapability.get()).toBeNull();
		expect(store.globalSearchQuery.get()).toBe("");
		expect(store.globalSearchResponse.get()).toBeNull();
		expect(store.activeSection.get()).toBe("initiatives");
		expect(window.location.hash).toBe("#tenant=content-hub");
		fetchMock.mockRestore();
	});

	it("loads an explicitly selected project after clearing previous detail", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.globalSearchCapability.set({ state: "available" });
		store.globalSearchQuery.set("search");
		store.globalSearchResponse.set({ results: [], state: "available" });
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 })
		);

		await store.selectProject("PROJ2");

		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBeNull();
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(store.globalSearchCapability.get()).toBeNull();
		expect(store.globalSearchQuery.get()).toBe("");
		expect(store.globalSearchResponse.get()).toBeNull();
		expect(store.activeSection.get()).toBe("initiatives");
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ2&page=project");
		fetchMock.mockRestore();
	});

	it("retains the tenant chooser when an explicitly selected project is unavailable", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "unavailable" }), { status: 200 })
		);

		await store.selectProject("PROJ404");

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(store.syncLabel.get()).toBe("project unavailable");
		expect(window.location.hash).toBe("#tenant=demo");
		fetchMock.mockRestore();
	});

	it("reloads a project hash navigation and restores its selected entity", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		store.selectedInitiativeId.set("INIT1");
		store.cascadePath.set(["INIT1", "ISS1"]);
		window.location.hash = "tenant=demo&project=PROJ2&entity=ISS2";
		const issue = makeEntity({ id: "ISS2", kind: "issue", status: "todo", title: "Restored issue" });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot({ entities: [issue] }) }), { status: 200 })
		);

		await store.onBrowserNavigation();

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBe("ISS2");
		expect(store.selectedInitiativeId.get()).toBeNull();
		expect(store.cascadePath.get()).toEqual([]);
		expect(window.location.hash).toBe("#tenant=demo&project=PROJ2&entity=ISS2");
		fetchMock.mockRestore();
	});

	it("reloads tenant and project scope when browser history changes", async () => {
		const store = new AgentIssuesStore();
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.selectedId.set("ISS1");
		window.location.hash = "tenant=content-hub&project=PROJ2";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 })
		);

		await store.onPopState();

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBe("PROJ2");
		expect(store.selectedId.get()).toBeNull();
		expect(window.location.hash).toBe("#tenant=content-hub&project=PROJ2");
		fetchMock.mockRestore();
	});

	it("keeps an unavailable tenant in route state until the viewer chooses a replacement", () => {
		const store = new AgentIssuesStore();
		store.config.set({
			availableTenants: [{ displayName: "Demo", id: "demo" }],
			currentTenant: "demo",
			dbPath: "/tmp/agent-issues.db"
		});
		window.location.hash = "tenant=missing";

		store.onHashChange();

		expect(store.selectedTenant.get()).toBe("missing");
		expect(store.tenantOptions.get().map((tenant) => tenant.id)).toEqual(["demo", "missing"]);
		expect(window.location.hash).toBe("#tenant=missing");
	});
});

describe("epic section state", () => {
	it("keeps collapse state per selected project while a newly selected project starts expanded", () => {
		const store = new AgentIssuesStore();
		store.selectedProjectId.set("PROJ1");

		expect(store.isEpicExpanded("EPIC1")).toBe(true);
		store.toggleEpicExpanded("EPIC1");
		expect(store.isEpicExpanded("EPIC1")).toBe(false);

		store.selectedProjectId.set("PROJ2");
		expect(store.isEpicExpanded("EPIC1")).toBe(true);
		store.toggleEpicExpanded("EPIC2");
		expect(store.isEpicExpanded("EPIC2")).toBe(false);

		store.selectedProjectId.set("PROJ1");
		expect(store.isEpicExpanded("EPIC1")).toBe(false);
		expect(store.isEpicExpanded("EPIC2")).toBe(true);
	});
});

describe("deep-leaf ancestry derivation", () => {
	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	it("derives initiative -> PRD -> story -> issue for an issue that fixes one story", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, prd, story, issue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US18")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
	});

	it("derives initiative -> issue for an issue that fixes no story", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, issue],
				relations: [makeRelation("INIT4", "tracks", "ISS18")]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "ISS18"]);
	});

	it("derives a deterministic default branch when an issue fixes multiple stories", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const firstPrd = makeEntity({ id: "PRD4", kind: "prd" });
		const secondPrd = makeEntity({ id: "PRD5", kind: "prd" });
		const defaultStory = makeEntity({ id: "US18", kind: "userStory" });
		const otherStory = makeEntity({ id: "US20", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, firstPrd, secondPrd, defaultStory, otherStory, issue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("INIT4", "owns", "PRD5"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("PRD5", "creates", "US20"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US20"),
					makeRelation("ISS18", "fixes", "US18")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS18")).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
	});

	it("walks decomposes up to the root issue before taking the fixes hop for a sub-issue", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const rootIssue = makeEntity({ id: "ISS18", kind: "issue" });
		const midIssue = makeEntity({ id: "ISS30", kind: "issue" });
		const leafIssue = makeEntity({ id: "ISS31", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [initiative, prd, story, rootIssue, midIssue, leafIssue],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS18", "decomposes", "ISS30"),
					makeRelation("ISS30", "decomposes", "ISS31")
				]
			})
		);

		expect(store.cascadePathForLeaf("ISS31")).toEqual(["INIT4", "PRD4", "US18", "ISS18", "ISS30", "ISS31"]);
	});
});

describe("cascade column window capacity", () => {
	it("computes how many fixed-width columns fit in the available width", () => {
		const store = new AgentIssuesStore();

		expect(store.cascadeCapacityForWidth(1000)).toBe(2);
		expect(store.cascadeCapacityForWidth(1500)).toBe(3);
		expect(store.cascadeCapacityForWidth(496)).toBe(1);
		expect(store.cascadeCapacityForWidth(50)).toBe(1);
	});

	it("splits the lineage into a left breadcrumb and a window that always ends at the leaf", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		const window = store.cascadeColumnWindow.get();

		expect(window.breadcrumb.map((entity) => entity.id)).toEqual(["INIT4", "PRD4"]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["US18", "ISS18"]);
	});

	it("restores a breadcrumb ancestor into the window while keeping the leaf visible", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		store.restoreAncestor("PRD4");

		const window = store.cascadeColumnWindow.get();
		expect(window.breadcrumb.map((entity) => entity.id)).toEqual(["INIT4"]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["PRD4", "US18", "ISS18"]);
	});

	it("truncates the path to a clicked ancestor so that crumb becomes the leaf and deeper columns drop", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const prd = makeEntity({ id: "PRD4", kind: "prd" });
		const story = makeEntity({ id: "US18", kind: "userStory" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, prd, story, issue] }));
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);
		store.cascadeAvailableWidth.set(1000);

		store.truncateCascadeTo("PRD4");

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4"]);
		const window = store.cascadeColumnWindow.get();
		expect(window.breadcrumb).toEqual([]);
		expect(window.columns.map((entity) => entity.id)).toEqual(["INIT4", "PRD4"]);
	});

	it("ignores truncation to the leaf or an unknown id", () => {
		const initiative = makeEntity({ id: "INIT4", kind: "initiative", status: "active" });
		const issue = makeEntity({ id: "ISS18", kind: "issue" });
		const store = new AgentIssuesStore();
		store.snapshot.set(makeSnapshot({ entities: [initiative, issue] }));
		store.cascadePath.set(["INIT4", "ISS18"]);

		store.truncateCascadeTo("ISS18");
		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);

		store.truncateCascadeTo("NOPE");
		expect(store.cascadePath.get()).toEqual(["INIT4", "ISS18"]);
	});
});

describe("cascade hop connectors", () => {
	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	it("names the relation joining each adjacent pair in the lineage", () => {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("INIT4", "tracks", "ISS18"),
					makeRelation("ISS18", "decomposes", "ISS30")
				]
			})
		);

		expect(store.cascadeHopRelation("INIT4", "PRD4")).toBe("owns");
		expect(store.cascadeHopRelation("PRD4", "US18")).toBe("creates");
		expect(store.cascadeHopRelation("US18", "ISS18")).toBe("fixes");
		expect(store.cascadeHopRelation("INIT4", "ISS18")).toBe("tracks");
		expect(store.cascadeHopRelation("ISS18", "ISS30")).toBe("decomposes");
	});
});

describe("cascade branch selector", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	function makeBranchingStore(): AgentIssuesStore {
		const entities = [
			makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
			makeEntity({ id: "INIT2", kind: "initiative", status: "active", title: "Other initiative" }),
			makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
			makeEntity({ id: "PRD2", kind: "prd", title: "Other PRD" }),
			makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
			makeEntity({ id: "US40", kind: "userStory", title: "Other story" }),
			makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" })
		];
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities,
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("INIT2", "owns", "PRD2"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("PRD2", "creates", "US40"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS18", "fixes", "US40")
				]
			})
		);
		return store;
	}

	it("describes a branch selector at a fixes hop with multiple candidate stories", () => {
		const store = makeBranchingStore();

		const seam = store.cascadeSeamFor("US18", "ISS18");

		expect(seam.relation).toBe("fixes");
		expect(seam.branch?.options.map((entity) => entity.id)).toEqual(["US18", "US40"]);
		expect(seam.branch?.selectedIndex).toBe(0);
	});

	it("reports no branch selector at a single-candidate fixes hop or a structural hop", () => {
		const store = makeBranchingStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [
					makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
					makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" }),
					makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" })
				],
				relations: [makeRelation("ISS18", "fixes", "US18"), makeRelation("PRD4", "creates", "US18")]
			})
		);

		expect(store.cascadeSeamFor("US18", "ISS18").branch).toBeNull();
		expect(store.cascadeSeamFor("PRD4", "US18").branch).toBeNull();
	});

});

describe("re-root trail", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	function makeRelation(fromId: string, type: string, toId: string): Relation {
		return { createdAt: "2026-01-01T00:00:00.000Z", fromId, toId, type };
	}

	function makeTrailStore(): AgentIssuesStore {
		const store = new AgentIssuesStore();
		store.snapshot.set(
			makeSnapshot({
				entities: [
					makeEntity({ id: "INIT4", kind: "initiative", status: "active", title: "Lineage column navigation" }),
					makeEntity({ id: "PRD4", kind: "prd", title: "Console PRD" }),
					makeEntity({ id: "US18", kind: "userStory", title: "Drill the lineage" }),
					makeEntity({ id: "ISS18", kind: "issue", title: "Cascade skeleton" }),
					makeEntity({ id: "ISS40", kind: "issue", title: "Cross-linked issue" })
				],
				relations: [
					makeRelation("INIT4", "owns", "PRD4"),
					makeRelation("PRD4", "creates", "US18"),
					makeRelation("ISS18", "fixes", "US18"),
					makeRelation("ISS40", "blocks", "ISS18")
				]
			})
		);
		return store;
	}

	it("replaces the cascade with the target's lineage and pushes a chip for the stack left behind", () => {
		const store = makeTrailStore();
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.reRootCascade("ISS40");

		expect(store.reRootTrail.get()).toEqual([["INIT4", "PRD4", "US18", "ISS18"]]);
		expect(store.cascadePath.get()).toEqual(["ISS40"]);
	});

	it("restores the full stack when a chip is clicked and pops the trail back to it", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"], ["INIT4", "PRD4", "US18", "ISS18"]]);
		store.cascadePath.set(["ISS40"]);

		store.restoreReRoot(1);

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
	});

	it("updates the current stack in place when drilling or branch-switching, without pushing a chip", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"]]);
		store.cascadePath.set(["INIT4", "PRD4", "US18", "ISS18"]);

		store.drillCascade("ISS18", "ISS41");

		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18", "ISS41"]);
	});

	it("pops the most recent chip on browser back", () => {
		const store = makeTrailStore();
		store.reRootTrail.set([["INIT4"], ["INIT4", "PRD4", "US18", "ISS18"]]);
		store.cascadePath.set(["ISS40"]);

		store.popReRoot();

		expect(store.cascadePath.get()).toEqual(["INIT4", "PRD4", "US18", "ISS18"]);
		expect(store.reRootTrail.get()).toEqual([["INIT4"]]);
	});
});

describe("collapse toggles and auto-collapse", () => {
	afterEach(() => {
		window.location.hash = "";
	});

	it("keeps the master list expanded while the cascade is shallow", () => {
		const store = new AgentIssuesStore();
		store.openCascade("INIT4");

		expect(store.masterCollapsed.get()).toBe(false);
	});

	it("toggles the rail collapse state independently of the master list", () => {
		const store = new AgentIssuesStore();

		expect(store.railCollapsed.get()).toBe(false);
		store.toggleRail();

		expect(store.railCollapsed.get()).toBe(true);
		expect(store.masterCollapsed.get()).toBe(false);
	});

	it("lets a manual collapse while shallow persist", () => {
		const store = new AgentIssuesStore();
		store.openCascade("INIT4");

		store.toggleMaster();

		expect(store.masterCollapsed.get()).toBe(true);
	});
});


