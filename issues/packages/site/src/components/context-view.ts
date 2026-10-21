import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import type { ContextDetails, ContextTermRecord } from "../models.js";
import { issueBrowserTypographyStyles } from "../styles/issue-browser-shared-styles.js";

class ContextView extends LitElement {
	static properties = {
		context: { attribute: false },
		emptyMessage: { attribute: false },
		targetTerm: { attribute: false }
	};

	public context: ContextDetails | null = null;

	public emptyMessage = "No context has been defined yet.";

	public targetTerm: string | null = null;

	protected focusTargetTerm() {
		const elements = [...this.renderRoot.querySelectorAll<HTMLElement>(".term")];
		for (const element of elements) {
			element.classList.remove("is-context-term-target");
		}

		const target = elements.find((element) => element.dataset.term === this.targetTerm);
		if (!target) {
			return;
		}

		void target.offsetWidth;
		target.classList.add("is-context-term-target");
		target.focus({ preventScroll: true });
		if (typeof target.scrollIntoView === "function") {
			target.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}

	protected override updated() {
		this.focusTargetTerm();
	}

	protected renderTerm(term: ContextTermRecord) {
		return html`
		<div
			class="term"
			data-term=${term.term}
			tabindex="-1"
		>
			<div class="term-name">${term.term}</div>
			<p class="term-def">${term.definition}</p>
			${when(
				term.avoid.length > 0,
				() => html`
				<div class="avoid">
					<span class="avoid-label">Avoid</span>
					${repeat(term.avoid, (phrase) => phrase, (phrase) => html`<span class="avoid-chip">${phrase}</span>`)}
				</div>
				`,
				() => nothing
			)}
		</div>
		`;
	}

	render() {
		const details = this.context;
		const terms = details?.terms ?? [];
		const hasContent = Boolean(details?.context.summary?.trim()) || terms.length > 0;

		return html`
		<div class="context">
			${when(
				hasContent,
				() => html`
				<p class="summary">${details?.context.summary}</p>
				<div class="glossary-head">
					<span class="glossary-title">Glossary</span>
					<span class="glossary-count">${terms.length} ${when(terms.length === 1, () => html`term`, () => html`terms`)}</span>
				</div>
				${when(
					terms.length > 0,
					() => html`<div class="terms">${repeat(terms, (term) => term.term, (term) => this.renderTerm(term))}</div>`,
					() => html`<p class="empty">No glossary terms have been defined yet.</p>`
				)}
				`,
				() => html`<p class="empty">${this.emptyMessage}</p>`
			)}
		</div>
		`;
	}

	static styles = [
		issueBrowserTypographyStyles,
		css`
		:host {
			display: block;
		}
		.summary {
			max-width: 75ch;
			margin: 0;
			color: var(--text);
		}
		.glossary-head {
			display: flex;
			gap: 10px;
			align-items: baseline;
			margin-top: 22px;
		}
		.glossary-title {
			font-size: 16px;
			font-weight: 600;
		}
		.glossary-count {
			color: var(--muted);
			font-size: 12px;
		}
		.terms {
			display: grid;
			gap: 12px;
			margin-top: 12px;
		}
		.term {
			padding: 14px 16px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--surface);
		}
		.term:focus {
			outline: 2px solid var(--focus-ring);
			outline-offset: -2px;
		}
		.term.is-context-term-target {
			animation: context-term-target 1.8s ease-out;
		}
		@keyframes context-term-target {
			0% {
				background: var(--accent-soft);
				box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);
			}
			100% {
				background: var(--surface);
				box-shadow: 0 0 0 0 transparent;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.term.is-context-term-target {
				animation: none;
				outline: 2px solid var(--focus-ring);
			}
		}
		.term-name {
			font-weight: 600;
		}
		.term-def {
			max-width: 75ch;
			margin: 6px 0 0;
			color: var(--text);
		}
		.avoid {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			align-items: center;
			margin-top: 10px;
		}
		.avoid-label {
			color: var(--muted);
			font-size: 11px;
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}
		.avoid-chip {
			padding: 2px 8px;
			border: 1px solid var(--border);
			border-radius: 999px;
			background: var(--surface-muted);
			color: var(--muted);
			font-size: 12px;
		}
		.empty {
			margin: 0;
			color: var(--muted);
		}
		`
	];
}

customElements.define("agent-issues-context-view", ContextView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-context-view": ContextView;
	}
}
