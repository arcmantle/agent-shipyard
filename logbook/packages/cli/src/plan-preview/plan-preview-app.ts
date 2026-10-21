import { css, html, LitElement, nothing } from "lit";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { when } from "lit/directives/when.js";

import type { ProposedPlan } from "@agent-issues/core";

export type PlanPreview = ProposedPlan & { status: string; revision: number };

export class PlanPreviewApp extends LitElement {
	static properties = {
		plan: { attribute: false },
		expanded: { type: Boolean },
		openLink: { attribute: false },
		errorMessage: { attribute: false },
		retryAction: { attribute: false }
	};

	constructor() {
		super();
		this.expanded = false;
	}

	declare public plan: PlanPreview | null;
	declare public expanded: boolean;
	declare public openLink: ((url: string) => Promise<void>) | undefined;
	declare public errorMessage: string | null;
	declare public retryAction: (() => Promise<void>) | undefined;

	protected handleToggle(): void {
		this.expanded = !this.expanded;
	}

	protected async onRetry(): Promise<void> {
		await this.retryAction?.();
	}

	protected async onMarkdownClick(event: MouseEvent): Promise<void> {
		const target = event.target;
		if (!(target instanceof HTMLAnchorElement)) {
			return;
		}

		event.preventDefault();
		const url = target.getAttribute("href");
		if (url) {
			await this.openLink?.(url);
		}
	}

