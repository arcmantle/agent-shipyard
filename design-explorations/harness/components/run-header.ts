import { html, nothing } from 'lit';
import { when } from 'lit/directives/when.js';
import { ArrowLeft, MessageSquare, MessageSquarePlus } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';
import './run-controls.js';
import './status-badge.js';

export interface RunHeaderModel {
	title: string;
	brand: boolean;
	browsing: boolean;
	mode: string;
	label: string;
	agentStatus: string;
}

export class HarnessRunHeader extends LightElement {
	static override properties = { model: { attribute: false } };

	constructor() {
		super();
		this.model = undefined;
	}

	declare model: RunHeaderModel | undefined;

	protected override render() {
		const model = this.model;
		if (!model) return nothing;
		const status = { tone: model.mode, label: model.label, detail: 'Run 004' };
		return html`
		<header class="run-header">
			<div>
				${when(model.brand, () => html` <div class="brand">Shipyard / Helm</div> `)}
				<h1>${model.title}</h1>
				<div class="run-subtitle">
					${when(
							model.browsing,
							() => html` <span>No active run</span><span>Read-only view</span> `,
							() => html`
							<harness-status-badge .status=${status}></harness-status-badge>
							<span class="mono">harness/initiative</span><span>Run 004</span>
							`
						)}
				</div>
			</div>
			${when(
					model.browsing,
					() => html`
					<button data-action="active-run">
						${renderIcon(ArrowLeft)}shipyard / ${model.label}
					</button>
					`,
					() => html`
					<div class="run-actions">
						<button
							data-action="run-agent"
							aria-controls="run-inbox"
							aria-label="Run agent"
							title=${`Run agent / ${model.agentStatus}`}
						>
							${renderIcon(MessageSquare)}Run agent
						</button>
						<button data-action="request-change">
							${renderIcon(MessageSquarePlus)}Request change
						</button>
						<harness-run-controls .mode=${model.mode}></harness-run-controls>
					</div>
					`
				)}
		</header>
		`;
	}
}

customElements.define('harness-run-header', HarnessRunHeader);

declare global {
	interface HTMLElementTagNameMap {
		'harness-run-header': HarnessRunHeader;
	}
}
