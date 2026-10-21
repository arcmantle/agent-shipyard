import { html, nothing, type PropertyValues } from 'lit';
import { live } from 'lit/directives/live.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { Activity, NotebookPen } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import { type RepositoryModel } from './repository-header.js';
import { type TrackedRecordModel } from './tracked-record.js';
import './repository-header.js';
import './tracked-record.js';
import './usage-meter.js';

export interface SidebarModel {
	scope: string;
	page: string;
	repository: RepositoryModel;
	runLabel: string;
	integrated: boolean;
	question: boolean;
	limits: { copilot: number; interpreter: number };
	planningSessions?: { id: string; title: string; initiativeTitle: string; current: boolean }[];
	initiative?: {
		id: string;
		title: string;
		run: string;
		prds: { record: TrackedRecordModel; story: TrackedRecordModel; issues: TrackedRecordModel[] }[];
		adrs: TrackedRecordModel[];
	};
}

export class HarnessRepositorySidebar extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: SidebarModel | undefined;
	protected expanded = new Map<string, boolean>();

	protected override willUpdate(changed: PropertyValues<this>) {
		const previous = changed.get('model');
		if (previous && previous.scope !== this.model?.scope) {
			this.expanded.clear();
			return;
		}
		for (const details of this.querySelectorAll<HTMLDetailsElement>('[data-sidebar-group]')) {
			this.expanded.set(details.dataset.sidebarGroup!, details.open);
		}
	}

	protected renderRecord(record: TrackedRecordModel) {
		return html` <harness-tracked-record .record=${record}></harness-tracked-record> `;
	}

	protected renderTrackedWork(model: SidebarModel) {
		const initiative = model.initiative;
		if (!initiative)
			return html`
			<section>
				<h3>No initiatives</h3>
				<button
					data-action="page"
					data-page="planning"
				>
					${renderIcon(NotebookPen)}Start planning
				</button>
			</section>
			`;
		return html`
		<section class="initiative-navigation">
			<div class="initiative-context">
				<div class="eyebrow muted">Current initiative</div>
				<h3 class="initiative-current-title">${initiative.title}</h3>
			</div>
			<div class="scope-run">${initiative.run}</div>
			${when(
					initiative.id !== 'harness',
					() => html`
					<button
						class="active-run-link"
						data-action="active-run"
					>
						${renderIcon(Activity)}shipyard / ${model.runLabel}
					</button>
					`
				)}
			<nav
				class="tracked-work"
				aria-label="Initiative work"
			>
				<details
					data-sidebar-group="prds"
					.open=${live(this.expanded.get('prds') ?? true)}
				>
					<summary>PRDs / ${initiative.prds.length}</summary>
					${repeat(
							initiative.prds,
							(prd) => prd.record.index,
							(prd) => html`
							${this.renderRecord(prd.record)}
							<details
								class="story-group"
								data-sidebar-group=${`story-${prd.record.index}`}
								.open=${live(this.expanded.get(`story-${prd.record.index}`) ?? true)}
							>
								<summary>User story</summary>
								${this.renderRecord(prd.story)}
								<div class="issue-group">
									${repeat(
											prd.issues,
											(issue) => issue.index,
											(issue) => this.renderRecord(issue)
										)}
								</div>
							</details>
							`
						)}
				</details>
				<details
					data-sidebar-group="adrs"
					.open=${live(this.expanded.get('adrs') ?? false)}
				>
					<summary>ADRs / ${initiative.adrs.length}</summary>
					${repeat(
							initiative.adrs,
							(adr) => adr.index,
							(adr) => this.renderRecord(adr)
						)}
				</details>
			</nav>
		</section>
		`;
	}

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const browsing = model.initiative?.id !== 'harness';
		const queueStatus = model.integrated ? 'Integrated' : 'Awaiting approval';
		const decisionStatus = model.question ? 'Needs a decision' : 'In progress';
		return html`
		<div class="rail-project">
			<harness-repository-header
				.repository=${model.repository}
			></harness-repository-header>
		</div>
		<div
			class="sidebar-scope"
			data-sidebar-panel="workspace"
			.hidden=${live(model.page !== 'workspace')}
		>
			${this.renderTrackedWork(model)}
			${when(
					!browsing,
					() => html`
					<section class="review-queue">
						<div class="eyebrow muted">Integration queue</div>
						<div class="queue-row">
							<strong>Approval checkpoint</strong
							><span class="status review">${queueStatus}</span>
						</div>
						<div class="queue-row">
							<strong>Session recovery</strong><span class="muted">Independent review</span>
						</div>
						<div class="queue-row">
							<strong>Usage limits</strong><span class="muted">${decisionStatus}</span>
						</div>
					</section>
					<harness-usage-meter .limits=${model.limits}></harness-usage-meter>
					`
				)}
		</div>
		<section
			id="planning-sidebar-content"
			data-sidebar-panel="planning"
			.hidden=${live(model.page !== 'planning')}
		>
			<div class="eyebrow muted">Sessions</div>
			<div class="planning-session-list">
				${repeat(
						model.planningSessions ?? [],
						(session) => session.id,
						(session) => html`
						<button
							data-action="planning-session"
							data-id=${session.id}
							aria-current=${ifDefined(session.current ? 'true' : undefined)}
						>
							<strong>${session.title}</strong><span>${session.initiativeTitle}</span>
						</button>
						`
					)}
			</div>
			${when(
					!model.planningSessions?.length,
					() => html`<p class="muted planning-empty">No planning work.</p>`
				)}
		</section>
		`;
	}
}

customElements.define('harness-repository-sidebar', HarnessRepositorySidebar);

declare global {
	interface HTMLElementTagNameMap {
		'harness-repository-sidebar': HarnessRepositorySidebar;
	}
}
