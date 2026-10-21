import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./agent-issues-app.js";
import type { ContextDetails, Entity, InitiativeBundle, ProjectDiscovery, ProjectRollup, ProjectSummary, SiteConfig, Snapshot } from "./models.js";
import { AgentIssuesStore } from "./services/agent-issues-store.js";

function makeEntity(overrides: Partial<Entity> & Pick<Entity, "id">): Entity {
	return {
		body: "",
		createdAt: "2026-01-01T00:00:00.000Z",
		kind: "initiative",
		status: "draft",
		title: `Title for ${overrides.id}`,
		updatedAt: "2026-01-01T00:00:00.000Z",
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
	const initiatives = overrides.initiatives ?? [];
	const relations = overrides.relations ?? [];
	const ownedInitiativeIds = new Set(relations.filter((relation) => relation.type === "contains").map((relation) => relation.toId));
	const defaultEpic = makeEntity({ id: "EPIC0", kind: "epic", status: "active", title: "Default Epic" });
	const defaultEpicRelations = initiatives
		.filter((bundle) => !ownedInitiativeIds.has(bundle.initiative.id))
		.map((bundle) => ({
			createdAt: "2026-01-01T00:00:00.000Z",
			fromId: defaultEpic.id,
			toId: bundle.initiative.id,
			type: "contains"
		}));
	const entities = defaultEpicRelations.length > 0 ? [defaultEpic, ...(overrides.entities ?? [])] : overrides.entities ?? [];

	return {
		...overrides,
		contexts: overrides.contexts ?? { initiatives: [], shared: makeSharedContext() },
		entities,
		generatedAt: overrides.generatedAt ?? "2026-01-01T00:00:00.000Z",
		initiatives,
		issueComments: overrides.issueComments ?? {},
		orphans: overrides.orphans ?? [],
		projectAdrs: overrides.projectAdrs ?? [],
		relations: [...relations, ...defaultEpicRelations],
		users: overrides.users ?? []
	};
}

function makeConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
	return {
		availableTenants: [{ displayName: "Demo", id: "demo" }],
		currentTenant: "demo",
		dbPath: "/tmp/agent-issues.db",
		...overrides
	};
}

function makeProjectDiscovery(projects: ProjectRollup[]): ProjectDiscovery {
	return { kind: "available", projects };
}

function makeProjectSummary(snapshot: Snapshot): ProjectSummary {
	const toSummary = ({ body, bodySource, ...entity }: Entity) => entity;
	const project = snapshot.entities.find((entity) => entity.kind === "project") ?? makeEntity({ id: "PROJ1", kind: "project", title: "Console Viewer" });
	const bundlesByInitiativeId = new Map(snapshot.initiatives.map((bundle) => [bundle.initiative.id, bundle]));
	const epics = snapshot.entities
		.filter((entity) => entity.kind === "epic")
		.map((epic) => ({
			epic: toSummary(epic),
			initiatives: snapshot.relations
				.filter((relation) => relation.type === "contains" && relation.fromId === epic.id)
				.map((relation) => bundlesByInitiativeId.get(relation.toId))
				.filter((bundle): bundle is InitiativeBundle => Boolean(bundle))
				.map((bundle) => ({
					initiative: toSummary(bundle.initiative),
					issueCount: bundle.issues.length,
					completedIssueCount: bundle.issues.filter((issue) => issue.status === "done").length,
					userStoryCount: bundle.userStories.length
				}))
		}))
		.filter((group) => group.initiatives.length > 0);
	const initiatives = epics.flatMap((group) => group.initiatives);

	return {
		kind: "available",
		project: toSummary(project),
		epics,
		counts: {
			completedInitiatives: initiatives.filter((rollup) => rollup.initiative.status === "done").length,
			epics: epics.length,
			initiatives: initiatives.length
		}
	};
}

function makeStore(config: SiteConfig, snapshot: Snapshot): AgentIssuesStore {
	const store = new AgentIssuesStore();
	store.connected = true;
	store.config.set(config);
	store.snapshot.set(snapshot);
	store.projectSummary.set(makeProjectSummary(snapshot));
	store.selectedTenant.set(config.currentTenant);
	store.selectedProjectId.set("PROJ1");
	return store;
}

async function mountApp(store: AgentIssuesStore) {
	const app = document.createElement("agent-issues-app");
	app.store = store;
	document.body.appendChild(app);
	await app.updateComplete;
	return app;
}

beforeEach(() => {
	window.history.replaceState({}, "", "/");
});

