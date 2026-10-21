import { html, nothing, type PropertyValues } from 'lit';
import { choose } from 'lit/directives/choose.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';
import { Check, GitBranch, Plug, RefreshCw, Save, Search, Unplug } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import type { RepositoryModel } from './repository-header.js';

interface ProjectInformation {
	name: string;
	path: string;
	remote: string;
	branch: string;
	identity: string;
	tenant: string;
	purpose: string;
	architecture: string;
	instructions: string;
	graph: string;
	connected: boolean;
	graphVersion: number;
	publishedAt: string;
}

export class HarnessProjectControls extends LightElement {
	static override properties = {
		repository: { attribute: false },
		repositoryId: { attribute: false },
		section: { attribute: false },
	};

	constructor() {
		super();
		this.repository = undefined;
		this.repositoryId = '';
		this.section = 'details';
	}

	declare repository: RepositoryModel | undefined;
	declare repositoryId: string;
	declare section: string;
	protected records = new Map<string, { draft: ProjectInformation; saved: ProjectInformation }>();
	protected draft: ProjectInformation | undefined;
	protected status = 'Saved in this session';
	protected error = '';
	protected query = '';
	protected result = '';

	protected override willUpdate(changes: PropertyValues<this>) {
		if ((!changes.has('repository') && !changes.has('repositoryId')) || !this.repository || !this.repositoryId) return;
		const repository = this.repository;
		let record = this.records.get(this.repositoryId);
		if (!record) {
			const saved: ProjectInformation = {
				name: repository.name,
				path: repository.path,
				remote: '',
				branch: 'main',
				identity: repository.projectIdentity ?? '',
				tenant: repository.tenant,
				purpose: '',
				architecture: '',
				instructions: '',
				graph: '.agent-wayfinder/graph.db',
				connected: false,
				graphVersion: 0,
				publishedAt: '',
			};
			record = { saved, draft: structuredClone(saved) };
			this.records.set(this.repositoryId, record);
		}
		this.draft = record.draft;
		this.status = JSON.stringify(record.draft) === JSON.stringify(record.saved) ? 'Saved in this session' : 'Unsaved changes';
		this.query = '';
		this.result = '';
		this.error = '';
	}

	protected handleInput(event: Event) {
		const input = event.target as HTMLInputElement;
		this.error = '';
		if (input.name === 'query') this.query = input.value;
		else {
			const key = input.name as keyof Pick<ProjectInformation, 'name' | 'path' | 'remote' | 'branch' | 'identity' | 'tenant' | 'purpose' | 'architecture' | 'instructions' | 'graph'>;
			this.draft![key] = input.value;
			if (key === 'path' || key === 'graph') {
				this.draft!.connected = false;
				this.draft!.graphVersion = 0;
				this.draft!.publishedAt = '';
				this.result = '';
			}
			this.status = 'Unsaved changes';
		}
		this.requestUpdate();
	}

	protected handleSave(event: SubmitEvent) {
		event.preventDefault();
		const required = [
			{ key: 'name' as const, label: 'a display name', section: 'details' },
			{ key: 'path' as const, label: 'a local directory', section: 'details' },
			{ key: 'identity' as const, label: 'a project identity', section: 'details' },
			{ key: 'tenant' as const, label: 'a tenant', section: 'details' },
			{ key: 'graph' as const, label: 'a graph database path', section: 'wayfinder' },
		].find((field) => !this.draft![field.key].trim());
		if (required) {
			this.error = `Enter ${required.label}.`;
			this.section = required.section;
			this.dispatchEvent(new CustomEvent('harness-project-section-change', {
				bubbles: true,
				detail: { section: required.section },
			}));
			this.requestUpdate();
			return;
		}
		const form = event.currentTarget as HTMLFormElement;
		if (!form.reportValidity()) return;
		this.records.get(this.repositoryId)!.saved = structuredClone(this.draft!);
		this.error = '';
		this.status = 'Saved in this session';
		this.requestUpdate();
	}

	protected handleConnection() {
		this.draft!.connected = !this.draft!.connected;
		this.status = 'Unsaved changes';
		this.result = '';
		this.requestUpdate();
	}

	protected handleRefresh() {
		this.draft!.graphVersion += 1;
		this.draft!.publishedAt = new Date().toLocaleString();
		this.status = 'Unsaved changes';
		this.result = '';
		this.requestUpdate();
	}

	protected handleQuery() {
		this.result = `No live graph was queried. Example query: ${this.query.trim()}`;
		this.requestUpdate();
	}

