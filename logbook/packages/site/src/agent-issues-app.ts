import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import { BookOpen, LayoutGrid, createElement } from "lucide";
import { choose } from "lit/directives/choose.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import "./components/context-view.js";
import "./components/global-search-overlay.js";
import "./components/initiative-detail-view.js";
import "./components/issue-detail-view.js";
import "./components/instructions-view.js";
import "./components/relationship-graph.js";
import "./components/relationship-graph-filters.js";
import type { GlobalSearchOpenTargetDetail } from "./components/global-search-overlay.js";
import type { AdrRailEntry, ConsoleSection, ContextDetails, ContextPageTab, DebtFilter, Entity, EpicInitiativeGroup, InitiativeBundle, InitiativeRollup, InitiativeSortCriterion, ProjectContextTermEntry, ProjectContextTermSource, ProjectGraphKind, ProjectRollup, ProjectSummaryEpicGroup } from "./models.js";
import { AgentIssuesStore } from "./services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTypographyStyles } from "./styles/issue-browser-shared-styles.js";

const SWITCHER_MENU_ID = "tenant-switcher-menu";
const THEME_STORAGE_KEY = "agent-issues-theme";

type SiteTheme = "light" | "dark";

class AgentIssuesApp extends SignalWatcher(LitElement) {
	public store = new AgentIssuesStore();
	protected medium = false;
	protected narrow = false;
	protected mobileMasterOpen = false;
	protected theme: SiteTheme = "light";
	protected globalSearchTrigger: HTMLElement | null = null;
	protected instructionsIcon = createElement(BookOpen, { width: 18, height: 18, "aria-hidden": "true" });
	protected projectsIcon = createElement(LayoutGrid, { width: 18, height: 18, "aria-hidden": "true" });

	protected onSelectTenant = (event: Event) => {
		const tenantId = (event.currentTarget as HTMLElement).dataset.tenant;
		if (!tenantId) {
			return;
		}

		void this.store.selectTenant(tenantId);
	};

	protected onSelectSection = (event: Event) => {
		const section = (event.currentTarget as HTMLElement).dataset.section as ConsoleSection | undefined;
		if (!section) {
			return;
		}

		this.store.selectSection(section);
		this.mobileMasterOpen = false;
		this.requestUpdate();
	};

	protected onSelectInitiative = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.initiative;
		if (!initiativeId) {
			return;
		}