afterEach(() => {
	document.body.replaceChildren();
	document.documentElement.removeAttribute("data-theme");
	window.localStorage.removeItem("agent-issues-theme");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("three-pane console shell", () => {
	it.each(["page", "owner", "browser Back", "section", "entity", "initiative", "search result"])("protects pending instructions when %s navigation is cancelled", async (navigation) => {
		const source = { type: "default", revision: 1, contentHash: "default" };
		const items = [
			{ key: "agent/agent-issues", kind: "agent", body: "Agent instructions", source },
			{ key: "fragment/rules", kind: "fragment", body: "Rules", source }
		];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(String(input), window.location.origin);
			if (url.pathname.endsWith("catalog")) return Response.json({ version: "0.2.0", items, owner: { type: "cloud", tenantId: "demo", userId: "author" } });
			if (url.pathname === "/api/projects") return Response.json({ kind: "available", projects: [] });
			return Response.json({ ...items.find((item) => item.key === url.searchParams.get("key")), version: "0.2.0" });
		});
		const store = makeStore(makeConfig({ availableTenants: [{ id: "demo", displayName: "Demo" }, { id: "other", displayName: "Other" }] }), makeSnapshot());
		await store.openInstructions();
		await store.selectInstruction("agent/agent-issues");
		const app = await mountApp(store);
		const view = app.shadowRoot!.querySelector("agent-issues-instructions-view")!;
		await view.updateComplete;
		const editor = view.shadowRoot!.querySelector("agent-issues-instruction-editor")!;
		await vi.waitFor(() => expect(editor.shadowRoot?.querySelector('[contenteditable="true"]')).toBeTruthy());
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-insert-fragment]")!.click();
		await editor.updateComplete;
		editor.shadowRoot!.querySelector<HTMLButtonElement>("[data-fragment-key]")!.click();
		await vi.waitFor(() => expect(view.shadowRoot!.querySelector<HTMLButtonElement>("[data-save-instruction]")!.disabled).toBe(false));
		const pending = await editor.readMarkdown();
		const route = window.location.hash;
		fetchMock.mockClear();
		if (navigation === "page") app.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Projects"]')!.click();
		else if (navigation === "owner") await store.selectTenant("other");
		else if (navigation === "section") store.selectSection("context");
		else if (navigation === "entity") store.selectEntity("ISS-other");
		else if (navigation === "initiative") store.selectInitiative("INIT-other");
		else if (navigation === "search result") await store.openSearchTarget({ type: "context" });
		else {
			window.history.replaceState({}, "", "#tenant=other&page=instructions&category=fragment");
			await store.onPopState();
		}
		await view.updateComplete;
		expect(view.shadowRoot!.querySelector('[role="dialog"]')).toBeTruthy();
		view.shadowRoot!.querySelector<HTMLButtonElement>("[data-cancel-navigation]")!.click();
		await view.updateComplete;
		expect(store.activePage.get()).toBe("instructions");
		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedInstructionKey.get()).toBe("agent/agent-issues");
		expect(window.location.hash).toBe(route);
		expect(await editor.readMarkdown()).toBe(pending);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("opens personal instructions without a project and browses searchable categories", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const source = { type: "default", revision: 1, contentHash: "default-hash" };
		const items = [
			{ key: "agent/agent-issues", kind: "agent", body: "# Agent", source },
			{ key: "skill/prepare", kind: "skill", body: "# Personal prepare", source: { ...source, type: "override", defaultVersion: "0.1.0" },
				releaseChanges: { defaultVersion: "0.2.0", newerDefaultAvailable: true, defaultChanged: true, dependencies: { added: [], removed: [], changed: [] } } },
			{ key: "skill/tdd", kind: "skill", body: "# TDD", source },
			{ key: "fragment/rules", kind: "fragment", body: "Rules", source }
		];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(String(input), window.location.origin);
			expect(url.searchParams.has("project")).toBe(false);
			if (url.pathname === "/api/instructions/catalog") {
				return new Response(JSON.stringify({ version: "0.2.0", items, owner: { type: "local" } }));
			}
			const item = items.find((candidate) => candidate.key === url.searchParams.get("key"));
			return new Response(JSON.stringify({ ...item, version: "0.2.0" }));
		});
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		store.projectDiscovery.set({ kind: "available", projects: [] });
		const app = await mountApp(store);
		const open = app.shadowRoot?.querySelector<HTMLButtonElement>("[data-open-instructions]");
		expect(open).not.toBeNull();
		open?.click();
		await vi.waitFor(() => expect(app.shadowRoot?.querySelector("agent-issues-instructions-view")).not.toBeNull());
		const view = app.shadowRoot!.querySelector("agent-issues-instructions-view")!;
		await vi.waitFor(() => expect(view.shadowRoot?.textContent).toContain("Local profile"));
		view.shadowRoot?.querySelector<HTMLButtonElement>('[data-category="skill"]')?.click();
		await view.updateComplete;
		const search = view.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")!;
		search.value = "prepare";
		search.dispatchEvent(new Event("input"));
		await view.updateComplete;
		expect(view.shadowRoot?.querySelectorAll("[data-instruction-key]")).toHaveLength(1);
		expect(view.shadowRoot?.textContent).toContain("Personal edits");
		expect(view.shadowRoot?.textContent).toContain("Newer default");
		view.shadowRoot?.querySelector<HTMLButtonElement>("[data-instruction-key]")?.click();
		await vi.waitFor(() => expect(view.shadowRoot?.querySelector("agent-issues-instruction-editor")?.shadowRoot?.querySelector("[data-instruction-source]")?.textContent).toContain("Personal prepare"));
		expect(view.shadowRoot?.textContent).toContain("0.2.0");
		expect(new URLSearchParams(window.location.hash.slice(1)).get("page")).toBe("instructions");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("opens the global search dialog from the app-shell trigger", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));

		const trigger = app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]");
		expect(trigger).not.toBeNull();
		trigger?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		const dialog = overlay?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]');
		const input = dialog?.querySelector<HTMLInputElement>("input");
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
		expect(overlay?.shadowRoot?.activeElement).toBe(input);
	});

	it("opens the global search dialog with Command+K", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).not.toBeNull();
	});

	it("opens the global search dialog with Control+K", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));

		window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "k" }));
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).not.toBeNull();
	});

	it("closes global search with Escape and restores focus to its trigger", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		const trigger = app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]");
		trigger?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		overlay?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Escape" })
		);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).toBeNull();
		expect(app.shadowRoot?.activeElement).toBe(trigger);
	});

	it("closes global search when Escape is pressed outside the input", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		const trigger = app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]");
		trigger?.click();
		await app.updateComplete;

		window.dispatchEvent(new KeyboardEvent("keydown", { cancelable: true, key: "Escape" }));
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).toBeNull();
		expect(app.shadowRoot?.activeElement).toBe(trigger);
	});

	it("closes global search when the backdrop is pressed", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		const trigger = app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]");
		trigger?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		overlay?.shadowRoot?.querySelector<HTMLElement>(".backdrop")?.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, composed: true })
		);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).toBeNull();
		expect(app.shadowRoot?.activeElement).toBe(trigger);
	});

	it("keeps Tab focus in the global search dialog", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		const dialog = overlay?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]');
		const lastFocusable = [...(overlay?.shadowRoot?.querySelectorAll<HTMLElement>("button, input, select") ?? [])].at(-1);
		lastFocusable?.focus();
		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" });
		dialog?.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(overlay?.shadowRoot?.activeElement).toBe(overlay?.shadowRoot?.querySelector("input"));
	});

	it("renders the active global search result and opens its target with Enter", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const resultEntity = makeEntity({ id: "ISS1", kind: "issue", shortReference: "ISS_ABC123", status: "todo", title: "Apply search results" });
		const store = makeStore(makeConfig(), makeSnapshot({ entities: [resultEntity] }));
		store.globalSearchResponse.set({
			results: [{
				id: "search-ISS1",
				identity: { reference: "ISS_ABC123", shortReference: "ISS_ABC123", sourceId: resultEntity.id, sourceType: "entity" },
				match: { field: "title" },
				navigationTarget: { entityId: resultEntity.id, type: "entity" },
				projectId: "PROJ1",
				projectLabel: "Demo project",
				snippet: { highlights: [{ end: 5, start: 0 }], text: "Apply search results" },
				statusOrRole: "todo",
				title: resultEntity.title,
				updatedAt: resultEntity.updatedAt
			}],
			state: "available"
		});
		const openSearchTarget = vi.spyOn(store, "openSearchTarget");
		const app = await mountApp(store);
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Apply search results");
		expect(overlay?.shadowRoot?.textContent).toContain("ISS_ABC123");

		overlay?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "Enter" })
		);
		await app.updateComplete;

		expect(openSearchTarget).toHaveBeenCalledWith({ entityId: resultEntity.id, type: "entity" }, "PROJ1");
		expect(store.selectedId.get()).toBe(resultEntity.id);
		await vi.waitFor(() => expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).toBeNull());
	});

	it("changes the active global search result with Arrow keys and opens it by mouse", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const firstEntity = makeEntity({ id: "ISS1", kind: "issue", shortReference: "ISS_ABC123", title: "First result" });
		const secondEntity = makeEntity({ id: "ISS2", kind: "issue", shortReference: "ISS_DEF456", title: "Second result" });
		const store = makeStore(makeConfig(), makeSnapshot({ entities: [firstEntity, secondEntity] }));
		store.globalSearchResponse.set({
			results: [firstEntity, secondEntity].map((entity) => ({
				id: `search-${entity.id}`,
				identity: { reference: entity.shortReference!, shortReference: entity.shortReference!, sourceId: entity.id, sourceType: "entity" as const },
				match: { field: "title" as const },
				navigationTarget: { entityId: entity.id, type: "entity" as const },
				projectId: "PROJ1",
				projectLabel: "Demo project",
				title: entity.title,
				updatedAt: entity.updatedAt
			})),
			state: "available"
		});
		const app = await mountApp(store);
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		const dialog = overlay?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]');
		dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "ArrowDown" }));
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.querySelectorAll(".result")[1]?.getAttribute("aria-selected")).toBe("true");

		(overlay?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".result")[1])?.click();
		await app.updateComplete;

		expect(store.selectedId.get()).toBe(secondEntity.id);
		await vi.waitFor(() => expect(app.shadowRoot?.querySelector("agent-issues-global-search-overlay")).toBeNull());
	});

	it("updates global search scope and record-kind filters", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		const scope = overlay?.shadowRoot?.querySelector<HTMLInputElement>("[data-global-search-scope]");
		const sourceType = overlay?.shadowRoot?.querySelector<HTMLButtonElement>("[data-source-type='plan-entry']");
		scope!.checked = true;
		scope?.dispatchEvent(new Event("change"));
		sourceType?.click();
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;

		expect(app.store.globalSearchScope.get()).toBe("all-projects");
		expect(app.store.globalSearchSourceTypes.get()).not.toContain("plan-entry");
		expect(sourceType?.getAttribute("aria-pressed")).toBe("false");
	});

	it("shows empty and retry states before later search results", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const resultEntity = makeEntity({ id: "ISS1", kind: "issue", shortReference: "ISS_ABC123", title: "Recovered result" });
		const store = makeStore(makeConfig(), makeSnapshot({ entities: [resultEntity] }));
		store.globalSearchResponse.set({ state: "operational-error" });
		const app = await mountApp(store);
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Unable to search records");

		store.globalSearchResponse.set({ results: [], state: "available" });
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("No matching records");

		store.globalSearchResponse.set({
			results: [{
				id: "search-ISS1",
				identity: { reference: "ISS_ABC123", shortReference: "ISS_ABC123", sourceId: resultEntity.id, sourceType: "entity" },
				match: { field: "title" },
				navigationTarget: { entityId: resultEntity.id, type: "entity" },
				projectId: "PROJ1",
				projectLabel: "Demo project",
				title: resultEntity.title,
				updatedAt: resultEntity.updatedAt
			}],
			state: "available"
		});
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Recovered result");
	});

	it("shows a parse error while keeping the last valid global search result", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const resultEntity = makeEntity({ id: "ISS1", kind: "issue", shortReference: "ISS_ABC123", title: "Valid result" });
		const store = makeStore(makeConfig(), makeSnapshot({ entities: [resultEntity] }));
		store.globalSearchResults.set([{
			id: "search-ISS1",
			identity: { reference: "ISS_ABC123", shortReference: "ISS_ABC123", sourceId: resultEntity.id, sourceType: "entity" },
			match: { field: "title" },
			navigationTarget: { entityId: resultEntity.id, type: "entity" },
			projectId: "PROJ1",
			projectLabel: "Demo project",
			title: resultEntity.title,
			updatedAt: resultEntity.updatedAt
		}]);
		store.globalSearchResponse.set({
			error: { end: 11, message: "Expected a term after OR.", start: 9 },
			state: "parse-error"
		});
		const app = await mountApp(store);
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Expected a term after OR.");
		expect(overlay?.shadowRoot?.textContent).toContain("Valid result");
	});

	it("limits global search to twenty results and asks the user to refine", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const store = makeStore(makeConfig(), makeSnapshot());
		const results = Array.from({ length: 21 }, (_, index) => ({
				id: `search-ISS${index}`,
				identity: { reference: `ISS_${index}`, shortReference: `ISS_${index}`, sourceId: `ISS${index}`, sourceType: "entity" as const },
				match: { field: "title" as const },
				navigationTarget: { entityId: `ISS${index}`, type: "entity" as const },
				projectId: "PROJ1",
				projectLabel: "Demo project",
				title: `Result ${index}`,
				updatedAt: "2026-01-01T00:00:00.000Z"
			}));
		store.globalSearchResults.set(results);
		store.globalSearchResponse.set({ results, state: "available" });
		const app = await mountApp(store);
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.querySelectorAll(".result")).toHaveLength(20);
		expect(overlay?.shadowRoot?.textContent).toContain("Refine the query to narrow the results.");
	});

	it("shows current-project recent records and excludes missing records", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const recentEntity = makeEntity({ id: "ISS1", kind: "issue", title: "Recent issue" });
		window.localStorage.setItem("agent-issues-global-search-recents:demo:PROJ1", JSON.stringify([
			{ entityId: "ISS1", type: "entity" },
			{ entityId: "REMOVED", type: "entity" }
		]));
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot({ entities: [recentEntity] })));
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Recently opened");
		expect(overlay?.shadowRoot?.textContent).toContain("Recent issue");
		expect(overlay?.shadowRoot?.textContent).not.toContain("REMOVED");
	});

	it("shows compact syntax help and an empty-search hint", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		app.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-trigger]")?.click();
		await app.updateComplete;

		const overlay = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-global-search-overlay");
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("Use quotes for phrases or * for a prefix.");
		overlay?.shadowRoot?.querySelector<HTMLButtonElement>("[data-global-search-help]")?.click();
		await (overlay as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
		expect(overlay?.shadowRoot?.textContent).toContain("AND, OR, NOT, parentheses, and NEAR");
	});

	it("uses an icon trigger on narrow screens", async () => {
		vi.stubGlobal("innerWidth", 390);
		const app = await mountApp(makeStore(makeConfig(), makeSnapshot()));

		expect(app.shadowRoot?.querySelector(".global-search-trigger")).toBeNull();
		expect(app.shadowRoot?.querySelector(".global-search-icon-trigger")).not.toBeNull();
	});

	it("uses a header rail with side-by-side master and detail panes at medium widths", async () => {
		vi.stubGlobal("innerWidth", 1080);
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const store = makeStore(makeConfig(), makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		}));
		store.selectInitiative(initiative.id);
		const app = await mountApp(store);

		const console = app.shadowRoot?.querySelector(".console");
		expect(console?.classList.contains("medium")).toBe(true);
		expect(console?.classList.contains("narrow")).toBe(false);
		expect(app.shadowRoot?.querySelector('[data-theme-toggle="header"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector('[data-theme-toggle="rail"]')).toBeNull();
		expect(app.shadowRoot?.querySelector('[data-pane="master"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-initiative-detail-view')).not.toBeNull();
	});

	it("hides the medium master pane for top-level Context and Graph sections", async () => {
		vi.stubGlobal("innerWidth", 1080);
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		for (const section of ["context", "graph"] as const) {
			store.selectSection(section);
			await app.updateComplete;
			expect(app.shadowRoot?.querySelector(".console")?.classList.contains("wide")).toBe(true);
			expect(app.shadowRoot?.querySelector('[data-pane="master"]')).toBeNull();
			expect(app.shadowRoot?.querySelector('[data-pane="detail"]')).not.toBeNull();
		}
	});

	it("uses a detail-first narrow workspace with an on-demand record list", async () => {
		vi.stubGlobal("innerWidth", 390);
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const store = makeStore(makeConfig(), makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		}));
		store.selectInitiative(initiative.id);
		const app = await mountApp(store);

		const console = app.shadowRoot?.querySelector(".console");
		expect(console?.classList.contains("narrow")).toBe(true);
		expect(console?.classList.contains("has-detail")).toBe(true);
		expect(app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-initiative-detail-view')).not.toBeNull();
		expect(app.shadowRoot?.querySelector<HTMLButtonElement>(".mobile-master-toggle")?.getAttribute("aria-pressed")).toBe("false");

		app.shadowRoot?.querySelector<HTMLButtonElement>(".mobile-master-toggle")?.click();
		await app.updateComplete;
		expect(console?.classList.contains("mobile-master-open")).toBe(true);
		expect(app.shadowRoot?.querySelector<HTMLButtonElement>(".mobile-master-toggle")?.getAttribute("aria-pressed")).toBe("true");
		expect(app.shadowRoot?.activeElement).toBe(app.shadowRoot?.querySelector(".master-search"));

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-section="adrs"]')?.click();
		await app.updateComplete;
		expect(console?.classList.contains("mobile-master-open")).toBe(false);
	});

	it("switches themes from the rail footer and compact header", async () => {
		vi.stubGlobal("innerWidth", 1280);
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const railToggle = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-theme-toggle="rail"]');
		expect(railToggle).not.toBeNull();
		railToggle?.click();
		await app.updateComplete;
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(window.localStorage.getItem("agent-issues-theme")).toBe("dark");

		document.body.replaceChildren();
		const remountedApp = await mountApp(makeStore(makeConfig(), makeSnapshot()));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="rail"]')?.getAttribute("aria-pressed")).toBe("true");

		vi.stubGlobal("innerWidth", 1080);
		window.dispatchEvent(new Event("resize"));
		await remountedApp.updateComplete;
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="rail"]')).toBeNull();
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="header"]')?.getAttribute("aria-pressed")).toBe("true");

		vi.stubGlobal("innerWidth", 1280);
		window.dispatchEvent(new Event("resize"));
		await remountedApp.updateComplete;
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="rail"]')).not.toBeNull();
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="header"]')).toBeNull();

		vi.stubGlobal("innerWidth", 390);
		window.dispatchEvent(new Event("resize"));
		await remountedApp.updateComplete;
		expect(remountedApp.shadowRoot?.querySelector('[data-theme-toggle="rail"]')).toBeNull();

		const headerToggle = remountedApp.shadowRoot?.querySelector<HTMLButtonElement>('[data-theme-toggle="header"]');
		expect(headerToggle).not.toBeNull();
		headerToggle?.click();
		await remountedApp.updateComplete;
		expect(document.documentElement.dataset.theme).toBe("light");
	});

	it("renders the selected tenant's project chooser when no project is selected", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		const app = await mountApp(store);

		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector('[data-pane="rail"]')).toBeNull();
	});

	it("shows each discovered project with its epic, initiative, and completion rollups", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		store.projectDiscovery.set(
			makeProjectDiscovery([
				{
					completedInitiativeCount: 3,
					epicCount: 2,
					initiativeCount: 4,
					project: makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Console Viewer" })
				}
			])
		);
		const app = await mountApp(store);

		const card = app.shadowRoot?.querySelector<HTMLElement>('[data-project="PROJ1"]');
		expect(card?.textContent).toContain("2 epics");
		expect(card?.textContent).toContain("4 initiatives");
		expect(card?.textContent).toContain("3/4 completed");
		expect(card?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("75");
	});

	it("keeps empty and unavailable tenants distinct without offering a project to open", async () => {
		const emptyStore = makeStore(makeConfig(), makeSnapshot());
		emptyStore.selectedProjectId.set(null);
		emptyStore.projectDiscovery.set(makeProjectDiscovery([]));
		const emptyApp = await mountApp(emptyStore);

		expect(emptyApp.shadowRoot?.textContent).toContain("has no available projects");
		expect(emptyApp.shadowRoot?.querySelector("[data-project]")).toBeNull();

		const unavailableStore = makeStore(makeConfig(), makeSnapshot());
		unavailableStore.selectedProjectId.set(null);
		unavailableStore.projectDiscovery.set({ kind: "unavailable" });
		const unavailableApp = await mountApp(unavailableStore);

		expect(unavailableApp.shadowRoot?.textContent).toContain("tenant is unavailable");
		expect(unavailableApp.shadowRoot?.querySelector("[data-project]")).toBeNull();
	});

	it("opens a chosen project and returns to the same tenant's chooser from the project switcher", async () => {
		vi.stubGlobal(
			"EventSource",
			class {
				public close() {}
			}
		);
		const store = makeStore(makeConfig(), makeSnapshot());
		store.selectedProjectId.set(null);
		store.projectDiscovery.set(
			makeProjectDiscovery([
				{
					completedInitiativeCount: 0,
					epicCount: 1,
					initiativeCount: 1,
					project: makeEntity({ id: "PROJ2", kind: "project", status: "active", title: "Payments" })
				}
			])
		);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ kind: "available", snapshot: makeSnapshot() }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						makeProjectDiscovery([
							{
								completedInitiativeCount: 0,
								epicCount: 1,
								initiativeCount: 1,
								project: makeEntity({ id: "PROJ2", kind: "project", status: "active", title: "Payments" })
							}
						])
					),
					{ status: 200 }
				)
			);
		const app = await mountApp(store);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-project="PROJ2"]')?.click();
		await vi.waitFor(() => expect(store.selectedProjectId.get()).toBe("PROJ2"));
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector('[data-pane="rail"]')).not.toBeNull();
		expect(app.shadowRoot?.querySelector<HTMLButtonElement>(".projects-button")).toBeNull();
		app.shadowRoot?.querySelector<HTMLButtonElement>(".switcher-button")?.click();
		await app.updateComplete;

		expect(store.selectedTenant.get()).toBe("demo");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
		await vi.waitFor(() => expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/projects?tenant=demo"));
		fetchMock.mockRestore();
	});

	it("renders a project rail, an initiative master list, and a detail pane simultaneously", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const root = app.shadowRoot;
		expect(root?.querySelector('[data-pane="rail"]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="master"]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="detail"]')).not.toBeNull();
	});

	it("shows progress inside the initiative list while Project Summary loads", async () => {
		const store = new AgentIssuesStore();
		store.connected = true;
		store.config.set(makeConfig());
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.syncLabel.set("connecting");

		const app = await mountApp(store);
		const loadingState = app.shadowRoot?.querySelector<HTMLElement>('[data-pane="master"] [role="status"]');

		expect(loadingState?.textContent).toContain("Loading initiatives");
		expect(loadingState?.querySelector(".master-loading-spinner")).not.toBeNull();
		expect(app.shadowRoot?.querySelector('[data-pane="master"] .master-list')).not.toBeNull();
	});

	it("renders Initiative Rollups in the master list without a project snapshot", async () => {
		const store = new AgentIssuesStore();
		store.config.set(makeConfig());
		store.selectedTenant.set("demo");
		store.selectedProjectId.set("PROJ1");
		store.projectSummary.set({
			kind: "available",
			project: { createdAt: "2026-01-01T00:00:00.000Z", id: "PROJ1", kind: "project", status: "active", title: "Console Viewer", updatedAt: "2026-01-01T00:00:00.000Z" },
			epics: [{
				epic: { createdAt: "2026-01-01T00:00:00.000Z", id: "EPIC1", kind: "epic", status: "active", title: "Platform work", updatedAt: "2026-01-01T00:00:00.000Z" },
				initiatives: [{
					initiative: { createdAt: "2026-01-01T00:00:00.000Z", id: "INIT1", kind: "initiative", status: "active", title: "Progressive loading", updatedAt: "2026-01-01T00:00:00.000Z" },
					issueCount: 2,
					completedIssueCount: 1,
					userStoryCount: 3
				}]
			}],
			counts: { completedInitiatives: 0, epics: 1, initiatives: 1 }
		});
		const app = await mountApp(store);

		const card = app.shadowRoot?.querySelector<HTMLElement>('[data-initiative="INIT1"]');
		expect(card?.textContent).toContain("Progressive loading");
		expect(card?.textContent).toContain("1/2 issues");
		const storyTotal = [...(app.shadowRoot?.querySelectorAll<HTMLElement>(".nav-item.static") ?? [])]
			.find((item) => item.textContent?.includes("User stories"));
		expect(storyTotal?.querySelector(".nav-count")?.textContent).toBe("3");
	});

	it("lists every available project in the rail", async () => {
		const config = makeConfig({
			availableTenants: [
				{ displayName: "Demo", id: "demo" },
				{ displayName: "Content Hub", id: "content-hub" }
			],
			currentTenant: "demo"
		});
		const store = makeStore(config, makeSnapshot());
		const app = await mountApp(store);

		const railTenants = app.shadowRoot?.querySelectorAll('[data-pane="rail"] [data-tenant]');
		const tenantIds = [...(railTenants ?? [])].map((element) => element.getAttribute("data-tenant"));
		expect(tenantIds).toEqual(["content-hub", "demo"]);
	});

	it("renders one master-list entry per initiative in the snapshot", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" })),
				makeBundle(makeEntity({ id: "INIT2", title: "Search" }))
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItems = app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-initiative]');
		const initiativeIds = [...(masterItems ?? [])].map((element) => element.getAttribute("data-initiative"));
		expect(initiativeIds).toEqual(["INIT1", "INIT2"]);
	});

	it("sorts initiatives by last changed by default and shows created and changed dates", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ createdAt: "2026-01-03T00:00:00.000Z", id: "INIT1", title: "Earlier change", updatedAt: "2026-02-01T00:00:00.000Z" })),
				makeBundle(makeEntity({ createdAt: "2026-01-01T00:00:00.000Z", id: "INIT2", title: "Later change", updatedAt: "2026-03-01T00:00:00.000Z" }))
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const cards = [...app.shadowRoot?.querySelectorAll<HTMLElement>('[data-pane="master"] [data-initiative]') ?? []];
		expect(cards.map((card) => card.dataset.initiative)).toEqual(["INIT2", "INIT1"]);
		const dates = cards[0]?.querySelector(".m-dates");
		expect([...dates?.querySelectorAll("i") ?? []].map((label) => label.textContent)).toEqual(["created", "changed"]);
		expect([...dates?.querySelectorAll("b") ?? []].map((date) => date.textContent)).toEqual([
			store.formatTimestamp("2026-01-01T00:00:00.000Z"),
			store.formatTimestamp("2026-03-01T00:00:00.000Z")
		]);
		expect(cards[0]?.lastElementChild).toBe(dates);
		expect(app.shadowRoot?.querySelector<HTMLSelectElement>("[data-initiative-sort]")?.value).toBe("changed");
	});

	it("changes the initiative sort criterion", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ createdAt: "2026-02-01T00:00:00.000Z", id: "INIT1", title: "Zulu", updatedAt: "2026-03-01T00:00:00.000Z" })),
				makeBundle(makeEntity({ createdAt: "2026-01-01T00:00:00.000Z", id: "INIT2", title: "Alpha", updatedAt: "2026-02-01T00:00:00.000Z" }))
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);
		const sort = app.shadowRoot?.querySelector<HTMLSelectElement>("[data-initiative-sort]");

		if (!sort) {
			throw new Error("Expected initiative sort control");
		}
		sort.value = "created";
		sort.dispatchEvent(new Event("change", { bubbles: true }));
		await app.updateComplete;
		expect([...app.shadowRoot?.querySelectorAll<HTMLElement>('[data-pane="master"] [data-initiative]') ?? []].map((card) => card.dataset.initiative)).toEqual(["INIT1", "INIT2"]);

		sort.value = "title";
		sort.dispatchEvent(new Event("change", { bubbles: true }));
		await app.updateComplete;
		expect([...app.shadowRoot?.querySelectorAll<HTMLElement>('[data-pane="master"] [data-initiative]') ?? []].map((card) => card.dataset.initiative)).toEqual(["INIT2", "INIT1"]);
	});

	it("groups initiatives beneath their owning epic", async () => {
		const discovery = makeProjectDiscovery([
			{
				completedInitiativeCount: 0,
				epicCount: 2,
				initiativeCount: 2,
				project: makeEntity({ id: "PROJ1", kind: "project", status: "active", title: "Console Viewer" })
			}
		]);
		const platformEpic = makeEntity({ id: "EPIC1", kind: "epic", status: "active", title: "Platform" });
		const deliveryEpic = makeEntity({ id: "EPIC2", kind: "epic", status: "active", title: "Delivery" });
		const platformInitiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const deliveryInitiative = makeEntity({ id: "INIT2", title: "Search" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				entities: [platformEpic, deliveryEpic, platformInitiative, deliveryInitiative],
				initiatives: [makeBundle(platformInitiative), makeBundle(deliveryInitiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC1", toId: "INIT1", type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC2", toId: "INIT2", type: "contains" }
				]
			})
		);
		store.projectDiscovery.set(discovery);
		const app = await mountApp(store);

		const platformSection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC1"]');
		const deliverySection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC2"]');
		expect(platformSection?.querySelector('[data-initiative="INIT1"]')).not.toBeNull();
		expect(platformSection?.querySelector('[data-initiative="INIT2"]')).toBeNull();
		expect(deliverySection?.querySelector('[data-initiative="INIT2"]')).not.toBeNull();
		expect(deliverySection?.querySelector('[data-initiative="INIT1"]')).toBeNull();
	});

	it("shows epic rollups, names the default epic, and collapses its initiative list", async () => {
		const completedInitiative = makeEntity({ id: "INIT1", status: "done", title: "Closed work" });
		const openInitiative = makeEntity({ id: "INIT2", title: "Open work" });
		const defaultEpic = makeEntity({ id: "EPIC0", kind: "epic", status: "active", title: "Default Epic" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				entities: [defaultEpic, completedInitiative, openInitiative],
				initiatives: [makeBundle(completedInitiative), makeBundle(openInitiative)],
				relations: [
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC0", toId: "INIT1", type: "contains" },
					{ createdAt: "2026-01-01T00:00:00.000Z", fromId: "EPIC0", toId: "INIT2", type: "contains" }
				]
			})
		);
		const app = await mountApp(store);

		const epicSection = app.shadowRoot?.querySelector<HTMLElement>('[data-epic="EPIC0"]');
		const toggle = epicSection?.querySelector<HTMLButtonElement>('[data-epic-toggle="EPIC0"]');
		expect(epicSection?.textContent).toContain("Uncategorized work");
		expect(epicSection?.textContent).toContain("2 initiatives");
		expect(epicSection?.textContent).toContain("1/2 completed");
		expect(epicSection?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");

		toggle?.click();
		await app.updateComplete;

		expect(epicSection?.querySelector('[data-initiative]')).toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	});

	it("opens the selected initiative in the detail pane while keeping the rail and master list", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]');
		masterItem?.click();
		await app.updateComplete;

		const root = app.shadowRoot;
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(root?.querySelector('[data-pane="detail"] agent-issues-initiative-detail-view')).not.toBeNull();
		expect(root?.querySelector('[data-pane="rail"] [data-tenant]')).not.toBeNull();
		expect(root?.querySelector('[data-pane="master"] [data-initiative]')).not.toBeNull();
	});

	it("keeps the detail pane fixed when an initiative is selected", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [makeBundle(initiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const masterItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]');
		masterItem?.click();
		await app.updateComplete;

		expect(app.shadowRoot?.querySelectorAll('[data-pane="detail"]').length).toBe(1);
	});

	it("replaces the right panel when a linked record is selected", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const story = makeEntity({ id: "US1", kind: "userStory", status: "ready", title: "Drill the lineage" });
		const snapshot = makeSnapshot({
			entities: [initiative, story],
			initiatives: [makeBundle(initiative, { userStories: [story] })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="master"] [data-initiative="INIT1"]')?.click();
		await app.updateComplete;

		store.selectEntity(story.id);
		await app.updateComplete;

		expect(store.selectedId.get()).toBe("US1");
		expect(app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-detail-view')).not.toBeNull();
	});

	it("switches the active project when a rail item is clicked", async () => {
		const config = makeConfig({
			availableTenants: [
				{ displayName: "Demo", id: "demo" },
				{ displayName: "Content Hub", id: "content-hub" }
			],
			currentTenant: "demo"
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ kind: "available", projects: [] }), { status: 200 })
		);
		const store = makeStore(config, makeSnapshot());
		const app = await mountApp(store);

		const railItem = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="rail"] [data-tenant="content-hub"]');
		railItem?.click();
		await app.updateComplete;

		expect(store.selectedTenant.get()).toBe("content-hub");
		expect(store.selectedProjectId.get()).toBeNull();
		expect(app.shadowRoot?.querySelector('[data-view="project-chooser"]')).not.toBeNull();
		fetchMock.mockRestore();
	});

	it("offers Initiatives, ADRs, Debt records, Context, and Graph navigation in the rail", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const sections = [...(app.shadowRoot?.querySelectorAll('[data-pane="rail"] [data-section]') ?? [])].map(
			(element) => element.getAttribute("data-section")
		);
		expect(sections).toEqual(["initiatives", "adrs", "debt", "context", "graph"]);
	});

	it("lists open debt by default and combines its metadata filters", async () => {
		const matchingDebt = makeEntity({ category: "technical", id: "DEBT1", kind: "debt", priority: "high", status: "open", title: "Replace legacy storage" });
		const categoryMismatch = makeEntity({ category: "process", id: "DEBT2", kind: "debt", priority: "high", status: "open", title: "Automate the release checklist" });
		const resolvedDebt = makeEntity({ category: "technical", id: "DEBT3", kind: "debt", priority: "high", status: "resolved", title: "Remove temporary endpoint" });
		const store = makeStore(makeConfig(), makeSnapshot({ entities: [matchingDebt, categoryMismatch, resolvedDebt] }));
		const app = await mountApp(store);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-section="debt"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? []].map((element) => element.getAttribute("data-id"))).toEqual(["DEBT1", "DEBT2"]);
		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-debt-filter="category"][data-debt-value="technical"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? []].map((element) => element.getAttribute("data-id"))).toEqual(["DEBT1"]);
	});

	it("lists architecture decisions in the master list when the ADRs section is active", async () => {
		const snapshot = makeSnapshot({
			projectAdrs: [
				makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use cytoscape" }),
				makeEntity({ id: "ADR2", kind: "adr", status: "archived", title: "Adopt signals" })
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		const adrNav = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-pane="rail"] [data-section="adrs"]');
		adrNav?.click();
		await app.updateComplete;

		const adrCards = [...(app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? [])].map(
			(element) => element.getAttribute("data-id")
		);
		expect(adrCards).toEqual(["ADR1", "ADR2"]);
		expect([...app.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-master-section="adrs"]') ?? []].map((button) => button.textContent?.trim())).toEqual([
			"All",
			"Archived",
			"Current"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-master-section="adrs"][data-master-status="archived"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-id]') ?? []].map((element) => element.getAttribute("data-id"))).toEqual(["ADR2"]);
	});

	it("filters initiatives in the master list by status", async () => {
		const doneInitiative = makeEntity({ id: "INIT_DONE", kind: "initiative", status: "done", title: "Completed work" });
		const activeInitiative = makeEntity({ id: "INIT_ACTIVE", kind: "initiative", status: "active", title: "Current work" });
		const snapshot = makeSnapshot({
			initiatives: [makeBundle(doneInitiative), makeBundle(activeInitiative)]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		expect([...app.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-master-section="initiatives"]') ?? []].map((button) => button.textContent?.trim())).toEqual([
			"All",
			"Active",
			"Done"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-master-section="initiatives"][data-master-status="done"]')?.click();
		await app.updateComplete;

		expect([...app.shadowRoot?.querySelectorAll('[data-pane="master"] [data-initiative]') ?? []].map((element) => element.getAttribute("data-initiative"))).toEqual(["INIT_DONE"]);
	});

	it("labels a project-scoped ADR as a project-level decision in the ADRs section", async () => {
		const snapshot = makeSnapshot({
			projectAdrs: [makeEntity({ id: "ADR1", kind: "adr", status: "current", title: "Use deterministic SVG" })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("adrs");
		await app.updateComplete;

		const card = app.shadowRoot?.querySelector('[data-pane="master"] [data-id="ADR1"]');
		expect(card?.getAttribute("data-scope")).toBe("project");
		expect(card?.querySelector(".m-meta")?.textContent).toContain("project decision");
	});

	it("labels an initiative-scoped ADR with its initiative in the ADRs section", async () => {
		const snapshot = makeSnapshot({
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					adrs: [makeEntity({ id: "ADR2", kind: "adr", status: "current", title: "Render graphs by hand" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("adrs");
		await app.updateComplete;

		const card = app.shadowRoot?.querySelector('[data-pane="master"] [data-id="ADR2"]');
		expect(card?.getAttribute("data-scope")).toBe("initiative");
		expect(card?.querySelector(".m-meta")?.textContent).toContain("initiative Console Viewer");
	});

	it("renders scoped initiative ADR and Context data without a snapshot", async () => {
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Payments" });
		const initiativeAdr = makeEntity({ id: "ADR2", kind: "adr", status: "current", title: "Use payment intents" });
		const shared = makeSharedContext();
		shared.context.exists = true;
		shared.terms = [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }];
		const initiativeContext = {
			context: {
				createdAt: null,
				exists: true,
				key: initiative.id,
				scopeEntityId: initiative.id,
				scopeKind: "initiative" as const,
				scopeLabel: initiative.title,
				summary: "Payments terms.",
				title: "Payments Context",
				updatedAt: null
			},
			terms: [{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" }]
		};
		const store = makeStore(makeConfig(), makeSnapshot({ initiatives: [makeBundle(initiative)] }));
		store.snapshot.set(null);
		store.projectAdrsCache.set({
			data: { initiativeAdrs: [{ adrs: [initiativeAdr], initiative }], projectAdrs: [] },
			error: null,
			loading: false
		});
		store.projectContextCache.set({
			data: {
				duplicateTerms: ["Order"],
				initiatives: [initiativeContext],
				shared,
				terms: [{
					hasConflictingDefinitions: true,
					hasDuplicates: true,
					hasSharedSource: true,
					sources: [
						{ ...shared.terms[0], contextKey: "shared", contextTitle: shared.context.title, scopeEntityId: null, scopeKind: "default", scopeLabel: "Shared" },
						{ ...initiativeContext.terms[0], contextKey: initiative.id, contextTitle: initiativeContext.context.title, scopeEntityId: initiative.id, scopeKind: "initiative", scopeLabel: initiative.title }
					],
					term: "Order"
				}]
			},
			error: null,
			loading: false
		});
		store.selectSection("adrs");
		const app = await mountApp(store);

		const adrCard = app.shadowRoot?.querySelector('[data-pane="master"] [data-id="ADR2"]');
		expect(adrCard?.getAttribute("data-scope")).toBe("initiative");
		expect(adrCard?.querySelector(".m-meta")?.textContent).toContain("initiative Payments");

		store.selectSection("context");
		await app.updateComplete;
		const contextText = app.shadowRoot?.textContent ?? "";
		expect(contextText).toContain("Payments");
		expect(contextText).toContain("conflicting definitions across 2 scopes");
	});

	it("renders KPI cards and overview/graph subtabs in the initiative detail", async () => {
		const initiative = makeEntity({ id: "INIT1", title: "Console Viewer" });
		const snapshot = makeSnapshot({
			entities: [initiative],
			initiatives: [
				makeBundle(initiative, {
					issues: [
						makeEntity({ id: "ISS1", kind: "issue", status: "done" }),
						makeEntity({ id: "ISS2", kind: "issue", status: "todo" })
					],
					userStories: [makeEntity({ id: "US1", kind: "story" })]
				})
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectInitiative("INIT1");
		await app.updateComplete;

		const initiativeView = app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-initiative-detail-view') as HTMLElement & { updateComplete: Promise<unknown> };
		await initiativeView?.updateComplete;
		const detail = initiativeView?.shadowRoot;

		const kpis = detail?.querySelectorAll(".kpi");
		const subtabs = [...(detail?.querySelectorAll(".subtab-label-text") ?? [])].map((element) => element.textContent?.trim());
		expect(kpis?.length).toBe(4);
		expect(subtabs).toEqual(["Overview", "Issues", "Graph", "User stories"]);
	});

	it("keeps the owning initiative highlighted in the master rail while one of its records is open", async () => {
		const story = makeEntity({ id: "US7", kind: "story", title: "Open any record" });
		const snapshot = makeSnapshot({
			entities: [makeEntity({ id: "INIT1", title: "Console Viewer" }), story],
			initiatives: [makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), { userStories: [story] })]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectEntity("US7");
		await app.updateComplete;

		const masterItem = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT1"]');
		expect(masterItem?.classList.contains("active")).toBe(true);
		expect(app.shadowRoot?.querySelector('[data-pane="detail"] agent-issues-detail-view')).not.toBeNull();
	});

	it("re-anchors the master rail to the target initiative when a cross-reference crosses initiatives", async () => {
		const storyA = makeEntity({ id: "US7", kind: "story", title: "Open any record" });
		const issueB = makeEntity({ id: "ISS9", kind: "issue", status: "done", title: "Wire the detail pane" });
		const snapshot = makeSnapshot({
			entities: [
				makeEntity({ id: "INIT1", title: "Console Viewer" }),
				makeEntity({ id: "INIT2", title: "Search" }),
				storyA,
				issueB
			],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), { userStories: [storyA] }),
				makeBundle(makeEntity({ id: "INIT2", title: "Search" }), { issues: [issueB] })
			]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectEntity("US7");
		await app.updateComplete;
		store.selectEntity("ISS9");
		await app.updateComplete;

		const anchoredInit1 = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT1"]');
		const anchoredInit2 = app.shadowRoot?.querySelector('[data-pane="master"] [data-initiative="INIT2"]');
		expect(anchoredInit1?.classList.contains("active")).toBe(false);
		expect(anchoredInit2?.classList.contains("active")).toBe(true);
	});
});

describe("collapse toggles", () => {
	it("collapses the rail when its collapse toggle is clicked", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-collapse="rail"]');
		toggle?.click();
		await app.updateComplete;

		expect(store.railCollapsed.get()).toBe(true);
		expect(app.shadowRoot?.querySelector(".console")?.classList.contains("rail-collapsed")).toBe(true);
	});

	it("collapses the master list when its collapse toggle is clicked", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		const app = await mountApp(store);

		const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-collapse="master"]');
		toggle?.click();
		await app.updateComplete;

		expect(store.masterCollapsed.get()).toBe(true);
		expect(app.shadowRoot?.querySelector(".console")?.classList.contains("master-collapsed")).toBe(true);
	});

});

describe("project relationship graph section", () => {
	it("renders project decisions and project-scoped epic hierarchy nodes only", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Render graph nodes" });
		const snapshot = makeSnapshot({
			entities: [epic],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					adrs: [makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" })],
					fixLinks: [{ issue, userStory: story }],
					issues: [issue],
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })],
					userStories: [story]
				})
			],
			projectAdrs: [projectAdr],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: "INIT1", type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graph).not.toBeNull();
		const nodes = graph?.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect([...nodes].map((node) => node.getAttribute("data-id")).sort()).toEqual(["", "ADR1", "ADR2", "EPIC1", "INIT1", "ISS1", "PRD1", "US1"]);
		const filters = app.shadowRoot?.querySelector("agent-issues-relationship-graph-filters");
		expect([...filters?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".graph-kind-chip") ?? []].map((chip) => chip.textContent?.trim())).toEqual([
			"Project",
			"Epic",
			"Initiative",
				"Plan",
			"PRD",
			"ADR",
			"User story",
			"Issue",
			"Debt"
		]);

		filters?.shadowRoot?.querySelector<HTMLButtonElement>('[data-graph-kind="issue"]')?.click();
		await app.updateComplete;

		const graphWithoutIssues = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		expect(graphWithoutIssues?.shadowRoot?.querySelector('.ai-node[data-id="ISS1"]')).toBeNull();
		expect([...graphWithoutIssues?.shadowRoot?.querySelectorAll<SVGTextElement>(".ai-colhead") ?? []].map((node) => node.textContent?.trim())).not.toContain("Issues");
	});

	it("opens graph nodes while preserving the selected tenant and project route", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const projectAdr = makeEntity({ id: "ADR2", kind: "adr", title: "Use project snapshots" });
		const snapshot = makeSnapshot({
			entities: [epic, makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })],
			initiatives: [
				makeBundle(makeEntity({ id: "INIT1", title: "Console Viewer" }), {
					prds: [makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" })]
				})
			],
			projectAdrs: [projectAdr],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: "INIT1", type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		store.selectSection("graph");
		await app.updateComplete;

		const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const initiativeNode = graph?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="INIT1"]');
		initiativeNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedInitiativeId.get()).toBe("INIT1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("initiative=INIT1");

		store.selectSection("graph");
		await app.updateComplete;
		const graphAgain = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const prdNode = graphAgain?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="PRD1"]');
		prdNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await app.updateComplete;
		expect(store.selectedId.get()).toBe("PRD1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=PRD1");
		expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();

		store.selectSection("graph");
		await app.updateComplete;
		const graphWithProjectAdr = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const projectAdrNode = graphWithProjectAdr?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ADR2"]');
		projectAdrNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		await app.updateComplete;
		expect(store.selectedId.get()).toBe("ADR2");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=ADR2");
		expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();

		store.selectSection("graph");
		await app.updateComplete;
		const graphWithEpic = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
		const epicNode = graphWithEpic?.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="EPIC1"]');
		epicNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
		expect(store.selectedId.get()).toBe("EPIC1");
		expect(window.location.hash).toContain("tenant=demo");
		expect(window.location.hash).toContain("project=PROJ1");
		expect(window.location.hash).toContain("entity=EPIC1");
	});

	it("opens bundle-only project graph records", async () => {
		const epic = makeEntity({ id: "EPIC1", kind: "epic", title: "Viewer experience" });
		const initiative = makeEntity({ id: "INIT1", kind: "initiative", title: "Console Viewer" });
		const prd = makeEntity({ id: "PRD1", kind: "prd", title: "Console PRD" });
		const adr = makeEntity({ id: "ADR1", kind: "adr", title: "Use SVG" });
		const story = makeEntity({ id: "US1", kind: "userStory", title: "Explore the graph" });
		const issue = makeEntity({ id: "ISS1", kind: "issue", title: "Render nodes" });
		const snapshot = makeSnapshot({
			entities: [epic],
			initiatives: [makeBundle(initiative, { adrs: [adr], issues: [issue], prds: [prd], userStories: [story] })],
			relations: [{ createdAt: "2026-01-01T00:00:00.000Z", fromId: epic.id, toId: initiative.id, type: "contains" }]
		});
		const store = makeStore(makeConfig(), snapshot);
		const app = await mountApp(store);

		for (const entityId of [prd.id, adr.id, story.id, issue.id]) {
			store.selectSection("graph");
			await app.updateComplete;
			const graph = app.shadowRoot?.querySelector("agent-issues-relationship-graph");
			const node = graph?.shadowRoot?.querySelector<SVGGElement>(`.ai-node[data-id="${entityId}"]`);
			node?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
			await app.updateComplete;

			expect(store.selectedEntity.get()?.id).toBe(entityId);
			expect(window.location.hash).toContain(`entity=${entityId}`);
			expect(app.shadowRoot?.querySelector("agent-issues-detail-view")).not.toBeNull();
		}
	});
});