	protected renderField(key: 'name' | 'path' | 'remote' | 'branch' | 'identity' | 'tenant' | 'graph', label: string) {
		return html`
		<label class="project-control-field">
			<span>${label}</span>
			<input
				name=${key}
				.value=${live(this.draft![key])}
				?required=${['name', 'path', 'identity', 'tenant', 'graph'].includes(key)}
			/>
		</label>
		`;
	}

	protected renderDetails() {
		return html`
		<section class="project-control-section">
			<h2>Repository</h2>
			<div class="project-control-fields">
				${this.renderField('name', 'Display name')}
				${this.renderField('branch', 'Default branch')}
				${this.renderField('path', 'Local directory')}
				${this.renderField('remote', 'Repository URL')}
			</div>
			<h2>Logbook</h2>
			<div class="project-control-fields">
				${this.renderField('identity', 'Project identity')}
				${this.renderField('tenant', 'Tenant')}
			</div>
		</section>
		`;
	}

	protected renderContext() {
		return html`
		<section class="project-control-section">
			<h2>Project context</h2>
			${repeat([
				{ key: 'purpose' as const, title: 'Purpose and scope', rows: 3 },
				{ key: 'architecture' as const, title: 'Architecture and dependencies', rows: 4 },
				{ key: 'instructions' as const, title: 'Working instructions', rows: 4 },
			], (field) => field.key, (field) => html`
			<label class="project-control-field">
				<span>${field.title}</span>
				<textarea
					name=${field.key}
					rows=${field.rows}
					.value=${live(this.draft![field.key])}
				></textarea>
			</label>
			`)}
		</section>
		`;
	}

	protected renderWayfinder() {
		const draft = this.draft!;
		return html`
		<section class="project-control-section">
			<div class="project-integration-heading">
				<h2>${renderIcon(GitBranch)}Agent Wayfinder</h2>
				<span class="project-simulation-label">Simulated connection</span>
			</div>
			<div class="project-connection-row">
				<span class="project-connection-state">${renderIcon(draft.connected ? Check : Unplug)}${draft.connected ? 'Connected / example' : 'Not connected'}</span>
				<button
					type="button"
					@click=${this.handleConnection}
				>${renderIcon(draft.connected ? Unplug : Plug)}${draft.connected ? 'Disconnect' : 'Connect'}</button>
			</div>
			${this.renderField('graph', 'Graph database / relative to local directory')}
			<dl class="project-graph-facts">
				<div><dt>Workspace</dt><dd>${draft.path}</dd></div>
				<div><dt>Graph version</dt><dd>${draft.graphVersion || 'No published graph'}</dd></div>
				<div><dt>Published</dt><dd>${draft.publishedAt || 'Not indexed'}</dd></div>
			</dl>
			<button
				type="button"
				?disabled=${!draft.connected}
				@click=${this.handleRefresh}
			>${renderIcon(RefreshCw)}Refresh example graph</button>
			<div class="project-graph-query">
				<label class="project-control-field">
					<span>Graph query</span>
					<input
						name="query"
						.value=${live(this.query)}
						?disabled=${!draft.connected || !draft.graphVersion}
					/>
				</label>
				<button
					type="button"
					?disabled=${!draft.connected || !draft.graphVersion || !this.query.trim()}
					@click=${this.handleQuery}
				>${renderIcon(Search)}Query example</button>
			</div>
			<div
				class="project-query-result"
				role="status"
			>${this.result}</div>
		</section>
		`;
	}

	protected override render() {
		if (!this.draft) return nothing;
		return html`
		<div class="project-controls">
			<form
				id=${`project-settings-${this.section}-panel`}
				role="tabpanel"
				aria-labelledby=${`project-settings-${this.section}-tab`}
				@input=${this.handleInput}
				@submit=${this.handleSave}
			>
				${choose(this.section, [
					['details', () => this.renderDetails()],
					['context', () => this.renderContext()],
					['wayfinder', () => this.renderWayfinder()],
				])}
				<p
					class="settings-error"
					role="alert"
					?hidden=${!this.error}
				>${this.error}</p>
				<div class="project-information-actions">
					<span role="status">${this.status}</span>
					<button
						class="primary"
						type="submit"
					>${renderIcon(Save)}Save project</button>
				</div>
			</form>
		</div>
		`;
	}
}

customElements.define('harness-project-controls', HarnessProjectControls);

declare global {
	interface HTMLElementTagNameMap {
		'harness-project-controls': HarnessProjectControls;
	}
	interface HTMLElementEventMap {
		'harness-project-section-change': CustomEvent<{ section: string }>;
	}
}