	public render() {
		const plan = this.plan;
		return html`
		<main class="workspace">
			${when(
				plan,
				(currentPlan) => html`
					<header class="plan-header">
						<div class="header-label">
							<span class="header-mark" aria-hidden="true"></span>
							Plan review
						</div>
						<p class="reference">${currentPlan.reference}</p>
						<p data-revision="plan">Revision ${currentPlan.revision}</p>
						<h1>${currentPlan.title}</h1>
					</header>
					<button
						data-action="toggle"
						aria-expanded=${String(this.expanded)}
						@click=${this.handleToggle}
					>
					${when(this.expanded, () => "Hide plan details", () => "Show plan details")}
					</button>
					${when(
						this.expanded,
						() => html`
					<section class="summary-card goal-card" data-section="goal">
						<p class="section-label">Goal</p>
						${this.renderMarkdown(currentPlan.goal, "No Goal has been recorded.")}
					</section>
					<section class="summary-card context-card" data-section="context">
						<p class="section-label">Context</p>
						${this.renderMarkdown(currentPlan.context, "No Context has been recorded.")}
					</section>
					<div class="section-heading">
						<h2>Plan details</h2>
						<span>${currentPlan.current.length} groups</span>
					</div>
					${repeat(
						currentPlan.current,
						(group) => group.key,
						(group) => html`
							<section class="entry-group" data-group=${group.key}>
								<div class="group-heading">
									<h3>${group.title}</h3>
									<span>${group.entries.length}</span>
								</div>
								<ul>
									${repeat(
										group.entries,
										(entry) => entry.id,
										(entry) => html`
											<li>
												${this.renderMarkdown(entry.body ?? "", "")}
											</li>
										`
									)}
								</ul>
							</section>
						`
					)}
					${when(
						this.errorMessage,
						(message) => html`
							<aside role="alert">
								${message}
								<button
									data-action="retry"
									@click=${this.onRetry}
								>
								Retry
								</button>
							</aside>
						`,
						() => nothing
					)}
					${when(
						currentPlan.status === "ready",
						() => html`<p data-state="ready" role="status"><span aria-hidden="true">&#10003;</span> Plan ready</p>`,
						() => nothing
					)}
						`,
						() => nothing
					)}
				`,
				() => html`<p class="loading" role="status">Loading Plan Preview.</p>`
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
		background-color: #f6f2e9;
		background-image: linear-gradient(90deg, rgb(31 107 99 / 5%) 1px, transparent 1px), linear-gradient(rgb(31 107 99 / 5%) 1px, transparent 1px);
		background-size: 28px 28px;
		box-sizing: border-box;
		line-height: 1.6;
		margin: 0 auto;
		max-width: 820px;
		min-height: 100vh;
		padding: 40px;
	}
	.plan-header {
		border-bottom: 1px solid #bdcbc3;
		margin-bottom: 24px;
		padding: 4px 0 28px;
	}
	.header-label {
		align-items: center;
		color: #1f6b63;
		display: flex;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 12px;
		font-weight: 700;
		gap: 8px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.header-mark {
		background: #f0674f;
		display: inline-block;
		height: 10px;
		transform: rotate(45deg);
		width: 10px;
	}
	.reference {
		color: #63736d;
		font-family: var(--mcp-monospace-font-family, monospace);
		font-size: 12px;
		margin: 24px 0 8px;
	}
	h1 {
		color: #173d3a;
		font-size: 32px;
		font-weight: 700;
		letter-spacing: 0;
		line-height: 1.12;
		margin: 0;
	}
	.summary-card {
		border-left: 5px solid;
		box-sizing: border-box;
		margin-top: 16px;
		padding: 20px 24px;
	}
	.goal-card {
		background: #dcefe5;
		border-color: #1f6b63;
	}
	.context-card {
		background: #fbe2c8;
		border-color: #e2754f;
	}
	.section-label {
		color: #1d4f4a;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.08em;
		margin: 0 0 8px;
		text-transform: uppercase;
	}
	.context-card .section-label {
		color: #8a3f2b;
	}
	.section-heading {
		align-items: baseline;
		display: flex;
		justify-content: space-between;
		margin: 36px 0 12px;
	}
	h2 {
		color: #173d3a;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 18px;
		font-weight: 700;
		letter-spacing: 0;
		margin: 0;
	}
	.section-heading span {
		color: #63736d;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 12px;
		font-weight: 600;
	}
	.entry-group {
		background: #fffdf8;
		border: 1px solid #d8d2c5;
		border-radius: 6px;
		box-shadow: 0 3px 0 rgb(23 61 58 / 9%);
		margin-top: 14px;
		overflow: hidden;
	}
	.group-heading {
		align-items: center;
		background: #e9eee8;
		display: flex;
		justify-content: space-between;
		padding: 12px 18px;
	}
	h3 {
		color: #173d3a;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0;
		margin: 0;
	}
	.group-heading span {
		align-items: center;
		background: #1f6b63;
		border-radius: 50%;
		color: #ffffff;
		display: inline-flex;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 12px;
		font-weight: 700;
		height: 22px;
		justify-content: center;
		min-width: 22px;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 4px 18px;
	}
	li {
		border-top: 1px solid #e5e0d5;
		padding: 16px 0 16px 20px;
		position: relative;
	}
	li::before {
		background: #f0674f;
		border-radius: 50%;
		content: "";
		height: 7px;
		left: 2px;
		position: absolute;
		top: 27px;
		width: 7px;
	}
	li:first-child {
		border-top: 0;
	}
	.markdown > :first-child {
		margin-top: 0;
	}
	.markdown > :last-child {
		margin-bottom: 0;
	}
	.markdown a {
		color: #12645c;
		font-weight: 700;
	}
	.markdown code {
		background: #e4ebe6;
		border-radius: 3px;
		font-family: var(--mcp-monospace-font-family, monospace);
		font-size: 0.9em;
		padding: 2px 4px;
	}
	.loading {
		color: #63736d;
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
	aside {
		background: #fde7e0;
		border-left: 5px solid #b94635;
		margin-top: 20px;
		padding: 14px 16px;
	}
	aside button {
		background: transparent;
		margin-left: 12px;
	}
	[data-state="ready"] {
		background: #dcefe5;
		border: 1px solid #81ac9b;
		color: #1b5b49;
		font-family: var(--mcp-ui-font-family, ui-sans-serif, sans-serif);
		font-size: 14px;
		font-weight: 700;
		margin: 28px 0 0;
		padding: 14px 16px;
	}
	[data-state="ready"] span {
		margin-right: 8px;
	}
	@media (max-width: 600px) {
		.workspace {
			padding: 24px 18px;
		}
		h1 {
			font-size: 26px;
		}
		button {
			width: 100%;
		}
	}
	`;

	protected renderMarkdown(markdown: string, emptyMessage: string) {
		if (!markdown) {
			return emptyMessage ? html`<p class="empty">${emptyMessage}</p>` : nothing;
		}

		const htmlContent = marked.parse(markdown.replace(/<script[\s\S]*?<\/script>/gi, ""), { async: false });
		const sanitized = DOMPurify.sanitize(htmlContent, { FORBID_TAGS: ["script", "iframe", "object"] })
			.replace(/<script[\s\S]*?<\/script>/gi, "");
		return html`
		<div
			class="markdown"
			@click=${this.onMarkdownClick}
		>
		${unsafeHTML(sanitized)}
		</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"plan-preview-app": PlanPreviewApp;
	}
}

customElements.define("plan-preview-app", PlanPreviewApp);