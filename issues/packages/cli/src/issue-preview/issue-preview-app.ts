import { css, html, LitElement, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";

import type { IssueBreakdownDraft, IssueBreakdownRelationReference, ProposedIssueSpecification } from "@agent-issues/core";

export class IssuePreviewApp extends LitElement {
	static properties = {
		draft: { attribute: false },
		expanded: { type: Boolean },
		errorMessage: { attribute: false },
		retryAction: { attribute: false }
	};

	constructor() {
		super();
		this.expanded = false;
	}

	declare public draft: IssueBreakdownDraft | null;
	declare public expanded: boolean;
	declare public errorMessage: string | null;
	declare public retryAction: (() => Promise<void>) | undefined;

	protected handleToggle(): void {
		this.expanded = !this.expanded;
	}

	protected async onReload(): Promise<void> {
		await this.retryAction?.();
	}

	public render() {
		const draft = this.draft;
		return html`
		<main class="workspace">
			<header>
				<p class="label">Issue review</p>
				<h1>Issue breakdown</h1>
			</header>
			${when(
				draft,
				(currentDraft) => html`
					<button
						data-action="toggle"
						aria-expanded=${String(this.expanded)}
						@click=${this.handleToggle}
					>
					${when(this.expanded, () => "Hide issue breakdown", () => "Show issue breakdown")}
					</button>
					${when(
						this.expanded,
						() => html`
					<p class="reference">${currentDraft.targetReference}</p>
					<ol>
						${repeat(currentDraft.issues, (issue) => issue.key, (issue) => this.renderIssue(issue))}
					</ol>
					${when(
						this.errorMessage,
						(message) => html`
							<aside role="alert">
								${message}
								<button data-action="reload" @click=${this.onReload}>Reload</button>
							</aside>
						`,
						() => nothing
					)}
					${when(
						currentDraft.status === "approved",
						() => html`<p data-state="approved" role="status">Issue breakdown approved</p>`,
						() => nothing
					)}
					`,
					() => nothing
					)}
				`
				,
				() => html`<p role="status">Loading Issue Preview.</p>`
			)}
		</main>
		`;
	}

	public static styles = css`
	:host {
		color: #1d2d2e;
		display: block;
		font-family: var(--mcp-font-family, Georgia, serif);
	}
	.workspace {
		background: #f6f2e9;
		box-sizing: border-box;
		margin: 0 auto;
		max-width: 820px;
		min-height: 100vh;
		padding: 40px;
	}
	.label,
	.reference,
	dt {
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
	}
	.label {
		color: #1f6b63;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	h1 {
		color: #173d3a;
		font-size: 32px;
		letter-spacing: 0;
		margin: 0;
	}
	.reference {
		color: #63736d;
		font-size: 12px;
	}
	ol {
		list-style: none;
		margin: 24px 0 0;
		padding: 0;
	}
	ol > li {
		background: #fffdf8;
		border: 1px solid #d8d2c5;
		border-radius: 6px;
		margin-top: 14px;
		padding: 20px;
	}
	dl li {
		margin-top: 4px;
	}
	h2 {
		color: #173d3a;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 18px;
		letter-spacing: 0;
		margin: 0;
	}
	dl {
		margin: 16px 0 0;
	}
	dt {
		color: #1d4f4a;
		font-size: 12px;
		font-weight: 700;
		margin-top: 12px;
	}
	dd {
		margin: 4px 0 0;
	}
	ul {
		margin: 4px 0 0;
		padding-left: 20px;
	}
	button {
		border: 1px solid #476b65;
		border-radius: 4px;
		cursor: pointer;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 14px;
		font-weight: 700;
		padding: 10px 16px;
	}
	button:focus-visible {
		outline: 3px solid #efaa51;
		outline-offset: 2px;
	}
	[data-action="toggle"],
	[data-action="reload"] {
		background: #fffdf8;
		color: #173d3a;
	}
	aside {
		background: #fde7e0;
		border-left: 5px solid #b94635;
		margin-top: 20px;
		padding: 14px 16px;
	}
	aside button {
		margin-left: 12px;
	}
	`;

	protected renderIssue(issue: ProposedIssueSpecification) {
		return html`
		<li data-issue=${issue.key}>
			<h2>${issue.title}</h2>
			<dl>
				<dt>Outcome</dt>
				<dd>${issue.outcome}</dd>
				<dt>Scope</dt>
				<dd>
					<ul>
						${repeat(issue.scope, (scopeItem) => scopeItem, (scopeItem) => html`<li>${scopeItem}</li>`)}
					</ul>
				</dd>
				<dt>Work mode</dt>
				<dd>${issue.workMode}</dd>
				<dt>Acceptance criteria</dt>
				<dd>
					<ul>
						${repeat(issue.acceptanceCriteria, (criterion) => criterion, (criterion) => html`<li>${criterion}</li>`)}
					</ul>
				</dd>
				${when(
					issue.parentKey,
					(parentKey) => html`<dt>Parent</dt><dd>Parent: ${parentKey}</dd>`,
					() => nothing
				)}
				${when(
					issue.planEntryIds?.length,
					() => html`
						<dt>Plan entries</dt>
						<dd>
							<ul>
								${repeat(
									issue.planEntryIds ?? [],
									(entryId) => entryId, (entryId) => html`<li>${entryId}</li>`
								)}
							</ul>
						</dd>
					`,
					() => nothing
				)}
				${when(
					issue.relationReferences.length > 0,
					() => html`
						<dt>Relations</dt>
						<dd>
							<ul>
								${repeat(issue.relationReferences, (relation) => this.relationKey(relation), (relation) => html`<li>${this.relationText(relation)}</li>`)}
							</ul>
						</dd>
					`,
					() => nothing
				)}
			</dl>
		</li>
		`;
	}

	protected relationKey(relation: IssueBreakdownRelationReference): string {
		return `${relation.relationType}:${relation.targetKey ?? relation.targetReference ?? relation.targetId ?? ""}`;
	}

	protected relationText(relation: IssueBreakdownRelationReference): string {
		return `${relation.relationType}: ${relation.targetKey ?? relation.targetReference ?? relation.targetId ?? "Unknown target"}`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"issue-preview-app": IssuePreviewApp;
	}
}

customElements.define("issue-preview-app", IssuePreviewApp);