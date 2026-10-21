import { html, nothing, svg } from 'lit';
import { choose } from 'lit/directives/choose.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import {
	Bot,
	GitBranch,
	MessagesSquare,
	Minus,
	NotebookPen,
	Pause,
	Play,
	Plus,
	Scan,
	Send,
	User,
} from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

interface PlanningMessage {
	role: 'agent' | 'user';
	kind: string;
	paragraphs?: string[];
	answers?: { question: string; answer: string }[];
	records?: string[];
}

interface PlanningTicket {
	title: string;
	type: string;
	question: string;
	dependencies: number[];
	position: [number, number];
	status: string;
}

export interface PlanningWorkspaceModel {
	title: string;
	brief: string;
	initiativeTitle: string;
	mode: 'plan' | 'pioneer';
	view: 'session' | 'map';
	zoom: number;
	resolved: number;
	paused: boolean;
	messages: PlanningMessage[];
	drafts: Record<number, string>;
	questions: { index: number; title: string; question: string }[];
	questionCount: number;
	entries: { role: string; body: string }[];
	tickets: PlanningTicket[];
}

export class HarnessPlanningWorkspace extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: PlanningWorkspaceModel | undefined;

	protected renderConversation(model: PlanningWorkspaceModel) {
		const status = model.paused
			? 'Paused'
			: model.questions.length
				? 'Needs your answers'
				: 'Ready for your review';
		return html`
		<section
			class="planning-session"
			aria-label="Planning agent session"
		>
			<div class="planner-agent">
				<span>${renderIcon(Bot)}Planning agent / Copilot</span>
				<div>
					<span class=${`status ${model.questions.length ? 'waiting' : 'review'}`}
						>${status}</span
					>
					${when(
							model.questions.length,
							() => html`
							<button
								class="icon-button"
								data-action="planning-pause"
								title=${model.paused ? 'Resume planning' : 'Pause planning'}
								aria-label=${model.paused ? 'Resume planning' : 'Pause planning'}
							>
								${renderIcon(model.paused ? Play : Pause)}
							</button>
							`
						)}
				</div>
			</div>
			<ol
				class="planner-conversation"
				aria-label="Planning conversation"
			>
				${repeat(
						model.messages,
						(_message, index) => index,
						(message) => html`
						<li class=${`planner-message ${message.role}`}>
							<div class="planner-message-heading">
								<strong
									>${renderIcon(message.role === 'agent' ? Bot : User)}${message.role === 'agent'
											? 'Agent'
											: 'You'}</strong
								>
								<span>${message.kind}</span>
							</div>
							${repeat(
									message.paragraphs ?? [],
									(_paragraph, index) => index,
									(paragraph) => html`<p>${paragraph}</p>`
								)}
							${when(
									message.answers,
									() =>
										html`<dl>
										${repeat(
												message.answers!,
												(_answer, index) => index,
												(answer) =>
													html`<dt>${answer.question}</dt>
													<dd>${answer.answer}</dd>`
											)}
									</dl>`
								)}
							${when(
									message.records,
									() =>
										html`<ul class="planner-message-records">
										${repeat(
												message.records!,
												(_record, index) => index,
												(record) => html`<li>${record}</li>`
											)}
									</ul>`
								)}
						</li>
						`
					)}
			</ol>
			<div class="planner-question">
				${when(
						model.questions.length,
						() => html`
						<div class="planner-questions-heading">Questions <span>${model.questions.length}</span></div>
						<form
							data-form="planning-answer"
							data-mode=${model.mode}
						>
							${repeat(
									model.questions,
									(question) => question.index,
									(question, position) => html`
									<div class="planner-question-field">
										<span
											class="planner-question-number"
											aria-hidden="true"
										>${String(position + 1).padStart(2, '0')}</span>
										<div class="planner-question-prompt">
											<div class="eyebrow muted">
											${choose(model.mode, [
													['pioneer', () => question.title],
													['plan', () => `Question ${question.index + 1} / ${model.questionCount}`],
												])}
											</div>
											<h3 id=${`planning-question-${question.index}`}>
												<label for=${`planning-answer-${question.index}`}>${question.question}</label>
											</h3>
										</div>
										<div class="planner-answer">
											<textarea
											id=${`planning-answer-${question.index}`}
											data-planning-question=${question.index}
											name=${`answer-${question.index}`}
												rows="4"
											.value=${live(model.drafts[question.index] ?? '')}
											?disabled=${model.paused}
											required
											></textarea>
										</div>
									</div>
									`
								)}
							<button
								class="primary"
								?disabled=${model.paused}
							>
								${renderIcon(Send)}Send answers
							</button>
						</form>
						`,
						() =>
							html`<h3>
							${choose(model.mode, [
									['pioneer', () => 'Map decisions recorded'],
									['plan', () => 'Draft plan ready'],
								])}
						</h3>`
					)}
			</div>
		</section>
		`;
	}

	protected renderGraph(model: PlanningWorkspaceModel) {
		const edges = model.tickets.flatMap((ticket, index) =>
			ticket.dependencies.map((dependency) => {
				const source = model.tickets[dependency]!.position;
				const target = ticket.position;
				const sameRow = source[1] === target[1];
				const start = sameRow
					? [source[0] + 240, source[1] + 70]
					: [source[0] + 120, source[1] + 150];
				const end = sameRow ? [target[0], target[1] + 70] : [target[0] + 120, target[1]];
				const bend = (start[1]! + end[1]!) / 2;
				const path =
					sameRow && index === 2
						? `M ${source[0] + 120} ${source[1]} V 8 H ${target[0] + 120} V ${target[1]}`
						: sameRow
							? `M ${start.join(' ')} H ${end[0]}`
							: `M ${start.join(' ')} C ${start[0]} ${bend}, ${end[0]} ${bend}, ${end.join(' ')}`;
				return { dependency, index, path };
			})
		);
		return html`
		<div class="graph-toolbar">
			<span>${model.tickets.length} tickets / ${edges.length} dependencies</span>
			<div>
				<button
					class="icon-button"
					data-action="graph-out"
					title="Zoom out"
					aria-label="Zoom out"
				>
					${renderIcon(Minus)}
				</button>
				<output aria-label="Graph zoom">${Math.round(model.zoom * 100)}%</output>
				<button
					class="icon-button"
					data-action="graph-in"
					title="Zoom in"
					aria-label="Zoom in"
				>
					${renderIcon(Plus)}
				</button>
				<button
					class="icon-button"
					data-action="graph-fit"
					title="Fit graph"
					aria-label="Fit graph"
				>
					${renderIcon(Scan)}
				</button>
			</div>
		</div>
		<div
			class="pioneer-viewport"
			data-scroll-key="pioneer-graph"
			tabindex="0"
			aria-label="Pioneer issue graph"
		>
			<div
				class="pioneer-bounds"
				style=${`width:${900 * model.zoom}px;height:${640 * model.zoom}px`}
			>
				<div
					class="pioneer-canvas"
					style=${`transform:scale(${model.zoom})`}
				>
					<svg
						class="pioneer-edges"
						viewBox="0 0 900 640"
						aria-hidden="true"
					>
						<defs>
							<marker
								id="pioneer-arrow"
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="7"
								markerHeight="7"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" />
							</marker>
						</defs>
						${repeat(
								edges,
								(edge) => `${edge.dependency}-${edge.index}`,
								(edge) =>
									svg`<path d=${edge.path} data-source=${edge.dependency} data-target=${edge.index} marker-end="url(#pioneer-arrow)" />`
							)}
					</svg>
					${repeat(
							model.tickets,
							(_ticket, index) => index,
							(ticket, index) => html`
							<button
								class=${`pioneer-node ${ticket.status.toLowerCase()}`}
								style=${`left:${ticket.position[0]}px;top:${ticket.position[1]}px`}
								data-action="pioneer-ticket"
								data-index=${index}
							>
								<span class="route-issue-meta"
									><span class="mono">PIONEER-${String(index + 1).padStart(2, '0')}</span
									><span>${ticket.status}</span></span
								>
								<strong>${ticket.title}</strong><span>${ticket.type}</span
								><small>${ticket.question}</small>
							</button>
							`
						)}
				</div>
			</div>
		</div>
		`;
	}

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const pioneer = model.mode === 'pioneer';
		return html`
		<section class="planning-workspace">
			<div class="planning-heading">
				<div>
					<div class="eyebrow muted">Planning / simulated / ${model.initiativeTitle}</div>
					<h2 tabindex="-1">${model.title}</h2>
				</div>
				<span class="planning-modes"
					>${renderIcon(pioneer ? GitBranch : NotebookPen)}${choose(model.mode, [
							['pioneer', () => 'Pioneer'],
							['plan', () => 'Plan'],
						])}</span
				>
			</div>
			${when(
					pioneer,
					() => html`
					<div
						class="workspace-tabs"
						role="tablist"
						aria-label="Pioneer view"
					>
						${repeat(
								[
									{ view: 'session', title: 'Planning session', icon: MessagesSquare },
									{ view: 'map', title: 'Pioneer map', icon: GitBranch },
								],
								(tab) => tab.view,
								(tab) => html`
								<button
									id=${`pioneer-${tab.view}-tab`}
									role="tab"
									data-action="pioneer-view"
									data-view=${tab.view}
									aria-controls=${`pioneer-${tab.view}-panel`}
									aria-selected=${live(String(model.view === tab.view))}
									.tabIndex=${live(model.view === tab.view ? 0 : -1)}
								>
									${renderIcon(tab.icon)}${tab.title}
								</button>
								`
							)}
					</div>
					`
				)}
			<section
				id="pioneer-session-panel"
				role=${ifDefined(pioneer ? 'tabpanel' : undefined)}
				aria-labelledby=${ifDefined(pioneer ? 'pioneer-session-tab' : undefined)}
				data-pioneer-view="session"
				?hidden=${live(pioneer && model.view !== 'session')}
			>
				<div id="planning-session-content">${this.renderConversation(model)}</div>
			</section>
			<section
				id="pioneer-map-panel"
				role=${ifDefined(pioneer ? 'tabpanel' : undefined)}
				aria-labelledby=${ifDefined(pioneer ? 'pioneer-map-tab' : undefined)}
				data-planning-panel="pioneer"
				data-pioneer-view="map"
				?hidden=${live(!pioneer || model.view !== 'map')}
			>
				<div class="pioneer-map-summary">
					<div>
						<div class="eyebrow muted">Pioneer map / destination</div>
						<h3>${model.title}</h3>
						<p>${model.brief}</p>
					</div>
					<span>${model.resolved} / ${model.tickets.length} resolved</span>
				</div>
				<div id="pioneer-graph-content">${this.renderGraph(model)}</div>
			</section>
			<section
				data-planning-panel="plan"
				?hidden=${live(pioneer)}
			>
				<div id="single-plan-content">
					<div class="single-plan-heading">
						<div>
							<div class="eyebrow muted">Agent-authored plan / draft</div>
							<h2>${model.title}</h2>
						</div>
						<span>${model.entries.length} entries</span>
					</div>
					<ol class="plan-entries">
						${repeat(
								model.entries,
								(_entry, index) => index,
								(entry, index) =>
									html`<li class="plan-entry">
									<span class="plan-entry-number mono">${String(index + 1).padStart(2, '0')}</span
									><span><small>${entry.role}</small><span>${entry.body}</span></span>
								</li>`
							)}
					</ol>
				</div>
			</section>
		</section>
		`;
	}
}

customElements.define('harness-planning-workspace', HarnessPlanningWorkspace);

declare global {
	interface HTMLElementTagNameMap {
		'harness-planning-workspace': HarnessPlanningWorkspace;
	}
}