		this.store.selectInitiative(initiativeId);
		this.mobileMasterOpen = false;
		this.requestUpdate();
	};

	protected onSelectProject = (event: Event) => {
		const projectId = (event.currentTarget as HTMLElement).dataset.project;
		if (!projectId) {
			return;
		}

		void this.store.selectProject(projectId);
	};

	protected onOpenProjectChooser = () => {
		void this.store.returnToProjectChooser();
	};

	protected onOpenInstructions = () => {
		void this.store.openInstructions();
	};

	protected renderPersonalNavigation() {
		return html`
		<div class="nav-group-label">Personal</div>
		<button
			aria-pressed=${String(this.store.activePage.get() === "instructions")}
			class=${classMap({ "nav-item": true, active: this.store.activePage.get() === "instructions" })}
			data-open-instructions
			title="Instructions"
			@click=${this.onOpenInstructions}
		>
			<span class="nav-icon">${this.instructionsIcon}</span>
			<span class="nav-label">Instructions</span>
		</button>
		`;
	}

	protected onSelectEntity = (event: Event) => {
		const entityId = (event.currentTarget as HTMLElement).dataset.id;
		if (!entityId) {
			return;
		}

		this.store.selectEntity(entityId);
		this.mobileMasterOpen = false;
		this.requestUpdate();
	};

	protected onSearchInput = (event: Event) => {
		this.store.search.set((event.target as HTMLInputElement).value);
	};

	protected onOpenGlobalSearch = (event: Event) => {
		this.globalSearchTrigger = event.currentTarget as HTMLElement;
		this.store.openGlobalSearch();
	};

	protected onCloseGlobalSearch = () => {
		this.store.closeGlobalSearch();
		this.globalSearchTrigger?.focus();
	};

	protected onOpenGlobalSearchTarget = async (event: Event) => {
		const { projectId, target } = (event as CustomEvent<GlobalSearchOpenTargetDetail>).detail;
		if (await this.store.openSearchTarget(target, projectId)) {
			this.onCloseGlobalSearch();
		}
	};

	protected onRetryGlobalSearch = () => {
		void this.store.retryGlobalSearch();
	};

	protected onRetryProjectSection = (event: Event) => {
		const section = (event.currentTarget as HTMLElement).dataset.section as ConsoleSection | undefined;
		if (section === "adrs") {
			void this.store.retryProjectAdrs();
		} else if (section === "debt") {
			void this.store.retryProjectDebt();
		} else if (section === "context") {
			void this.store.retryProjectContext();
		} else if (section === "graph") {
			void this.store.retryProjectGraph();
		}
	};

	protected onWindowKeyDown = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		if (
			event.key.toLowerCase() !== "k" ||
			(!event.metaKey && !event.ctrlKey) ||
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target?.isContentEditable
		) {
			return;
		}

		event.preventDefault();
		this.globalSearchTrigger = document.activeElement instanceof HTMLElement
			? document.activeElement
			: this.shadowRoot?.querySelector<HTMLElement>("[data-global-search-trigger]") ?? null;
		this.store.openGlobalSearch();
	};

	protected onToggleRail = () => {
		this.store.toggleRail();
	};

	protected onToggleMaster = () => {
		this.store.toggleMaster();
	};

	protected onToggleMobileMaster = async () => {
		this.mobileMasterOpen = !this.mobileMasterOpen;
		this.requestUpdate();
		if (this.mobileMasterOpen) {
			await this.updateComplete;
			this.shadowRoot?.querySelector<HTMLInputElement>(".master-search")?.focus();
		}
	};

	protected onToggleTheme = () => {
		const theme: SiteTheme = this.theme === "light" ? "dark" : "light";
		this.setTheme(theme, true);
	};

	protected onToggleEpic = (event: Event) => {
		const epicId = (event.currentTarget as HTMLElement).dataset.epicToggle;
		if (!epicId) {
			return;
		}

		this.store.toggleEpicExpanded(epicId);
	};

	protected onContextSearchInput = (event: Event) => {
		this.store.contextSearch.set((event.target as HTMLInputElement).value);
	};

	protected onSetContextTab = (event: Event) => {
		const tab = (event.currentTarget as HTMLElement).dataset.contextTab as ContextPageTab | undefined;
		if (!tab) {
			return;
		}

		this.store.setContextTab(tab);
	};

	protected onSetContextInitiativeFilter = (event: Event) => {
		const initiativeId = (event.currentTarget as HTMLElement).dataset.contextInitiative ?? "";
		this.store.setContextInitiativeFilter(initiativeId || null);
	};

	protected onSetMasterStatusFilter = (event: Event) => {
		const target = event.currentTarget as HTMLElement;
		const section = target.dataset.masterSection;
		const status = target.dataset.masterStatus;
		if ((section !== "initiatives" && section !== "adrs") || !status) {
			return;
		}

		this.store.setMasterStatusFilter(section, status);
	};

	protected onSetInitiativeSort = (event: Event) => {
		this.store.setInitiativeSort((event.currentTarget as HTMLSelectElement).value as InitiativeSortCriterion);
	};

	protected onSetDebtFilter = (event: Event) => {
		const target = event.currentTarget as HTMLElement;
		const filter = target.dataset.debtFilter as DebtFilter | undefined;
		const value = target.dataset.debtValue;
		if (!filter || !value) {
			return;
		}

		this.store.setDebtFilter(filter, value);
	};

	protected onToggleProjectGraphKind = (event: Event) => {
		const kind = (event as CustomEvent<{ kind: ProjectGraphKind }>).detail.kind;
		if (!kind) {
			return;
		}

		this.store.toggleProjectGraphKind(kind);
	};

	protected toAriaBoolean(value: boolean): "true" | "false" {
		return value ? "true" : "false";
	}

	protected formatStatusFilter(status: string): string {
		if (status === "all") {
			return "All";
		}

		return status.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
	}

	protected sortInitiatives(rollups: InitiativeRollup[], criterion: InitiativeSortCriterion): InitiativeRollup[] {
		return [...rollups].sort((left, right) => {
			if (criterion === "title") {
				return left.initiative.title.localeCompare(right.initiative.title) || left.initiative.id.localeCompare(right.initiative.id);
			}

			const field = criterion === "created" ? "createdAt" : "updatedAt";
			const dateComparison = new Date(right.initiative[field]).getTime() - new Date(left.initiative[field]).getTime();
			return dateComparison || left.initiative.id.localeCompare(right.initiative.id);
		});
	}

	protected onProjectNodeOpen = (event: Event) => {
		const { id, kind } = (event as CustomEvent<{ id: string; kind: string }>).detail;
		if (!id) {
			return;
		}

		if (kind === "initiative") {
			this.store.selectInitiative(id);
			return;
		}

		this.store.selectProjectGraphEntity(id, kind);
	};

	protected focusContextTarget() {
		for (const element of this.renderRoot.querySelectorAll<HTMLElement>(".is-context-target, .is-context-term-target")) {
			element.classList.remove("is-context-target", "is-context-term-target");
		}

		const target = this.store.selectedNestedTarget.get();
		if (!target || (target.type !== "context" && target.type !== "context-term")) {
			return;
		}

		const element = target.type === "context"
			? [...this.renderRoot.querySelectorAll<HTMLElement>(".ctx-context-summary")]
				.find((candidate) => candidate.dataset.contextScope === (target.scopeRef ?? "shared"))
			: [...this.renderRoot.querySelectorAll<HTMLElement>(".ctx-term")]
				.find((candidate) => candidate.dataset.term === target.id);
		if (!element) {
			return;
		}

		const targetClass = target.type === "context" ? "is-context-target" : "is-context-term-target";
		element.classList.remove(targetClass);
		void element.offsetWidth;
		element.classList.add(targetClass);
		element.focus({ preventScroll: true });
		if (typeof element.scrollIntoView === "function") {
			element.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}

	protected override updated() {
		this.focusContextTarget();
	}

	connectedCallback(): void {
		super.connectedCallback();
		const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
		this.setTheme(storedTheme === "dark" ? "dark" : "light");
		this.updateNarrowMode();
		window.addEventListener("resize", this.updateNarrowMode);
		window.addEventListener("keydown", this.onWindowKeyDown);
		this.store.connect();
	}

	disconnectedCallback(): void {
		window.removeEventListener("resize", this.updateNarrowMode);
		window.removeEventListener("keydown", this.onWindowKeyDown);
		this.store.disconnect();
		super.disconnectedCallback();
	}

	protected updateNarrowMode = () => {
		const narrow = window.innerWidth <= 900;
		const medium = !narrow && window.innerWidth <= 1200;
		if (this.narrow === narrow && this.medium === medium) {
			return;
		}

		this.narrow = narrow;
		this.medium = medium;
		if (!narrow) {
			this.mobileMasterOpen = false;
		}
		this.requestUpdate();
	};

	protected setTheme(theme: SiteTheme, persist = false) {
		this.theme = theme;
		document.documentElement.dataset.theme = theme;
		if (persist) {
			window.localStorage.setItem(THEME_STORAGE_KEY, theme);
		}
		this.requestUpdate();
	}

	protected renderThemeToggle(placement: "header" | "rail") {
		const nextTheme = this.theme === "light" ? "dark" : "light";
		const icon = this.theme === "light" ? "☾" : "☼";

		return html`
		<button
			aria-label=${`Switch to ${nextTheme} theme`}
			aria-pressed=${this.toAriaBoolean(this.theme === "dark")}
			class=${`theme-toggle ${placement}-theme-toggle`}
			data-theme-toggle=${placement}
			title=${`Switch to ${nextTheme} theme`}
			@click=${this.onToggleTheme}
			type="button"
		>
			${icon}
		</button>
		`;
	}

	protected renderSwitcherMenu() {
		const tenantOptions = this.store.tenantOptions.get();
		const selectedTenant = this.store.selectedTenant.get();

		return html`
		<div
			class="menu"
			id=${SWITCHER_MENU_ID}
			popover=${"auto"}
		>
			${repeat(
				tenantOptions,
				(tenant) => tenant.id,
				(tenant) => html`
				<button
					class="menu-item"
					data-tenant=${tenant.id}
					popovertarget=${SWITCHER_MENU_ID}
					popovertargetaction="hide"
					@click=${this.onSelectTenant}
				>
					<span class="check">${when(tenant.id === selectedTenant, () => html`✓`, () => nothing)}</span>
					<span class="avatar small">${tenant.displayName.charAt(0)}</span>
					<span class="sw-text">
						<span class="sw-name">${tenant.displayName}</span>
						<span class="sw-sub">${when(tenant.id === selectedTenant, () => html`current project`, () => html`open project`)}</span>
					</span>
				</button>
				`
			)}
		</div>
		`;
	}

	protected renderRail() {
		const store = this.store;
		const projectName = store.selectedProjectDisplayName.get() ?? "Project";
		const section = store.activeSection.get();
		const navItems: Array<{ count: string; icon: string; label: string; section: ConsoleSection }> = [
			{ count: String(store.projectSummaryInitiatives.get().length), icon: "📁", label: "Initiatives", section: "initiatives" },
			{ count: String(store.adrRailEntries.get().length), icon: "📐", label: "ADRs", section: "adrs" },
			{ count: String(store.debtRecords.get().length), icon: "◒", label: "Debt records", section: "debt" },
			{ count: String(store.projectContextTerms.get().length), icon: "📖", label: "Context", section: "context" },
			{ count: "map", icon: "🕸️", label: "Graph", section: "graph" }
		];

		return html`
		<aside class="rail" data-pane="rail">
			<button
				aria-label=${this.mobileMasterOpen ? "Close record list" : "Open record list"}
				aria-pressed=${this.toAriaBoolean(this.mobileMasterOpen)}
				class="mobile-master-toggle"
				@click=${this.onToggleMobileMaster}
				type="button"
			>
				☰
			</button>
			<button
				class="pane-collapse"
				data-collapse="rail"
				title=${store.railCollapsed.get() ? "Expand rail" : "Collapse rail"}
				@click=${this.onToggleRail}
			>
				${store.railCollapsed.get() ? "»" : "«"}
			</button>
			<div class="rail-switcher">
				<div class="switcher-actions">
					<button
						class="switcher-button"
						@click=${this.onOpenProjectChooser}
					>
						<span class="avatar">${projectName.charAt(0)}</span>
						<span class="sw-text">
							<span class="sw-name">${projectName}</span>
							<span class="sw-sub">Switch project</span>
						</span>
					</button>
					<button
						aria-label="Switch tenant"
						class="switcher-tenant-button"
						popovertarget=${SWITCHER_MENU_ID}
					>
						⇅
					</button>
				</div>
				${this.renderSwitcherMenu()}
			</div>
			${when(
				!this.narrow,
				() => html`
				<button
					aria-label="Open global search"
					class="global-search-trigger"
					data-global-search-trigger
					@click=${this.onOpenGlobalSearch}
					type="button"
				>
					<span>Search records</span>
					<kbd>⌘ K</kbd>
				</button>
				`,
				() => html`
				<button
					aria-label="Open global search"
					class="global-search-icon-trigger"
					data-global-search-trigger
					@click=${this.onOpenGlobalSearch}
					type="button"
				>
					⌕
				</button>
				`
			)}
			<nav class="rail-nav">
				${this.renderPersonalNavigation()}
				<div class="nav-group-label">Plan</div>
				${map(
					navItems,
					(item) => html`
					<button
						class=${classMap({ active: section === item.section, "nav-item": true })}
						data-section=${item.section}
						data-tenant-nav=${item.section}
						title=${item.label}
						@click=${this.onSelectSection}
					>
						<span class="nav-icon">${item.icon}</span>
						<span class="nav-label">${item.label}</span>
						<span class="nav-count">${item.count}</span>
					</button>
					`
				)}
				<div class="nav-group-label totals">Totals</div>
				<div class="nav-item static">
					<span class="nav-icon">📝</span>
					<span class="nav-label">User stories</span>
					<span class="nav-count">${store.projectStoryCount.get()}</span>
				</div>
				<div class="nav-item static">
					<span class="nav-icon">⊙</span>
					<span class="nav-label">Issues</span>
					<span class="nav-count">${store.projectIssueCount.get()}</span>
				</div>
			</nav>
			<div class="rail-foot">
				<span class="rail-foot-copy">${store.projectDescription.get()}</span>
				${when(!this.narrow && !this.medium, () => this.renderThemeToggle("rail"), () => nothing)}
			</div>
			${when(this.narrow || this.medium, () => this.renderThemeToggle("header"), () => nothing)}
		</aside>
		`;
	}

	protected renderProjectCard(rollup: ProjectRollup) {
		const progress = rollup.initiativeCount > 0 ? Math.round((rollup.completedInitiativeCount / rollup.initiativeCount) * 100) : 0;

		return html`
		<button
			class="project-card"
			data-project=${rollup.project.id}
			@click=${this.onSelectProject}
		>
			<div class="project-card-head">
				<div>
					<h2>${rollup.project.title}</h2>
					<p>${this.store.shortRef(rollup.project)}</p>
				</div>
				<span class="badge ${this.store.badgeTone(rollup.project.status)}">${rollup.project.status}</span>
			</div>
			<div class="project-counts">
				<span>${rollup.epicCount} epics</span>
				<span>${rollup.initiativeCount} initiatives</span>
				<span>${rollup.completedInitiativeCount}/${rollup.initiativeCount} completed</span>
			</div>
			<div
				aria-label=${`${progress}% of initiatives completed`}
				class="project-progress"
				role="progressbar"
				aria-valuemax="100"
				aria-valuemin="0"
				aria-valuenow=${String(progress)}
			>
				<span style=${`width:${progress}%`}></span>
			</div>
		</button>
		`;
	}

	protected renderProjectChooser() {
		const store = this.store;
		const tenantName = store.selectedTenantDisplayName.get() ?? "Selected tenant";
		const discovery = store.projectDiscovery.get();
		const availableProjects = discovery?.kind === "available" ? discovery.projects : [];

		return html`
		<main class="project-chooser" data-view="project-chooser">
			<div class="project-chooser-inner">
				${this.renderPersonalNavigation()}
				<div class="ai-crumbs">${tenantName}</div>
				<h1>Projects</h1>
				${when(
					availableProjects.length > 0,
					() => html`
					<p class="project-chooser-copy">Choose a project to open its console.</p>
					<div class="project-grid">
						${repeat(availableProjects, (entry) => entry.project.id, (entry) => this.renderProjectCard(entry))}
					</div>
					`,
					() => when(
						discovery?.kind === "unavailable",
						() => html`<div class="project-state unavailable">This tenant is unavailable. Choose an available tenant from the switcher.</div>`,
						() => when(
							discovery?.kind === "available",
							() => html`<div class="project-state">This tenant has no available projects.</div>`,
							() => html`<div class="project-state">Loading projects…</div>`
						)
					)
				)}
			</div>
		</main>
		`;
	}

	protected renderInitiativeCard(rollup: InitiativeRollup) {
		const store = this.store;
		const { initiative } = rollup;
		const progress = rollup.issueCount > 0 ? Math.round((rollup.completedIssueCount / rollup.issueCount) * 100) : 0;

		return html`
		<button
			class=${classMap({ active: store.activeInitiativeId.get() === initiative.id, "m-item": true })}
			data-initiative=${initiative.id}
			@click=${this.onSelectInitiative}
		>
			<div class="m-top">
				<span class="m-title">${initiative.title}</span>
				<span class=${`badge ${store.badgeTone(initiative.status)}`}>${initiative.status}</span>
			</div>
			<div class="m-meta">
				<span><b>${rollup.completedIssueCount}/${rollup.issueCount}</b> issues</span>
			</div>
			<div class="miniprog"><span style=${`width:${progress}%`}></span></div>
			<div class="m-dates">
				<span><i>created</i> <b>${store.formatTimestamp(initiative.createdAt)}</b></span>
				<span><i>changed</i> <b>${store.formatTimestamp(initiative.updatedAt)}</b></span>
			</div>
		</button>
		`;
	}

	protected renderEpicInitiativeGroup(group: ProjectSummaryEpicGroup) {
		const expanded = this.store.isEpicExpanded(group.epic.id);
		const label = group.epic.id === "EPIC0" ? "Uncategorized work" : group.epic.title;
		const completedInitiativeCount = group.initiatives.filter((rollup) => this.store.isDoneStatus(rollup.initiative.status)).length;
		const completionPercentage = group.initiatives.length > 0 ? Math.round((completedInitiativeCount / group.initiatives.length) * 100) : 0;

		return html`
		<section
			class="epic-group"
			data-epic=${group.epic.id}
		>
			<button
				aria-expanded=${String(expanded)}
				class="epic-group-head"
				data-epic-toggle=${group.epic.id}
				@click=${this.onToggleEpic}
			>
				<h2>${label}</h2>
				<span>${group.initiatives.length} initiatives</span>
				<span>${completedInitiativeCount}/${group.initiatives.length} completed</span>
			</button>
			<div
				aria-label=${`${completionPercentage}% of ${label} initiatives completed`}
				class="epic-progress"
				role="progressbar"
				aria-valuemax="100"
				aria-valuemin="0"
				aria-valuenow=${String(completionPercentage)}
			>
				<span style=${`width:${completionPercentage}%`}></span>
			</div>
			${when(
				expanded,
				() => html`
				<div class="epic-group-items">
					${repeat(group.initiatives, (rollup) => rollup.initiative.id, (rollup) => this.renderInitiativeCard(rollup))}
				</div>
				`,
				() => nothing
			)}
		</section>
		`;
	}

	protected renderAdrCard(entry: AdrRailEntry) {
		const store = this.store;
		const adr = entry.adr;

		return html`
		<button
			class=${classMap({ active: store.selectedId.get() === adr.id, "m-item": true })}
			data-id=${adr.id}
			data-scope=${entry.scope}
			@click=${this.onSelectEntity}
		>
			<div class="m-top">
				<span class="m-title">${adr.title}</span>
				<span class=${`badge ${store.badgeTone(adr.status)}`}>${adr.status}</span>
			</div>
			<div class="m-meta">
				<span class="idtag">${store.shortRef(adr)}</span>
				<span>${entry.scopeLabel}</span>
				<span>updated ${store.formatTimestamp(adr.updatedAt)}</span>
			</div>
		</button>
		`;
	}

	protected renderDebtCard(debt: Entity) {
		const store = this.store;

		return html`
		<button
			class=${classMap({ active: store.selectedId.get() === debt.id, "m-item": true })}
			data-id=${debt.id}
			@click=${this.onSelectEntity}
		>
			<div class="m-top">
				<span class="m-title">${debt.title}</span>
				<span class=${`badge ${store.badgeTone(debt.status)}`}>${debt.status}</span>
			</div>
			<div class="m-meta">
				<span class="idtag">${store.shortRef(debt)}</span>
				<span>${debt.category ?? "uncategorized"}</span>
				<span>${debt.priority ?? "no priority"}</span>
				<span>updated ${store.formatTimestamp(debt.updatedAt)}</span>
			</div>
		</button>
		`;
	}

	protected renderDebtFilter(filter: DebtFilter, label: string, values: string[], selected: string) {
		return html`
		<div
			aria-label=${`Filter debt by ${label.toLowerCase()}`}
			class="master-status-filters"
			role="group"
		>
			<span class="master-filter-label">${label}</span>
			${repeat(
				["all", ...values],
				(value) => value,
				(value) => html`
				<button
					aria-pressed=${this.toAriaBoolean(selected === value)}
					class=${classMap({ active: selected === value, "master-status-chip": true })}
					data-debt-filter=${filter}
					data-debt-value=${value}
					@click=${this.onSetDebtFilter}
				>
					${this.formatStatusFilter(value)}
				</button>
				`
			)}
		</div>
		`;
	}

	protected renderProjectContextSource(source: ProjectContextTermSource) {
		const scopeLabel = source.scopeKind === "default" ? "Shared context" : source.scopeLabel;

		return html`
		<div
			class="ctx-source"
			data-scope=${source.scopeKind}
		>
			<div class="ctx-source-head">
				<span class="ctx-scope">${scopeLabel}</span>
				<span class="ctx-source-title">${source.contextTitle}</span>
			</div>
			<p class="ctx-def">${source.definition}</p>
			${when(
				source.avoid.length > 0,
				() => html`
				<div class="ctx-avoid">
					<span class="ctx-avoid-label">Avoid</span>
					${repeat(source.avoid, (phrase) => phrase, (phrase) => html`<span class="ctx-avoid-chip">${phrase}</span>`)}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	protected renderProjectContextTerm(entry: ProjectContextTermEntry) {
		const duplicateLabel = entry.hasConflictingDefinitions
			? `conflicting definitions across ${entry.sources.length} scopes`
			: `defined in ${entry.sources.length} scopes`;

		return html`
		<article
			class="ctx-term"
			data-term=${entry.term}
			tabindex="-1"
		>
			<div class="ctx-top">
				<span class="ctx-name">${entry.term}</span>
				${when(entry.hasSharedSource, () => html`<span class="ctx-badge shared">shared</span>`, () => nothing)}
				${when(entry.hasDuplicates, () => html`<span class="ctx-badge warn">${duplicateLabel}</span>`, () => nothing)}
			</div>
			<div class="ctx-sources">
				${repeat(
					entry.sources,
					(source) => `${source.contextKey}:${source.scopeLabel}`,
					(source) => this.renderProjectContextSource(source)
				)}
			</div>
		</article>
		`;
	}

	protected renderSharedContextPanel() {
		const target = this.store.selectedNestedTarget.get();
		const targetTerm = target?.type === "context-term" && !target.scopeRef ? target.id : null;
		return html`
		<section class="ctx-block">
			<div class="ctx-section-head">
				<div>
					<h2 class="ctx-section-title">Shared context</h2>
					<p class="ctx-section-copy">Project-canonical terms and preferred language that should be safe anywhere in this tenant.</p>
				</div>
			</div>
			<div
				class="ctx-context-summary"
				data-context-scope="shared"
				tabindex="-1"
			>
				<agent-issues-context-view
					.context=${this.store.filteredSharedContext.get()}
					.emptyMessage=${"No shared context matches the current search."}
					.targetTerm=${targetTerm}
				></agent-issues-context-view>
			</div>
		</section>
		`;
	}

	protected renderInitiativeContextIndexPanel(showInitiativeFilter = false) {
		const store = this.store;
		const filteredTerms = showInitiativeFilter
			? store.filteredInitiativeContextTerms.get()
			: store.filteredProjectContextTerms.get();
		const totalTerms = filteredTerms.length;
		const duplicateCount = store.projectContextDuplicateCount.get();
		const contextInitiatives = store.projectInitiatives.get();
		const initiativeCount = contextInitiatives.length;
		const selectedInitiativeId = store.selectedContextInitiativeId.get();
		const selectedContext = selectedInitiativeId ? store.getContextForInitiative(selectedInitiativeId) : null;
		const stats = [
			`${totalTerms} discovered terms`,
			`${initiativeCount} initiative contexts`,
			duplicateCount > 0 ? `${duplicateCount} duplicate labels` : null
		]
			.filter((value): value is string => Boolean(value))
			.join(" · ");
		return html`
		<section class="ctx-block">
			<div class="ctx-section-head">
				<div>
					<h2 class="ctx-section-title">Initiative term index</h2>
					<p class="ctx-section-copy">Discover initiative-local terminology without flattening it into project-canonical language.</p>
				</div>
				<div class="ctx-stats">${stats}</div>
			</div>
			${when(
				showInitiativeFilter,
				() => html`
				<div
					aria-label="Filter initiative context"
					class="ctx-initiative-tabs"
					role="tablist"
				>
					<button
						aria-selected=${this.toAriaBoolean(selectedInitiativeId === null)}
						class=${classMap({ active: selectedInitiativeId === null, "ctx-initiative-tab": true })}
						role="tab"
						@click=${this.onSetContextInitiativeFilter}
					>
						All initiatives
					</button>
					${repeat(
						contextInitiatives,
						(bundle) => bundle.initiative.id,
						(bundle) => html`
						<button
							aria-selected=${this.toAriaBoolean(selectedInitiativeId === bundle.initiative.id)}
							class=${classMap({ active: selectedInitiativeId === bundle.initiative.id, "ctx-initiative-tab": true })}
							data-context-initiative=${bundle.initiative.id}
							role="tab"
							@click=${this.onSetContextInitiativeFilter}
						>
							${bundle.initiative.title}
						</button>
						`
					)}
				</div>
				`,
				() => nothing
			)}
			${when(
				selectedContext !== null,
				() => {
					const context = selectedContext;
					if (!context) {
						return nothing;
					}

					return html`
				<div
					class="ctx-context-summary"
					data-context-scope=${context.context.scopeEntityId ?? context.context.key}
					tabindex="-1"
				>
					<h3 class="ctx-context-title">${context.context.title}</h3>
					<p class="ctx-context-copy">${context.context.summary}</p>
				</div>
					`;
				},
				() => nothing
			)}
			${when(
				filteredTerms.length > 0,
				() => html`
				<div class="ctx-list">
					${repeat(filteredTerms, (entry) => entry.term, (entry) => this.renderProjectContextTerm(entry))}
				</div>
				`,
				() => html`<p class="ctx-empty">No initiative-scoped terms match the current search.</p>`
			)}
		</section>
		`;
	}

	protected renderMaster() {
		const store = this.store;
		const section = store.activeSection.get();
		const query = store.search.get().trim().toLowerCase();
		const isAdrs = section === "adrs";
		const isDebt = section === "debt";
		const masterSection = isAdrs ? "adrs" : "initiatives";
		const statusFilter = isAdrs ? store.adrStatusFilter.get() : store.initiativeStatusFilter.get();
		const statusValues = isAdrs
			? store.adrRailEntries.get().map((entry) => entry.adr.status)
			: store.projectSummaryInitiatives.get().map((rollup) => rollup.initiative.status);
		const statusOptions = ["all", ...new Set(statusValues)].sort((left, right) => {
			if (left === "all") {
				return -1;
			}
			if (right === "all") {
				return 1;
			}
			return left.localeCompare(right);
		});

		const initiativeSort = store.initiativeSort.get();
		const epicGroups = store.projectSummaryEpicGroups.get().map((group) => ({
			...group,
			initiatives: this.sortInitiatives(group.initiatives.filter((rollup) =>
				(statusFilter === "all" || rollup.initiative.status === statusFilter) &&
				`${rollup.initiative.title} ${rollup.initiative.id}`.toLowerCase().includes(query)
			), initiativeSort)
		})).filter((group) => group.initiatives.length > 0);
		const adrEntries = store.adrRailEntries.get().filter((entry) =>
			(statusFilter === "all" || entry.adr.status === statusFilter) &&
			`${entry.adr.title} ${entry.adr.id}`.toLowerCase().includes(query)
		);
		const allDebtRecords = store.allDebtRecords.get();
		const debtEntries = store.debtRecords.get().filter((debt) =>
			`${debt.title} ${debt.id} ${debt.category ?? ""} ${debt.priority ?? ""}`.toLowerCase().includes(query)
		);
		const debtCategories = [...new Set(allDebtRecords.map((debt) => debt.category).filter((category): category is string => Boolean(category)))].sort();
		const debtPriorities = [...new Set(allDebtRecords.map((debt) => debt.priority).filter((priority): priority is string => Boolean(priority)))].sort();
		const debtLifecycles = [...new Set(allDebtRecords.map((debt) => debt.status))].sort();
		const sectionFeedback = this.renderSectionFeedback(section);
		const initiativesLoading = section === "initiatives" && store.selectedProjectId.get() !== null && store.projectSummary.get() === null && store.syncLabel.get() === "connecting";

		return html`
		<section class="master" data-pane="master">
			<button
				class="pane-collapse"
				data-collapse="master"
				title=${store.masterCollapsed.get() ? "Expand list" : "Collapse list"}
				@click=${this.onToggleMaster}
			>
				${store.masterCollapsed.get() ? "»" : "«"}
			</button>
			<div class="master-head">
				<h1>${choose(section, [["adrs", () => html`Architecture decisions`], ["debt", () => html`Debt records`]], () => html`Initiatives`)}</h1>
				<p>${when(
					isDebt,
					() => html`Review accepted debt by lifecycle, category, and priority.`,
					() => when(
						isAdrs,
						() => html`Open a decision to read its context, decision and consequences.`,
						() => html`Select an initiative to explore its issues and user stories.`
					)
				)}</p>
				<input
					class="master-search"
					placeholder="Filter…"
					.value=${store.search.get()}
					@input=${this.onSearchInput}
				/>
				${when(
					isDebt,
					() => html`
					${this.renderDebtFilter("lifecycle", "Lifecycle", debtLifecycles, store.debtLifecycleFilter.get())}
					${this.renderDebtFilter("category", "Category", debtCategories, store.debtCategoryFilter.get())}
					${this.renderDebtFilter("priority", "Priority", debtPriorities, store.debtPriorityFilter.get())}
					`,
					() => html`
					<div
						aria-label=${`Filter ${isAdrs ? "ADRs" : "initiatives"} by status`}
						class="master-status-filters"
						role="group"
					>
						${repeat(
							statusOptions,
							(status) => status,
							(status) => html`
							<button
								aria-pressed=${this.toAriaBoolean(statusFilter === status)}
								class=${classMap({ active: statusFilter === status, "master-status-chip": true })}
								data-master-section=${masterSection}
								data-master-status=${status}
								@click=${this.onSetMasterStatusFilter}
							>
								${this.formatStatusFilter(status)}
							</button>
							`
						)}
					</div>
					${when(
						!isAdrs,
						() => html`
						<label class="master-sort-control">
							<span>Sort by</span>
							<select
								data-initiative-sort
								.value=${initiativeSort}
								@change=${this.onSetInitiativeSort}
							>
								<option value="changed">Last changed</option>
								<option value="created">Date created</option>
								<option value="title">Title</option>
							</select>
						</label>
						`,
						() => nothing
					)}
					`
				)}
			</div>
			${sectionFeedback}
			<div class="master-list">
				${when(
					initiativesLoading,
					() => html`
					<div aria-live="polite" class="master-loading" role="status">
						<span aria-hidden="true" class="master-loading-spinner"></span>
						<span>Loading initiatives</span>
					</div>
					`,
					() => choose(section, [
						["adrs", () => html`${repeat(adrEntries, (entry) => entry.adr.id, (entry) => this.renderAdrCard(entry))}`],
						["debt", () => html`${repeat(debtEntries, (debt) => debt.id, (debt) => this.renderDebtCard(debt))}`]
					], () => html`${repeat(epicGroups, (group) => group.epic.id, (group) => this.renderEpicInitiativeGroup(group))}`)
				)}
			</div>
		</section>
		`;
	}

	protected renderSectionFeedback(section: ConsoleSection) {
		const cache = section === "adrs"
			? this.store.projectAdrsCache.get()
			: section === "debt"
				? this.store.projectDebtCache.get()
				: section === "context"
					? this.store.projectContextCache.get()
					: section === "graph"
						? this.store.projectGraphCache.get()
						: null;
		if (!cache) {
			return nothing;
		}
		if (cache.error) {
			return html`
			<div class="project-state unavailable">
				Could not refresh this section.
				<button
					data-section=${section}
					@click=${this.onRetryProjectSection}
				>
					Retry
				</button>
			</div>
			`;
		}
		if (cache.loading) {
			return html`<div class="project-state">Loading section...</div>`;
		}
		return nothing;
	}

	protected renderDetail() {
		const store = this.store;
		const section = store.activeSection.get();
		const selectedInitiativeId = store.selectedInitiativeId.get();
		const selectedId = store.selectedId.get();

		if (section === "context") {
			const sharedContext = store.sharedContext.get();
			if (!sharedContext) {
				return html`
				<section class="detail" data-pane="detail">
					<div class="detail-inner wide-inner">
						<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Context</div>
						<h1 class="d-title">${when(store.projectContextCache.get().error, () => html`Context unavailable`, () => html`Loading context`)}</h1>
						${this.renderSectionFeedback("context")}
					</div>
				</section>
				`;
			}
			const contextTab = store.contextTab.get();
			const searchPlaceholder = {
				all: "Search all context…",
				global: "Search shared context…",
				initiatives: "Search initiative terminology…"
			}[contextTab];

			return html`
			<section class="detail" data-pane="detail">
				<div class="detail-inner wide-inner">
					<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Context</div>
					<h1 class="d-title">${sharedContext.context.title}</h1>
					<p class="d-sub">Shared glossary plus initiative-scoped term discovery, with scope preserved so local language stays findable without becoming silently global.</p>
					${this.renderSectionFeedback("context")}
					<div class="ctx-controls">
						<input
							class="master-search"
							placeholder=${searchPlaceholder}
							.value=${store.contextSearch.get()}
							@input=${this.onContextSearchInput}
						/>
						<div class="ctx-tabs">
							${repeat(
								[
									{ label: "All", tab: "all" },
									{ label: "Global", tab: "global" },
									{ label: "Initiatives", tab: "initiatives" }
								],
								(item) => item.tab,
								(item) => html`
								<button
									class=${classMap({ active: contextTab === item.tab, "ctx-tab": true })}
									data-context-tab=${item.tab}
									@click=${this.onSetContextTab}
								>
									${item.label}
								</button>
								`
							)}
						</div>
					</div>
					<div class="ctx-shell">
						${choose(contextTab, [
							["all", () => html`${this.renderSharedContextPanel()}${this.renderInitiativeContextIndexPanel()}`],
							["global", () => html`${this.renderSharedContextPanel()}`],
							["initiatives", () => html`${this.renderInitiativeContextIndexPanel(true)}`]
						])}
					</div>
				</div>
			</section>
			`;
		}

		if (section === "graph") {
			const visibleGraphKinds = store.visibleProjectGraphKinds.get();
			return html`
			<section class="detail" data-pane="detail">
				<div class="detail-inner wide-inner">
					<div class="ai-crumbs">${store.selectedTenantDisplayName.get()} · Graph</div>
					<h1 class="d-title">Project relationship graph</h1>
					<p class="d-sub">Project decisions, epics, initiatives, and their PRDs, ADRs, and issues. Click an initiative or record to open it.</p>
					${this.renderSectionFeedback("graph")}
					<div class="ai-graph-wrap">
						<div class="graph-scroll-content">
							<div class="ai-graph-legend">
								<agent-issues-relationship-graph-filters
									.visibleKinds=${visibleGraphKinds}
									@graph-kind-toggle=${this.onToggleProjectGraphKind}
								></agent-issues-relationship-graph-filters>
								<span class="ai-graph-hint">Tip: hover a node for its full title</span>
							</div>
							<div class="graph-host">
								<agent-issues-relationship-graph
									.graph=${store.buildProjectGraph()}
									@node-open=${this.onProjectNodeOpen}
								></agent-issues-relationship-graph>
							</div>
						</div>
					</div>
				</div>
			</section>
			`;
		}

		if (selectedId) {
			return html`
			<section class="detail" data-pane="detail">
				<agent-issues-detail-view .store=${store}></agent-issues-detail-view>
			</section>
			`;
		}

		if (selectedInitiativeId) {
			return html`
			<section class="detail" data-pane="detail">
				<agent-issues-initiative-detail-view .store=${store}></agent-issues-initiative-detail-view>
			</section>
			`;
		}

		return html`
		<section class="detail" data-pane="detail">
			<div class="empty">
				<div>
					<div class="empty-glyph">🗂️</div>
					<p>Select ${when(section === "adrs", () => html`an ADR`, () => html`an initiative`)} from the list</p>
				</div>
			</div>
		</section>
		`;
	}

	render() {
		const store = this.store;
		if (store.activePage.get() === "instructions") {
			return html`
			<div class="instructions-shell">
				<aside class="rail">
					<button
						aria-label="Projects"
						class="nav-item"
						title="Projects"
						@click=${this.onOpenProjectChooser}
					>
						<span class="nav-icon">${this.projectsIcon}</span>
						<span class="nav-label">Projects</span>
					</button>
					<nav class="rail-nav">${this.renderPersonalNavigation()}</nav>
					${this.renderThemeToggle("rail")}
				</aside>
				<agent-issues-instructions-view .store=${store}></agent-issues-instructions-view>
			</div>
			`;
		}
		if (store.selectedTenant.get() && !store.selectedProjectId.get()) {
			return this.renderProjectChooser();
		}

		const section = store.activeSection.get();
		const wide = !this.narrow && (section === "graph" || section === "context");
		const railCollapsed = store.railCollapsed.get();
		const masterCollapsed = !wide && store.masterCollapsed.get();
		const hasDetail = store.selectedId.get() !== null || store.selectedInitiativeId.get() !== null || section === "context" || section === "graph";

		return html`
		<div class=${classMap({
			console: true,
			"has-detail": hasDetail,
			"master-collapsed": masterCollapsed,
			medium: this.medium,
			"mobile-master-open": this.mobileMasterOpen,
			narrow: this.narrow,
			"rail-collapsed": railCollapsed,
			wide
		})}>
			${this.renderRail()}
			${when(!wide, () => this.renderMaster(), () => nothing)}
			${this.renderDetail()}
			${when(
				store.globalSearchOpen.get(),
				() => html`
				<agent-issues-global-search-overlay
					.store=${store}
					@global-search-close=${this.onCloseGlobalSearch}
					@global-search-open-target=${this.onOpenGlobalSearchTarget}
					@global-search-retry=${this.onRetryGlobalSearch}
				></agent-issues-global-search-overlay>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	static styles = [
		issueBrowserTypographyStyles,
		issueBrowserControlStyles,
		css`
		:host {
			display: block;
			height: 100vh;
			background: var(--page-bg);
			color: var(--text);
		}
		.console {
			display: grid;
			grid-template-columns: 256px 380px 1fr;
			height: stretch;
			overflow: hidden;
		}
		.instructions-shell {
			display: grid;
			grid-template-columns: 256px minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr);
			height: 100%;
			overflow: hidden;
		}
		@media (max-width: 900px) {
			.instructions-shell {
				grid-template-columns: minmax(0, 1fr);
				grid-template-rows: 52px minmax(0, 1fr);
			}
			.instructions-shell .rail {
				flex-direction: row;
				align-items: center;
				border-right: 0;
				border-bottom: 1px solid var(--border);
				z-index: 10;
			}
			.instructions-shell .rail-nav {
				display: flex;
				flex: 1;
				flex-direction: row;
				align-self: stretch;
				padding: 4px;
				overflow-x: auto;
				overflow-y: hidden;
			}
			.instructions-shell .nav-item {
				flex: 0 0 40px;
				justify-content: center;
				width: 40px;
				padding: 0;
			}
			.instructions-shell .rail-theme-toggle {
				flex: 0 0 40px;
				align-self: stretch;
				width: 40px;
				height: auto;
				margin: 0;
				border: 0;
				border-radius: 0;
			}
			.instructions-shell .nav-label, .instructions-shell .nav-group-label {
				display: none;
			}
		}
		.console.wide {
			grid-template-columns: 256px 1fr;
		}
		.console.rail-collapsed {
			grid-template-columns: 44px 380px 1fr;
		}
		.console.wide.rail-collapsed {
			grid-template-columns: 44px 1fr;
		}
		.console.master-collapsed {
			grid-template-columns: 256px 44px 1fr;
		}
		.console.rail-collapsed.master-collapsed {
			grid-template-columns: 44px 44px 1fr;
		}
		.console.rail-collapsed .rail-switcher,
		.console.rail-collapsed .rail-nav,
		.console.rail-collapsed .rail-foot,
		.console.master-collapsed .master-head,
		.console.master-collapsed .master-list {
			display: none;
		}
		.pane-collapse {
			display: flex;
			flex-shrink: 0;
			align-items: center;
			justify-content: center;
			align-self: flex-end;
			width: 24px;
			height: 24px;
			margin: 8px;
			padding: 0;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
			font-size: 13px;
			line-height: 1;
			cursor: pointer;
		}
		.pane-collapse:hover {
			border-color: var(--accent);
			color: var(--text);
		}
		.mobile-master-toggle {
			display: none;
		}
		.console.rail-collapsed .rail .pane-collapse,
		.console.master-collapsed .master .pane-collapse {
			align-self: center;
		}
		.rail {
			display: flex;
			flex-direction: column;
			overflow: hidden;
			background: var(--rail-bg);
			border-right: 1px solid var(--border);
		}
		.rail-switcher {
			position: relative;
			padding: 12px;
			border-bottom: 1px solid var(--border-muted);
		}
		.global-search-trigger {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin: 0 12px 8px;
			padding: 8px 10px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
			font-size: 13px;
		}
		.global-search-trigger:hover {
			border-color: var(--accent);
			color: var(--text);
		}
		.global-search-trigger kbd {
			padding: 1px 4px;
			border: 1px solid var(--border-muted);
			border-radius: 3px;
			font: inherit;
			font-size: 11px;
		}
		.global-search-icon-trigger {
			display: none;
		}
		.switcher-actions {
			display: flex;
			gap: 6px;
		}
		.switcher-button {
			display: flex;
			flex: 1;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 8px 10px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			cursor: pointer;
			text-align: left;
			anchor-name: --switcher-anchor;
		}
		.switcher-button:hover {
			background: var(--surface-muted);
		}
		.switcher-tenant-button {
			width: 36px;
			padding: 0;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.switcher-tenant-button:hover {
			background: var(--surface-muted);
			color: var(--text);
		}
		.avatar {
			display: grid;
			flex-shrink: 0;
			place-items: center;
			width: 28px;
			height: 28px;
			border-radius: 6px;
			background: linear-gradient(135deg, var(--avatar-start), var(--avatar-end));
			color: var(--avatar-text);
			font-size: 13px;
			font-weight: 700;
		}
		.avatar.small {
			width: 24px;
			height: 24px;
			font-size: 11px;
		}
		.sw-text {
			display: grid;
		}
		.sw-name {
			font-weight: 600;
		}
		.sw-sub {
			color: var(--muted);
			font-size: 12px;
		}
		.menu {
			position: fixed;
			position-anchor: --switcher-anchor;
			top: anchor(bottom);
			left: anchor(left);
			right: anchor(right);
			margin: 0;
			margin-top: 4px;
			z-index: 40;
			overflow: hidden;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
			box-shadow: 0 12px 28px var(--shadow);
		}
		.menu-item {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 10px 12px;
			border: 0;
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.menu-item:hover {
			background: var(--surface-muted);
		}
		.menu-item .check {
			width: 14px;
			color: var(--accent);
		}
		.rail-nav {
			flex: 1;
			overflow-y: auto;
			padding: 12px 8px;
		}
		.nav-group-label {
			padding: 8px 12px 4px;
			color: var(--muted);
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.nav-group-label.totals {
			margin-top: 8px;
		}
		.nav-item {
			display: flex;
			gap: 10px;
			align-items: center;
			width: stretch;
			padding: 7px 12px;
			border: 0;
			border-radius: 6px;
			background: transparent;
			color: var(--text);
			cursor: pointer;
			text-align: left;
		}
		.nav-item:hover {
			background: var(--surface-muted);
		}
		.nav-item.active {
			background: var(--accent-soft);
			color: var(--accent);
			font-weight: 600;
		}
		.nav-item.static {
			color: var(--muted);
			cursor: default;
		}
		.nav-item.static:hover {
			background: transparent;
		}
		.nav-label {
			flex: 1;
		}
		.nav-count {
			margin-left: auto;
			color: var(--muted);
			font-size: 12px;
		}
		.nav-item.active .nav-count {
			color: var(--accent);
		}
		.rail-foot {
			display: flex;
			gap: 8px;
			align-items: center;
			padding: 12px;
			border-top: 1px solid var(--border-muted);
			color: var(--muted);
			font-size: 12px;
		}
		.rail-foot-copy {
			min-width: 0;
			flex: 1;
		}
		.theme-toggle {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 32px;
			height: 32px;
			padding: 0;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			font: inherit;
			font-size: 17px;
			line-height: 1;
			cursor: pointer;
		}
		.theme-toggle:hover,
		.theme-toggle[aria-pressed="true"] {
			border-color: var(--accent);
			background: var(--accent-soft);
			color: var(--accent);
		}
		.header-theme-toggle {
			display: none;
		}
		.master {
			display: flex;
			flex-direction: column;
			overflow: hidden;
			background: var(--surface);
			border-right: 1px solid var(--border);
		}
		.master-head {
			padding: 16px;
			border-bottom: 1px solid var(--border-muted);
		}
		.master-head h1 {
			font-size: 16px;
		}
		.master-head p {
			margin: 4px 0 0;
			color: var(--muted);
			font-size: 13px;
		}
		.master-search {
			margin-top: 12px;
			background: var(--surface-muted);
		}
		.master-status-filters {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
			margin-top: 10px;
		}
		.master-status-chip {
			padding: 4px 8px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--surface);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
			font-size: 12px;
		}
		.master-status-chip.active {
			border-color: var(--accent);
			background: var(--accent-soft);
			color: var(--text);
			font-weight: 600;
		}
		.master-sort-control {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			gap: 8px;
			align-items: center;
			margin-top: 10px;
			color: var(--muted);
			font-size: 12px;
		}
		.master-sort-control select {
			min-width: 0;
			padding: 5px 8px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			font: inherit;
		}
		.master-list {
			flex: 1;
			overflow-y: auto;
		}
		.master-loading {
			display: grid;
			gap: 10px;
			min-height: 160px;
			place-content: center;
			place-items: center;
			color: var(--muted);
			font-size: 12px;
			font-weight: 600;
		}
		.master-loading-spinner {
			box-sizing: border-box;
			width: 18px;
			height: 18px;
			border: 2px solid var(--border);
			border-top-color: var(--accent);
			border-radius: 50%;
			animation: master-loading-spin 700ms linear infinite;
		}
		@keyframes master-loading-spin {
			to {
				transform: rotate(360deg);
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.master-loading-spinner {
				animation: none;
			}
		}
		.m-item {
			display: block;
			width: stretch;
			padding: 14px 16px;
			border: 0;
			border-bottom: 1px solid var(--border-muted);
			background: transparent;
			cursor: pointer;
			text-align: left;
		}
		.epic-group + .epic-group {
			border-top: 1px solid var(--border);
		}
		.epic-group-head {
			display: flex;
			gap: 8px;
			align-items: baseline;
			width: stretch;
			padding: 12px 16px;
			border: 0;
			background: var(--surface-muted);
			color: var(--muted);
			cursor: pointer;
			font: inherit;
			font-size: 12px;
			text-align: left;
		}
		.epic-group-head:hover {
			background: var(--accent-soft);
		}
		.epic-group-head:focus-visible {
			outline: 2px solid rgba(9, 105, 218, 0.45);
			outline-offset: -2px;
		}
		.epic-group-head h2 {
			flex: 1;
			margin: 0;
			color: var(--text);
			font-size: 13px;
		}
		.epic-progress {
			height: 3px;
			background: var(--border-muted);
		}
		.epic-progress span {
			display: block;
			height: 100%;
			background: var(--done);
		}
		.m-item:hover {
			background: var(--surface-muted);
		}
		.m-item.active {
			background: var(--accent-soft);
			box-shadow: inset 3px 0 0 var(--accent);
		}
		.m-top {
			display: flex;
			gap: 8px;
			justify-content: space-between;
			align-items: center;
		}
		.m-title {
			font-size: 14px;
			font-weight: 600;
		}
		.m-sub {
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			margin-top: 4px;
			color: var(--muted);
			font-size: 12px;
			line-height: 1.4;
		}
		.m-meta {
			display: flex;
			gap: 10px;
			margin-top: 8px;
			color: var(--muted);
			font-size: 12px;
		}
		.m-meta b {
			color: var(--text);
		}
		.idtag {
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.miniprog {
			overflow: hidden;
			height: 4px;
			margin-top: 10px;
			border-radius: 999px;
			background: #eaeef2;
		}
		.miniprog > span {
			display: block;
			height: 100%;
			background: var(--done);
		}
		.m-dates {
			display: flex;
			gap: 6px 12px;
			justify-content: space-between;
			flex-wrap: wrap;
			margin-top: 8px;
			color: var(--muted);
			font-size: 11px;
		}
		.m-dates i {
			font-style: italic;
		}
		.m-dates b {
			color: var(--text);
			font-weight: 600;
		}
		.detail {
			overflow-y: auto;
			scrollbar-gutter: stable;
		}
		.detail-inner {
			max-width: 920px;
			margin: 0 auto;
			padding: 28px 32px 64px;
		}
		.wide-inner {
			max-width: none;
		}
		.ai-crumbs {
			color: var(--muted);
			font-size: 12px;
		}
		.d-title {
			margin: 6px 0 0;
			font-size: 24px;
		}
			.console.medium .header-theme-toggle {
				display: inline-flex;
				flex: 0 0 40px;
				align-self: stretch;
				width: 40px;
				height: auto;
				margin-left: auto;
				border-top: 0;
				border-right: 0;
				border-bottom: 0;
				border-radius: 0;
			}
		.d-sub {
			max-width: 70ch;
			margin: 10px 0 0;
			color: var(--muted);
		}
		.ctx-controls {
			display: grid;
			gap: 14px;
			margin-top: 18px;
		}
		.ctx-tabs {
			display: flex;
			gap: 18px;
			border-bottom: 1px solid var(--border-muted);
		}
		.ctx-tab {
			padding: 8px 2px;
			border: 0;
			border-bottom: 2px solid transparent;
			background: transparent;
			color: var(--muted);
			cursor: pointer;
			font: inherit;
		}
		.ctx-tab.active {
			border-bottom-color: #fd8c73;
			color: var(--text);
			font-weight: 600;
		}
		.ctx-shell {
			display: grid;
			gap: 18px;
			margin-top: 16px;
		}
		.ctx-block {
			padding: 16px;
			border: 1px solid var(--border);
			border-radius: 12px;
			background: var(--surface);
		}
		.ctx-section-head {
			display: flex;
			gap: 16px;
			justify-content: space-between;
			align-items: baseline;
		}
		.ctx-section-title {
			margin: 0;
			font-size: 16px;
		}
		.ctx-section-copy {
			margin: 4px 0 0;
			color: var(--muted);
		}
		.ctx-stats {
			color: var(--muted);
			font-size: 12px;
			text-align: right;
		}
		.ctx-initiative-tabs {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
			margin-top: 16px;
		}
		.ctx-initiative-tab {
			padding: 7px 10px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
			color: var(--text);
			cursor: pointer;
			font: inherit;
		}
		.ctx-initiative-tab.active {
			border-color: var(--accent);
			background: var(--accent-soft);
			font-weight: 600;
		}
		.ctx-list {
			display: grid;
			gap: 12px;
			margin-top: 14px;
		}
		.ctx-term {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface-muted);
		}
		.ctx-term:focus {
			outline: 2px solid var(--focus-ring);
			outline-offset: -2px;
		}
		.ctx-term.is-context-term-target {
			animation: context-term-target 1.8s ease-out;
		}
		.ctx-context-summary:focus {
			outline: 2px solid var(--focus-ring);
			outline-offset: 4px;
		}
		.ctx-context-summary.is-context-target {
			animation: context-term-target 1.8s ease-out;
		}
		@keyframes context-term-target {
			0% {
				background: var(--accent-soft);
				box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);
			}
			100% {
				background: var(--surface-muted);
				box-shadow: 0 0 0 0 transparent;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.ctx-context-summary.is-context-target,
			.ctx-term.is-context-term-target {
				animation: none;
				outline: 2px solid var(--focus-ring);
			}
		}
		.ctx-top {
			display: flex;
			gap: 8px;
			align-items: center;
			flex-wrap: wrap;
		}
		.ctx-name {
			font-size: 16px;
			font-weight: 600;
		}
		.ctx-badge {
			padding: 2px 8px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 600;
		}
		.ctx-badge.shared {
			background: #ddf4ff;
			color: #0969da;
		}
		.ctx-badge.warn {
			background: #fff8c5;
			color: #9a6700;
		}
		.ctx-sources {
			display: grid;
			gap: 10px;
			margin-top: 12px;
		}
		.ctx-source {
			padding-left: 12px;
			border-left: 3px solid var(--border);
		}
		.ctx-source[data-scope="default"] {
			border-left-color: #0969da;
		}
		.ctx-source[data-scope="initiative"] {
			border-left-color: #1f883d;
		}
		.ctx-source-head {
			display: flex;
			gap: 8px;
			align-items: baseline;
			flex-wrap: wrap;
		}
		.ctx-scope {
			font-weight: 600;
		}
		.ctx-source-title {
			color: var(--muted);
			font-size: 12px;
		}
		.ctx-def {
			max-width: 75ch;
			margin: 6px 0 0;
		}
		.ctx-avoid {
			display: flex;
			gap: 6px;
			align-items: center;
			flex-wrap: wrap;
			margin-top: 8px;
		}
		.ctx-avoid-label {
			color: var(--muted);
			font-size: 11px;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.ctx-avoid-chip {
			padding: 2px 8px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--surface);
			color: var(--muted);
			font-size: 12px;
		}
		.ctx-empty {
			margin: 14px 0 0;
			color: var(--muted);
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
		.ai-graph-hint {
			margin-left: auto;
		}
		.graph-host {
			padding: 0;
		}
		.empty {
			display: grid;
			place-items: center;
			height: stretch;
			color: var(--muted);
			text-align: center;
		}
		.empty-glyph {
			font-size: 40px;
		}
		.project-chooser {
			min-height: 100%;
			overflow-y: auto;
			background: var(--page-bg);
		}
		.project-chooser-inner {
			max-width: 1040px;
			margin: 0 auto;
			padding: 40px 32px 64px;
		}
		.project-chooser h1 {
			margin-top: 6px;
			font-size: 28px;
		}
		.project-chooser-copy {
			margin: 10px 0 0;
			color: var(--muted);
		}
		.project-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 12px;
			margin-top: 24px;
		}
		.project-card {
			display: grid;
			gap: 16px;
			min-height: 180px;
			padding: 18px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			cursor: pointer;
			text-align: left;
		}
		.project-card:hover {
			border-color: var(--accent);
			box-shadow: 0 2px 8px rgba(31, 35, 40, 0.1);
		}
		.project-card:focus-visible,
		.projects-button:focus-visible {
			outline: 2px solid rgba(9, 105, 218, 0.45);
			outline-offset: 2px;
		}
		.project-card-head {
			display: flex;
			gap: 12px;
			justify-content: space-between;
			align-items: start;
		}
		.project-card h2 {
			font-size: 16px;
		}
		.project-card p {
			margin: 4px 0 0;
			color: var(--muted);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
			font-size: 12px;
		}
		.project-counts {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
			color: var(--muted);
			font-size: 13px;
		}
		.project-progress {
			overflow: hidden;
			height: 6px;
			border-radius: 3px;
			background: var(--border-muted);
		}
		.project-progress span {
			display: block;
			height: 100%;
			background: var(--done);
		}
		.project-state {
			max-width: 560px;
			margin-top: 24px;
			padding: 18px;
			border: 1px solid var(--border);
			border-radius: 8px;
			background: var(--surface);
			color: var(--muted);
		}
		.project-state.unavailable {
			border-color: rgba(207, 34, 46, 0.25);
			background: var(--danger-bg);
			color: var(--danger);
		}
		@media (max-width: 900px) {
			:host {
				height: 100dvh;
			}
			.console,
			.console.wide {
				position: relative;
				grid-template-columns: minmax(0, 1fr);
				grid-template-rows: 52px minmax(0, 1fr);
				height: 100dvh;
				overflow: hidden;
			}
			.console.narrow .rail {
				grid-column: 1;
				grid-row: 1;
				flex-direction: row;
				align-items: center;
				border-right: 0;
				border-bottom: 1px solid var(--border);
				overflow: hidden;
				z-index: 10;
			}
			.console.narrow .rail .pane-collapse,
			.console.narrow .rail-foot,
			.console.narrow .nav-group-label,
			.console.narrow .nav-item.static,
			.console.narrow .nav-count,
			.console.narrow .sw-text,
			.console.narrow .switcher-tenant-button {
				display: none;
			}
			.mobile-master-toggle {
				display: inline-flex;
				flex: 0 0 40px;
				align-items: center;
				justify-content: center;
				align-self: stretch;
				padding: 0;
				border: 0;
				border-right: 1px solid var(--border);
				background: var(--surface);
				color: var(--text);
				font: inherit;
				font-size: 18px;
				cursor: pointer;
			}
			.mobile-master-toggle[aria-pressed="true"] {
				background: var(--accent-soft);
				color: var(--accent);
			}
			.console.narrow .rail-switcher {
				flex: 0 0 auto;
				padding: 4px 8px;
				border: 0;
			}
			.console.narrow .header-theme-toggle {
				display: inline-flex;
				flex: 0 0 40px;
				align-self: stretch;
				width: 40px;
				height: auto;
				margin-left: auto;
				border-top: 0;
				border-right: 0;
				border-bottom: 0;
				border-radius: 0;
			}
			.console.narrow .global-search-icon-trigger {
				display: inline-flex;
				flex: 0 0 40px;
				align-items: center;
				justify-content: center;
				align-self: stretch;
				width: 40px;
				padding: 0;
				border: 0;
				border-right: 1px solid var(--border);
				background: var(--surface);
				color: var(--text);
				cursor: pointer;
				font: inherit;
				font-size: 20px;
			}
			.console.narrow .switcher-button {
				width: 36px;
				padding: 4px;
				border: 0;
				background: transparent;
			}
			.console.narrow .rail-nav {
				display: flex;
				flex: 1;
				gap: 2px;
				align-self: stretch;
				overflow-x: auto;
				overflow-y: hidden;
				padding: 4px;
			}
			.console.narrow .nav-item {
				flex: 0 0 40px;
				justify-content: center;
				width: 40px;
				padding: 0;
			}
			.console.narrow .nav-label {
				display: none;
			}
			.console.narrow .master,
			.console.narrow .detail {
				grid-column: 1;
				grid-row: 2;
				min-height: 0;
			}
			.console.narrow .detail {
				overflow-y: auto;
			}
			.console.narrow .master {
				z-index: 5;
				border-right: 0;
				box-shadow: 0 12px 28px rgba(31, 35, 40, 0.18);
			}
			.console.narrow.has-detail:not(.mobile-master-open) .master {
				display: none;
			}
			.console.narrow .master .pane-collapse {
				display: none;
			}
			.console.narrow.master-collapsed .master-head,
			.console.narrow.master-collapsed .master-list {
				display: block;
			}
			.console.narrow .detail-inner {
				padding: 20px 16px 40px;
			}
			.project-chooser-inner {
				padding: 28px 16px 40px;
			}
		}
		@media (min-width: 901px) and (max-width: 1200px) {
			.console,
			.console.wide {
				grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
				grid-template-rows: 52px minmax(0, 1fr);
			}
			.console.medium.rail-collapsed,
			.console.medium.master-collapsed,
			.console.medium.rail-collapsed.master-collapsed {
				grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
			}
			.console.medium .rail {
				grid-column: 1 / -1;
				grid-row: 1;
				flex-direction: row;
				align-items: center;
				border-right: 0;
				border-bottom: 1px solid var(--border);
				overflow: hidden;
			}
			.console.medium .rail .pane-collapse,
			.console.medium .rail-foot,
			.console.medium .nav-group-label,
			.console.medium .nav-item.static,
			.console.medium .nav-count,
			.console.medium .sw-text,
			.console.medium .switcher-tenant-button {
				display: none;
			}
			.console.medium .rail-switcher {
				flex: 0 0 auto;
				padding: 4px 8px;
				border: 0;
			}
			.console.medium .switcher-button {
				width: 36px;
				padding: 4px;
				border: 0;
				background: transparent;
			}
			.console.medium .rail-nav {
				display: flex;
				flex: 1;
				gap: 2px;
				align-self: stretch;
				overflow-x: auto;
				overflow-y: hidden;
				padding: 4px;
			}
			.console.medium .nav-item {
				flex: 0 0 40px;
				justify-content: center;
				width: 40px;
				padding: 0;
			}
			.console.medium .nav-label {
				display: none;
			}
			.console.medium .master {
				grid-column: 1;
				grid-row: 2;
				min-height: 0;
			}
			.console.medium .detail {
				grid-column: 2;
				grid-row: 2;
				min-width: 0;
			}
			.console.medium.wide .detail {
				grid-column: 1 / -1;
			}
			.console.medium .master .pane-collapse {
				display: none;
			}
			.console.medium.rail-collapsed .rail-switcher,
			.console.medium.rail-collapsed .rail-nav {
				display: flex;
			}
			.console.medium.master-collapsed .master-head,
			.console.medium.master-collapsed .master-list {
				display: block;
			}
		}
		`
	];
}

customElements.define("agent-issues-app", AgentIssuesApp);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-app": AgentIssuesApp;
	}
	interface HTMLElementEventMap {
		"agent-issues-app-event": CustomEvent<{ detail: string }>;
	}
}