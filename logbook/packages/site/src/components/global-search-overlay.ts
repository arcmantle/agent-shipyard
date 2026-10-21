import { SignalWatcher } from "@lit-labs/signals";
import { LitElement, css, html } from "lit";
import { choose } from "lit/directives/choose.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";
import type { SearchNavigationTarget, SearchResult, SearchSourceType } from "@agent-issues/core";
import type { AgentIssuesStore, GlobalSearchRecent } from "../services/agent-issues-store.js";

const SEARCH_SOURCE_ICONS: Record<SearchSourceType, string> = {
	"context-term": "T",
	context: "C",
	entity: "R",
	"issue-comment": "M",
	"plan-entry": "P"
};

const SEARCH_SOURCE_TYPE_OPTIONS: Array<{ label: string; value: SearchSourceType }> = [
	{ label: "Records", value: "entity" },
	{ label: "Context", value: "context" },
	{ label: "Terms", value: "context-term" },
	{ label: "Plan entries", value: "plan-entry" },
	{ label: "Comments", value: "issue-comment" }
];

const MAX_SEARCH_RESULTS = 20;

export type GlobalSearchOpenTargetDetail = {
	projectId: string | null;
	target: SearchNavigationTarget;
};

export class GlobalSearchOverlay extends SignalWatcher(LitElement) {
	public store: AgentIssuesStore | null = null;
	protected activeResultIndex = 0;
	protected syntaxHelpOpen = false;

	protected onInput = (event: Event) => {
		this.activeResultIndex = 0;
		this.store?.setGlobalSearchQuery((event.target as HTMLInputElement).value);
	};

	protected onScopeToggle = (event: Event) => {
		this.activeResultIndex = 0;
		this.store?.setGlobalSearchScope((event.target as HTMLInputElement).checked ? "all-projects" : "current-project");
	};

	protected onSourceTypeToggle = (event: Event) => {
		this.activeResultIndex = 0;
		const sourceType = (event.currentTarget as HTMLButtonElement).dataset.sourceType as SearchSourceType;
		const sourceTypes = this.store?.globalSearchSourceTypes.get() ?? [];
		const selectedSourceTypes = sourceTypes.includes(sourceType)
			? sourceTypes.filter((value) => value !== sourceType)
			: [...sourceTypes, sourceType];
		this.store?.setGlobalSearchSourceTypes(selectedSourceTypes);
	};

	protected onToggleSyntaxHelp = () => {
		this.syntaxHelpOpen = !this.syntaxHelpOpen;
		this.requestUpdate();
	};

	protected onResultClick = (event: Event) => {
		const resultIndex = Number((event.currentTarget as HTMLElement).dataset.resultIndex);
		const result = this.results[resultIndex];
		if (!result) {
			return;
		}

		this.openResult(result.navigationTarget, result.projectId);
	};

	protected onRecentClick = (event: Event) => {
		const recentIndex = Number((event.currentTarget as HTMLElement).dataset.recentIndex);
		const recent = this.recents[recentIndex];
		if (!recent) {
			return;
		}

		this.openResult(recent.target, this.store?.selectedProjectId.get() ?? null);
	};

	protected onRetry = () => {
		this.dispatchEvent(new CustomEvent("global-search-retry", { bubbles: true, composed: true }));
	};

	protected onBackdropPointerDown = (event: PointerEvent) => {
		if (event.target === event.currentTarget) {
			this.close();
		}
	};