describe("project context section", () => {
	it("does not show a provisional context title while direct-route context loads", async () => {
		const store = makeStore(makeConfig(), makeSnapshot());
		store.snapshot.set(null);
		store.projectContextCache.set({ data: null, error: null, loading: true });
		store.activeSection.set("context");
		const app = await mountApp(store);

		expect(app.shadowRoot?.querySelector(".d-title")?.textContent).toBe("Loading context");
		expect(app.shadowRoot?.textContent).not.toContain("Project context");

		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		store.projectContextCache.set({
			data: { duplicateTerms: [], initiatives: [], shared, terms: [] },
			error: null,
			loading: false
		});
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".d-title")?.textContent).toBe("Content Hub");
	});

	it("shows the shared term count on the Context nav item", async () => {
		const shared = makeSharedContext();
		shared.context.summary = "Project glossary.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "An issue.", term: "Issue", updatedAt: "" }];
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		const app = await mountApp(store);

		const contextNav = app.shadowRoot?.querySelector<HTMLElement>('[data-section="context"]');
		expect(contextNav).not.toBeNull();
		expect(contextNav?.querySelector(".nav-count")?.textContent).toBe("1");
	});

	it("renders the shared context summary and glossary in the detail pane", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: ["settings"], createdAt: "", definition: "Privileged product area.", term: "Administration", updatedAt: "" }];
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const contextView = app.shadowRoot?.querySelector("agent-issues-context-view");
		expect(contextView).not.toBeNull();
		const text = contextView?.shadowRoot?.textContent ?? "";
		expect(text).toContain("Shared language for the whole project.");
		expect(text).toContain("Administration");
		expect(text).toContain("Privileged product area.");
		expect(text).toContain("settings");
	});

	it("focuses and highlights a deep-linked shared context summary", async () => {
		const shared = makeSharedContext();
		shared.context.exists = true;
		shared.context.summary = "Shared search language.";
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		store.openSearchTarget({ type: "context" });

		const app = await mountApp(store);

		const target = app.shadowRoot?.querySelector<HTMLElement>('[data-context-scope="shared"]');
		expect(target?.classList.contains("is-context-target")).toBe(true);
		expect(app.shadowRoot?.activeElement).toBe(target);
	});

	it("focuses and highlights a deep-linked shared context term", async () => {
		const shared = makeSharedContext();
		shared.context.exists = true;
		shared.terms = [{ avoid: [], createdAt: "", definition: "Searchable content.", term: "Search document", updatedAt: "" }];
		const store = makeStore(makeConfig(), makeSnapshot({ contexts: { initiatives: [], shared } }));
		store.openSearchTarget({ type: "context-term", term: "Search document" });

		const app = await mountApp(store);

		const target = app.shadowRoot?.querySelector<HTMLElement>("agent-issues-context-view")?.shadowRoot?.querySelector<HTMLElement>('[data-term="Search document"]');
		expect(target?.classList.contains("is-context-term-target")).toBe(true);
		expect(app.shadowRoot?.querySelector("agent-issues-context-view")?.shadowRoot?.activeElement).toBe(target);
	});

	it("renders initiative-scoped discovery and duplicate warnings in the detail pane", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "Canonical order.", term: "Order", updatedAt: "" }];
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT2",
								scopeEntityId: "INIT2",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [
								{ avoid: [], createdAt: "", definition: "Payment-specific order.", term: "Order", updatedAt: "" },
								{ avoid: ["queued run"], createdAt: "", definition: "A captured payment.", term: "Settlement", updatedAt: "" }
							]
						}
					]
				}
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const text = app.shadowRoot?.textContent ?? "";
		expect(text).toContain("Initiative term index");
		expect(text).toContain("Payments");
		expect(text).toContain("Settlement");
		expect(text).toContain("conflicting definitions across 2 scopes");
		expect(text).toContain("queued run");
	});

	it("uses one search bar across context tabs and scopes the results to the active tab", async () => {
		const shared = makeSharedContext();
		shared.context.title = "Content Hub";
		shared.context.summary = "Shared language for the whole project.";
		shared.terms = [{ avoid: [], createdAt: "", definition: "Privileged product area.", term: "Administration", updatedAt: "" }];
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT2",
								scopeEntityId: "INIT2",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }]
						}
					]
				}
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;

		const initiativesTab = app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="initiatives"]');
		initiativesTab?.click();
		await app.updateComplete;

		const search = app.shadowRoot?.querySelector<HTMLInputElement>('.ctx-controls .master-search');
		expect(search?.placeholder).toBe("Search initiative terminology…");
		if (search) {
			search.value = "Settlement";
			search.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		}
		await app.updateComplete;

		const initiativeText = app.shadowRoot?.textContent ?? "";
		expect(initiativeText).toContain("Settlement");
		expect(app.shadowRoot?.querySelector("agent-issues-context-view")).toBeNull();

		const globalTab = app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="global"]');
		globalTab?.click();
		await app.updateComplete;

		const globalSearch = app.shadowRoot?.querySelector<HTMLInputElement>('.ctx-controls .master-search');
		expect(globalSearch?.placeholder).toBe("Search shared context…");
		const contextView = app.shadowRoot?.querySelector("agent-issues-context-view");
		expect(contextView).not.toBeNull();
		const globalText = contextView?.shadowRoot?.textContent ?? "";
		expect(globalText).toContain("No shared context matches the current search.");
	});

	it("filters the Initiatives context tab to a selected initiative", async () => {
		const shared = makeSharedContext();
		const analytics = makeEntity({ id: "INIT_ANALYTICS", kind: "initiative", status: "draft", title: "Analytics" });
		const payments = makeEntity({ id: "INIT_PAYMENTS", kind: "initiative", status: "active", title: "Payments" });
		const shipping = makeEntity({ id: "INIT_SHIPPING", kind: "initiative", status: "active", title: "Shipping" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT_PAYMENTS",
								scopeEntityId: "INIT_PAYMENTS",
								scopeKind: "initiative",
								scopeLabel: "Payments",
								summary: "Payments terms.",
								title: "Payments Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }]
						},
						{
							context: {
								createdAt: null,
								exists: true,
								key: "INIT_SHIPPING",
								scopeEntityId: "INIT_SHIPPING",
								scopeKind: "initiative",
								scopeLabel: "Shipping",
								summary: "Shipping terms.",
								title: "Shipping Context",
								updatedAt: null
							},
							terms: [{ avoid: [], createdAt: "", definition: "A grouped dispatch.", term: "Shipment batch", updatedAt: "" }]
						}
					]
				},
				initiatives: [makeBundle(analytics), makeBundle(payments), makeBundle(shipping)]
			})
		);
		const app = await mountApp(store);

		store.selectSection("context");
		await app.updateComplete;
		app.shadowRoot?.querySelector<HTMLElement>('[data-context-tab="initiatives"]')?.click();
		await app.updateComplete;

		const initiativeTabs = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".ctx-initiative-tab") ?? [])];
		expect(initiativeTabs.map((tab) => tab.textContent?.trim())).toEqual([
			"All initiatives",
			"Analytics",
			"Payments",
			"Shipping"
		]);

		app.shadowRoot?.querySelector<HTMLButtonElement>('[data-context-initiative="INIT_SHIPPING"]')?.click();
		await app.updateComplete;

		const filteredText = app.shadowRoot?.querySelector(".ctx-block")?.textContent ?? "";
		expect(filteredText).toContain("Shipment batch");
		expect(filteredText).not.toContain("Settlement");
	});

	it("focuses and highlights a deep-linked scoped context term", async () => {
		const shared = makeSharedContext();
		const initiative = makeEntity({ id: "INIT_PAYMENTS", kind: "initiative", status: "active", title: "Payments" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [{
						context: {
							createdAt: null,
							exists: true,
							key: initiative.id,
							scopeEntityId: initiative.id,
							scopeKind: "initiative",
							scopeLabel: initiative.title,
							summary: "Payments terms.",
							title: "Payments Context",
							updatedAt: null
						},
						terms: [{ avoid: [], createdAt: "", definition: "Captured funds.", term: "Settlement", updatedAt: "" }]
					}]
				},
				initiatives: [makeBundle(initiative)]
			})
		);
		store.openSearchTarget({ type: "context-term", scopeRef: initiative.id, term: "Settlement" });

		const app = await mountApp(store);

		const target = app.shadowRoot?.querySelector<HTMLElement>('[data-term="Settlement"]');
		expect(target?.classList.contains("is-context-term-target")).toBe(true);
		expect(app.shadowRoot?.activeElement).toBe(target);

		store.selectSection("context");
		await app.updateComplete;

		const clearedTarget = app.shadowRoot?.querySelector<HTMLElement>('[data-term="Settlement"]');
		expect(clearedTarget?.classList.contains("is-context-term-target")).toBe(false);
	});

	it("focuses and highlights a deep-linked initiative context summary", async () => {
		const shared = makeSharedContext();
		const initiative = makeEntity({ id: "INIT_PAYMENTS", kind: "initiative", status: "active", title: "Payments" });
		const store = makeStore(
			makeConfig(),
			makeSnapshot({
				contexts: {
					shared,
					initiatives: [{
						context: {
							createdAt: null,
							exists: true,
							key: initiative.id,
							scopeEntityId: initiative.id,
							scopeKind: "initiative",
							scopeLabel: initiative.title,
							summary: "Payments search language.",
							title: "Payments Context",
							updatedAt: null
						},
						terms: []
					}]
				},
				initiatives: [makeBundle(initiative)]
			})
		);
		store.openSearchTarget({ type: "context", scopeRef: initiative.id });

		const app = await mountApp(store);

		const target = app.shadowRoot?.querySelector<HTMLElement>(`[data-context-scope="${initiative.id}"]`);
		expect(target?.classList.contains("is-context-target")).toBe(true);
		expect(app.shadowRoot?.activeElement).toBe(target);
	});
});

