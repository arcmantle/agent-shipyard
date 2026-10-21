import { html } from 'lit';
import { SlidersHorizontal } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export class HarnessUsageMeter extends LightElement {
	static override properties = { limits: { attribute: false } };

	constructor() {
		super();
		this.limits = { copilot: 60, interpreter: 120 };
	}

	declare limits: { copilot: number; interpreter: number };

	protected override render() {
		return html`
		<section class="usage">
			<div class="usage-heading">
				<span class="eyebrow muted">Usage</span>
				<button
					data-action="page"
					data-page="global-settings"
					title="Edit global usage limits"
					aria-label="Edit global usage limits"
				>
					${renderIcon(SlidersHorizontal)}
				</button>
			</div>
			<div class="usage-label">
				<span>Copilot requests</span><span class="mono">18 / ${this.limits.copilot}</span>
			</div>
			<progress
				max=${this.limits.copilot}
				value="18"
				aria-label="Copilot request usage"
			></progress>
			<div class="usage-label">
				<span>Interpreter calls</span><span class="mono">42 / ${this.limits.interpreter}</span>
			</div>
			<progress
				max=${this.limits.interpreter}
				value="42"
				aria-label="Interpreter call usage"
			></progress>
		</section>
		`;
	}
}

customElements.define('harness-usage-meter', HarnessUsageMeter);

declare global {
	interface HTMLElementTagNameMap {
		'harness-usage-meter': HarnessUsageMeter;
	}
}