	protected onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.close();
			return;
		}

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (this.results.length === 0) {
				return;
			}

			event.preventDefault();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			this.activeResultIndex = (this.activeResultIndex + direction + this.results.length) % this.results.length;
			this.requestUpdate();
			return;
		}

		if (event.key === "Enter") {
			const result = this.results[this.activeResultIndex];
			if (!result) {
				return;
			}

			event.preventDefault();
			this.openResult(result.navigationTarget, result.projectId);
			return;
		}

		if (event.key !== "Tab") {
			return;
		}

		const focusable = [...this.renderRoot.querySelectorAll<HTMLElement>("button, input, select, [tabindex]:not([tabindex='-1'])")]
			.filter((element) => !element.hasAttribute("disabled"));
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) {
			return;
		}

		if (event.shiftKey && this.shadowRoot?.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && this.shadowRoot?.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	protected onWindowKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
		}
	};

	public focusInput() {
		this.renderRoot.querySelector<HTMLInputElement>("input")?.focus();
	}

	public override connectedCallback() {
		super.connectedCallback();
		window.addEventListener("keydown", this.onWindowKeyDown);
	}

	public override disconnectedCallback() {
		window.removeEventListener("keydown", this.onWindowKeyDown);
		super.disconnectedCallback();
	}

	protected get results(): SearchResult[] {
		const response = this.store?.globalSearchResponse.get();
		return response?.state === "available" ? response.results : this.store?.globalSearchResults.get() ?? [];
	}

	protected get recents(): GlobalSearchRecent[] {
		return this.store?.globalSearchRecentRecords.get() ?? [];
	}

	protected openResult(target: SearchNavigationTarget, projectId: string | null) {
		this.dispatchEvent(new CustomEvent<GlobalSearchOpenTargetDetail>("global-search-open-target", {
			bubbles: true,
			composed: true,
			detail: { projectId, target }
		}));
	}

	protected close() {
		this.dispatchEvent(new CustomEvent("global-search-close", { bubbles: true, composed: true }));
	}

	protected renderSnippet(result: SearchResult) {
		const snippet = result.snippet;
		if (!snippet) {
			return "";
		}

		const fragments = [];
		let position = 0;
		for (const highlight of snippet.highlights) {
			fragments.push(snippet.text.slice(position, highlight.start));
			fragments.push(html`<mark>${snippet.text.slice(highlight.start, highlight.end)}</mark>`);
			position = highlight.end;
		}
		fragments.push(snippet.text.slice(position));
		return fragments;
	}

	protected renderResult(result: SearchResult, index: number) {
		const active = index === this.activeResultIndex;
		return html`
		<button
			aria-selected=${when(active, () => "true", () => "false")}
			class="result"
			data-result-index=${index}
			role="option"
			type="button"
			@click=${this.onResultClick}
		>
			<span aria-hidden="true" class="result-icon">${SEARCH_SOURCE_ICONS[result.identity.sourceType]}</span>
			<span class="result-content">
				<span class="result-heading">${result.title}</span>
				<span class="result-meta">${result.identity.shortReference} · ${result.match.field}${when(result.statusOrRole, () => html` · ${result.statusOrRole}`, () => "")}</span>
				<span class="result-owner">${result.projectLabel}${when(result.parentLabel, () => html` / ${result.parentLabel}`, () => "")}</span>
				${when(result.snippet, () => html`<span class="result-snippet">${this.renderSnippet(result)}</span>`, () => "")}
			</span>
		</button>
		`;
	}

	protected renderRecent(recent: GlobalSearchRecent, index: number) {
		return html`
		<button
			class="recent"
			data-recent-index=${index}
			type="button"
			@click=${this.onRecentClick}
		>
			<span aria-hidden="true" class="result-icon">${SEARCH_SOURCE_ICONS[recent.sourceType]}</span>
			<span class="recent-title">${recent.title}</span>
		</button>
		`;
	}

	protected renderSourceTypeOption(option: { label: string; value: SearchSourceType }) {
		const selected = this.store?.globalSearchSourceTypes.get().includes(option.value) ?? false;
		return html`
		<button
			aria-pressed=${when(selected, () => "true", () => "false")}
			class="source-type-chip"
			data-source-type=${option.value}
			type="button"
			@click=${this.onSourceTypeToggle}
		>
			${option.label}
		</button>
		`;
	}

	protected renderResultState() {
		const response = this.store?.globalSearchResponse.get();
		if (response?.state === "parse-error") {
			return html`<p aria-live="polite" class="result-state">${response.error.message} At character ${response.error.start + 1}.</p>`;
		}

		return choose(response?.state, [
			["available", () => when(this.results.length === 0, () => html`<p class="result-state">No matching records</p>`, () => "")],
			["operational-error", () => html`
				<div class="result-state">
					<p>Unable to search records</p>
					<button class="retry" type="button" @click=${this.onRetry}>Retry</button>
				</div>
			`]
		], () => "");
	}

	protected override firstUpdated() {
		this.focusInput();
	}

	override render() {
		return html`
		<div class="backdrop" @pointerdown=${this.onBackdropPointerDown}>
		<div
			aria-label="Global search"
			aria-modal="true"
			class="dialog"
			role="dialog"
			@keydown=${this.onKeyDown}
		>
			<div class="search-heading">
				<label class="search-label" for="global-search-input">Search records</label>
			</div>
			<div class="search-input-row">
				<input
					autocomplete="off"
					id="global-search-input"
					placeholder="Search this project"
					.value=${this.store?.globalSearchQuery.get() ?? ""}
					@input=${this.onInput}
				/>
				<button
					aria-expanded=${when(this.syntaxHelpOpen, () => "true", () => "false")}
					aria-label="Show search syntax help"
					class="syntax-help-toggle"
					data-global-search-help
					title="Search syntax help"
					type="button"
					@click=${this.onToggleSyntaxHelp}
				>
					?
				</button>
			</div>
			${when(
				this.syntaxHelpOpen,
				() => html`
				<section class="syntax-help" aria-label="Search syntax help">
					<p>Use quotes for phrases and a trailing * for prefixes.</p>
					<p>Combine terms with AND, OR, NOT, parentheses, and NEAR.</p>
				</section>
				`,
				() => ""
			)}
			${when(
				!this.store?.globalSearchQuery.get().trim(),
				() => html`<p class="syntax-hint">Use quotes for phrases or * for a prefix.</p>`,
				() => ""
			)}
			<div class="search-controls">
				<label class="scope-toggle">
					<input
						data-global-search-scope
						type="checkbox"
						.checked=${this.store?.globalSearchScope.get() === "all-projects"}
						@change=${this.onScopeToggle}
					/>
					<span>All projects</span>
				</label>
				<div aria-label="Record types" class="source-type-chips">
					${map(SEARCH_SOURCE_TYPE_OPTIONS, (option) => this.renderSourceTypeOption(option))}
				</div>
			</div>
			<div aria-live="polite" class="result-count">
				${this.results.length} result${when(this.results.length === 1, () => "", () => "s")}
			</div>
			<div aria-label="Search results" class="results" role="listbox">
				${map(this.results.slice(0, MAX_SEARCH_RESULTS), (result, index) => this.renderResult(result, index))}
				${when(this.results.length > MAX_SEARCH_RESULTS, () => html`<p class="result-state">Refine the query to narrow the results.</p>`, () => "")}
				${this.renderResultState()}
				${when(
					!this.store?.globalSearchQuery.get().trim() && this.recents.length > 0,
					() => html`
					<section class="recents" aria-label="Recently opened">
						<h2>Recently opened</h2>
						${map(this.recents, (recent, index) => this.renderRecent(recent, index))}
					</section>
					`,
					() => ""
				)}
			</div>
		</div>
		</div>
		`;
	}

	static styles = css`
	:host {
		position: fixed;
		z-index: 50;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.backdrop {
		box-sizing: border-box;
		display: grid;
		min-height: 0;
		width: 100%;
		height: 100%;
		place-items: start center;
		padding: 12vh 16px 16px;
		overflow: hidden;
		background: rgba(31, 35, 40, 0.45);
	}
	.dialog {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		min-height: 0;
		width: min(640px, 100%);
		max-height: 100%;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		box-shadow: 0 20px 50px var(--shadow);
	}
	.search-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.search-label {
		font-size: 13px;
		font-weight: 600;
	}
	.search-input-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.syntax-help-toggle {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.syntax-help {
		margin-top: 8px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface-muted);
		color: var(--text-muted);
		font-size: 12px;
	}
	.syntax-help p,
	.syntax-hint {
		margin: 0;
	}
	.syntax-help p + p {
		margin-top: 4px;
	}
	.syntax-hint {
		margin-top: 8px;
		color: var(--text-muted);
		font-size: 12px;
	}
	.search-input-row input {
		box-sizing: border-box;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-muted);
		color: var(--text);
		font: inherit;
	}
	.search-controls {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		margin-top: 12px;
	}
	.scope-toggle {
		display: flex;
		flex: 0 0 auto;
		gap: 6px;
		align-items: center;
		color: var(--text-muted);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
	}
	.scope-toggle input {
		position: relative;
		box-sizing: border-box;
		width: 28px;
		height: 16px;
		margin: 0;
		border: 1px solid var(--border);
		border-radius: 999px;
		appearance: none;
		background: var(--surface-muted);
		cursor: pointer;
	}
	.scope-toggle input::after {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--text-muted);
		content: "";
		transition: transform 120ms ease, background-color 120ms ease;
	}
	.scope-toggle input:checked {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.scope-toggle input:checked::after {
		background: var(--accent);
		transform: translateX(12px);
	}
	.scope-toggle input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.source-type-chips {
		display: flex;
		flex: 1 1 320px;
		flex-wrap: wrap;
		gap: 4px;
	}
	.source-type-chip {
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface-muted);
		color: var(--text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.source-type-chip[aria-pressed="true"] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}
	.result-count {
		margin-top: 12px;
		color: var(--text-muted);
		font-size: 12px;
	}
	.results {
		display: grid;
		gap: 4px;
		min-height: 0;
		margin-top: 8px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.result {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 8px;
		width: 100%;
		padding: 10px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.result[aria-selected="true"],
	.result:hover {
		border-color: var(--border);
		background: var(--surface-muted);
	}
	.result-icon {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
		border-radius: 4px;
		background: var(--border);
		font-size: 12px;
		font-weight: 700;
	}
	.result-content {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.recents {
		display: grid;
		gap: 4px;
		margin-top: 12px;
	}
	.recents h2 {
		margin: 0 0 4px;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 600;
	}
	.recent {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.recent:hover {
		border-color: var(--border);
		background: var(--surface-muted);
	}
	.recent-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.result-heading,
	.result-meta,
	.result-owner,
	.result-snippet {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.result-heading {
		font-weight: 600;
	}
	.result-meta,
	.result-owner,
	.result-snippet {
		color: var(--text-muted);
		font-size: 12px;
	}
	.result-state {
		margin: 0;
		padding: 12px 10px;
		color: var(--text-muted);
		font-size: 13px;
	}
	.result-state[aria-live] {
		color: var(--danger);
	}
	.retry {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	mark {
		padding: 0;
		background: var(--warning-soft);
		color: inherit;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-global-search-overlay": GlobalSearchOverlay;
	}
	interface HTMLElementEventMap {
		"global-search-open-target": CustomEvent<GlobalSearchOpenTargetDetail>;
		"global-search-retry": CustomEvent;
	}
}

customElements.define("agent-issues-global-search-overlay", GlobalSearchOverlay);