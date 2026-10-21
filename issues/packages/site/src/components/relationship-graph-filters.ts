import { LitElement, css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { PROJECT_GRAPH_KINDS, type ProjectGraphKind } from "../models.js";

const GRAPH_KIND_DETAILS: Record<ProjectGraphKind, { color: string; label: string }> = {
	adr: { color: "var(--graph-adr)", label: "ADR" },
	debt: { color: "var(--graph-debt)", label: "Debt" },
	epic: { color: "var(--graph-epic)", label: "Epic" },
	initiative: { color: "var(--graph-initiative)", label: "Initiative" },
	issue: { color: "var(--graph-issue)", label: "Issue" },
	plan: { color: "var(--graph-adr)", label: "Plan" },
	prd: { color: "var(--success)", label: "PRD" },
	project: { color: "var(--graph-project)", label: "Project" },
	story: { color: "var(--graph-story)", label: "User story" }
};

class RelationshipGraphFilters extends LitElement {
	static properties = {
		kinds: { attribute: false },
		visibleKinds: { attribute: false }
	};

	public kinds: ProjectGraphKind[] = [...PROJECT_GRAPH_KINDS];
	public visibleKinds: ReadonlySet<ProjectGraphKind> = new Set(PROJECT_GRAPH_KINDS);

	protected onToggleKind = (event: Event) => {
		const kind = (event.currentTarget as HTMLElement).dataset.graphKind as ProjectGraphKind | undefined;
		if (!kind) {
			return;
		}

		this.dispatchEvent(
			new CustomEvent<{ kind: ProjectGraphKind }>("graph-kind-toggle", {
				bubbles: true,
				composed: true,
				detail: { kind }
			})
		);
	};

	protected toAriaBoolean(value: boolean): "true" | "false" {
		return value ? "true" : "false";
	}

	render() {
		return html`
		<div
			aria-label="Filter graph records"
			class="graph-kind-filters"
			role="group"
		>
			${repeat(
				this.kinds,
				(kind) => kind,
				(kind) => {
					const detail = GRAPH_KIND_DETAILS[kind];
					const isVisible = this.visibleKinds.has(kind);
					return html`
					<button
						aria-pressed=${this.toAriaBoolean(isVisible)}
						class=${classMap({ active: isVisible, "graph-kind-chip": true })}
						data-graph-kind=${kind}
						@click=${this.onToggleKind}
					>
						<span
							class="sw"
							style=${`background-color:${detail.color}`}
						></span>
						${detail.label}
					</button>
					`;
				}
			)}
		</div>
		`;
	}

	static styles = css`
	:host {
		display: contents;
	}
	.graph-kind-filters {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.graph-kind-chip {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--muted);
		cursor: pointer;
		font: inherit;
		font-size: 12px;
	}
	.graph-kind-chip.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 600;
	}
	.sw {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	`;
}

customElements.define("agent-issues-relationship-graph-filters", RelationshipGraphFilters);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-relationship-graph-filters": RelationshipGraphFilters;
	}
	interface HTMLElementEventMap {
		"graph-kind-toggle": CustomEvent<{ kind: ProjectGraphKind }>;
	}
}