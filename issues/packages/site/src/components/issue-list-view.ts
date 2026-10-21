import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html, nothing } from "lit";
import { choose } from "lit/directives/choose.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import type { Entity, InitiativeBundle, RootTab } from "../models.js";
import type { AgentIssuesStore } from "../services/agent-issues-store.js";
import { issueBrowserControlStyles, issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

class IssueListView extends SignalWatcher(LitElement) {
	static properties = {
		store: { attribute: false }
	};

	public store: AgentIssuesStore | null = null;

	protected onSearchInput = (event: Event) => {
		this.store?.setSearchFromEvent(event);
	};

	protected onSelectEntityClick = (event: Event) => {
		this.store?.selectEntityFromEvent(event);
	};

	protected onSelectInitiativeClick = (event: Event) => {
		this.store?.selectInitiativeFromEvent(event);
	};

	protected onRootTabClick = (event: Event) => {
		const nextTab = (event.currentTarget as HTMLElement).dataset.tab as RootTab | undefined;
		if (!nextTab) {
			return;
		}

		this.store?.openRootTab(nextTab);
	};

	protected renderRootTab(tab: RootTab, label: string, count: number) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class=${`root-tab-button ${store.activeRootTab.get() === tab ? "active" : ""}`}
			data-tab=${tab}
			@click=${this.onRootTabClick}
		>
			<span>${label}</span>
			<span class="badge neutral">${count}</span>
		</button>
		`;
	}

	protected matchesEntity(entity: Entity, query: string) {
		if (query.length === 0) {
			return true;
		}

		return [entity.id, entity.kind, entity.status, entity.title].join(" ").toLowerCase().includes(query);
	}

	protected matchesBundle(bundle: InitiativeBundle, query: string) {
		if (query.length === 0) {
			return true;
		}

		const values = [
			bundle.initiative,
			...bundle.prds,
			...bundle.userStories,
			...bundle.adrs,
			...bundle.issues
		];

		return values.some((entity) => this.matchesEntity(entity, query));
	}

	protected renderInitiativeCard(bundle: InitiativeBundle) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const context = store.getContextForInitiative(bundle.initiative.id);

		return html`
		<button
			class="initiative-card"
			data-id=${bundle.initiative.id}
			@click=${this.onSelectInitiativeClick}
		>
			<div class="initiative-card-header">
				<div>
					<div class="section-label">Initiative</div>
					<h3>${store.shortRef(bundle.initiative)} ${bundle.initiative.title}</h3>
				</div>
				<span class=${`badge ${store.statusTone(bundle.initiative.status)}`}>${bundle.initiative.status}</span>
			</div>
			<div class="initiative-card-summary">${context?.context.summary ?? "No initiative-specific context is available yet."}</div>
			<div class="badge-row">
				<span class="badge neutral">PRDs ${bundle.prds.length}</span>
				<span class="badge neutral">Stories ${bundle.userStories.length}</span>
				<span class="badge neutral">ADRs ${bundle.adrs.length}</span>
				<span class="badge neutral">Issues ${bundle.issues.length}</span>
			</div>
		</button>
		`;
	}

	protected renderAdrCard(entity: Entity) {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		return html`
		<button
			class="entity-row-button"
			data-id=${entity.id}
			@click=${this.onSelectEntityClick}
		>
			<div class="issue-row-top">
				<div class="issue-row-title">${store.shortRef(entity)} ${entity.title}</div>
				<div class="badge-row">
					<span class="badge neutral">ADR</span>
					<span class=${`badge ${store.statusTone(entity.status)}`}>${entity.status}</span>
				</div>
			</div>
			<div class="issue-row-meta">
				<span class="list-meta">updated ${store.formatTimestamp(entity.updatedAt)}</span>
			</div>
		</button>
		`;
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

	render() {
		const store = this.store;
		if (!store) {
			return nothing;
		}

		const snapshot = store.snapshot.get();
		const search = store.search.get().trim().toLowerCase();
		const activeRootTab = store.activeRootTab.get();
		const counts = store.rootTabCounts.get();
		const visibleBundles = (snapshot?.initiatives ?? []).filter((bundle) => this.matchesBundle(bundle, search));
		const visibleAdrs = this.sortEntities((snapshot?.entities ?? []).filter((entity) => entity.kind === "adr" && this.matchesEntity(entity, search)));

		return html`
		<section class="list-page">
			<div class="list-header">
				<div>
					<div class="section-label">Workspace</div>
					<h2>Inventory</h2>
					<div class="section-copy">Search the current view, then open an initiative or ADR for detail.</div>
				</div>
				<div class="count-row">
					<span class="badge neutral">items ${activeRootTab === "initiatives" ? visibleBundles.length : visibleAdrs.length}</span>
				</div>
			</div>

			<div class="root-tab-row">
				${this.renderRootTab("initiatives", "Initiatives", counts.initiatives)}
				${this.renderRootTab("adrs", "ADRs", counts.adrs)}
			</div>

			<label class="search-card">
				<span class="meta-label">Search</span>
				<input
					type="search"
					placeholder=${activeRootTab === "initiatives" ? "Search initiatives, PRDs, stories, ADRs, and issues" : "Search ADRs"}
					.value=${store.search.get()}
					@input=${this.onSearchInput}
				/>
			</label>

			${choose(activeRootTab, [
				[
					"initiatives",
					() => html`
						<div class="card-grid">
							${when(
								visibleBundles.length > 0,
								() => repeat(visibleBundles, (bundle) => bundle.initiative.id, (bundle) => this.renderInitiativeCard(bundle)),
								() => html`<div class="empty-panel"><strong>No matches</strong><div class="empty-copy">Try a broader search to see more initiatives.</div></div>`
							)}
						</div>
					`
				],
				[
					"adrs",
					() => html`
						<div class="entity-list">
							${when(
								visibleAdrs.length > 0,
								() => repeat(visibleAdrs, (entity) => entity.id, (entity) => this.renderAdrCard(entity)),
								() => html`<div class="empty-panel"><strong>No ADRs found</strong><div class="empty-copy">Try a broader search to see more ADRs.</div></div>`
							)}
						</div>
					`
				]
			])}
		</section>
		`;
	}

	static styles = [
		issueBrowserTypographyStyles,
		issueBrowserControlStyles,
		css`
		:host {
			display: block;
		}
+
		.list-page {
			margin-top: 16px;
			display: grid;
			gap: 16px;
		}

		.list-header,
		.initiative-card-header,
		.issue-row-top {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			align-items: center;
		}

		.root-tab-row,
		.badge-row,
		.count-row,
		.issue-row-meta,
		.card-grid,
		.entity-list {
			display: flex;
			flex-wrap: wrap;
			gap: 12px;
			align-items: center;
		}

		.card-grid,
		.entity-list {
			display: grid;
			gap: 16px;
		}

		.card-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.search-card,
		.initiative-card,
		.entity-row-button {
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--surface);
		}

		.search-card {
			display: grid;
			gap: 12px;
			padding: 16px;
		}

		.root-tab-button {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 0;
			border: 0;
			background: transparent;
			cursor: pointer;
			color: var(--muted);
			font-weight: 600;
		}

		.root-tab-button.active {
			color: var(--text);
		}

		.root-tab-button.active .badge {
			border-color: rgba(9, 105, 218, 0.18);
			background: #ddf4ff;
			color: var(--accent);
		}

		.initiative-card,
		.entity-row-button {
			width: 100%;
			padding: 16px;
			display: grid;
			gap: 12px;
			text-align: left;
		}

		.initiative-card:hover,
		.entity-row-button:hover {
			border-color: rgba(9, 105, 218, 0.4);
			background: #f0f7ff;
		}

		.initiative-card h3,
		.issue-row-title {
			margin: 0;
			font-size: 0.95rem;
			font-weight: 600;
			line-height: 1.4;
		}

		.initiative-card-summary {
			color: var(--muted);
			font-size: 0.875rem;
			line-height: 1.5;
		}

		@media (max-width: 980px) {
			.card-grid {
				grid-template-columns: 1fr;
			}
		}

		@media (max-width: 800px) {
			.list-header,
			.initiative-card-header,
			.issue-row-top {
				flex-direction: column;
				align-items: stretch;
			}
		}
		`
	];
}

customElements.define("agent-issues-list-view", IssueListView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-list-view": IssueListView;
	}
}
