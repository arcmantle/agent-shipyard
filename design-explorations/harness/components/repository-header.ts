import { html, nothing } from 'lit';
import { ChevronRight } from 'lucide';
import { LightElement } from './light-element.js';
import { renderIcon } from './render-icon.js';

export interface RepositoryModel {
	name: string;
	path: string;
	projectIdentity?: string;
	tenant: string;
}

export class HarnessRepositoryHeader extends LightElement {
	static override properties = {
		repository: { attribute: false },
	};

	constructor() {
		super();
		this.repository = undefined;
	}

	declare repository: RepositoryModel | undefined;

	protected override render() {
		const repository = this.repository;
		if (!repository) return nothing;
		return html`
		<details
			class="repository-disclosure"
			aria-label="Current repository"
		>
			<summary>
				<span>Project details</span>
				${renderIcon(ChevronRight)}
			</summary>
			<div class="repository-disclosure-content">
				<div class="repository-location">
					<span class="repository-label">Location</span>
					<p
						class="repository-path mono muted"
						title=${repository.path}
					>
						${repository.path}
					</p>
				</div>
				<dl class="repository-details">
					<dt>Project</dt>
					<dd>${repository.projectIdentity || 'Not connected'}</dd>
					<dt>Tenant</dt>
					<dd>${repository.tenant}</dd>
				</dl>
			</div>
		</details>
		`;
	}
}

customElements.define('harness-repository-header', HarnessRepositoryHeader);

declare global {
	interface HTMLElementTagNameMap {
		'harness-repository-header': HarnessRepositoryHeader;
	}
}
