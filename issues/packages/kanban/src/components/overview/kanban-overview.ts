import { css, html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("kanban-overview")
export class KanbanOverview extends LitElement {
	protected handleOpenInitiative = (event: Event) => {
		this.forwardIntent(event, "kanban-overview-open-initiative");
	};

	protected handleOpenIssue = (event: Event) => {
		this.forwardIntent(event, "kanban-overview-open-issue");
	};

	protected handleCloseInitiative = (event: Event) => {
		this.forwardIntent(event, "kanban-overview-close-initiative");
	};

	protected handleCloseIssue = (event: Event) => {
		this.forwardIntent(event, "kanban-overview-close-issue");
	};

	public connectedCallback() {
		super.connectedCallback();
		this.addEventListener("kanban-app-shell-open-initiative", this.handleOpenInitiative);
		this.addEventListener("kanban-app-shell-open-issue", this.handleOpenIssue);
		this.addEventListener("kanban-initiative-overlay-close", this.handleCloseInitiative);
		this.addEventListener("kanban-issue-overlay-close", this.handleCloseIssue);
	}

	public disconnectedCallback() {
		this.removeEventListener("kanban-app-shell-open-initiative", this.handleOpenInitiative);
		this.removeEventListener("kanban-app-shell-open-issue", this.handleOpenIssue);
		this.removeEventListener("kanban-initiative-overlay-close", this.handleCloseInitiative);
		this.removeEventListener("kanban-issue-overlay-close", this.handleCloseIssue);
		super.disconnectedCallback();
	}

	protected forwardIntent(event: Event, eventName: string) {
		event.stopPropagation();
		this.dispatchEvent(
			new CustomEvent(eventName, {
				bubbles: true,
				composed: true,
				detail: (event as CustomEvent<unknown>).detail
			})
		);
	}

	protected render() {
		return html`
		<section aria-label="Kanban overview">
			<slot name="main"></slot>
			<slot name="initiative-overlay"></slot>
			<slot name="issue-overlay"></slot>
		</section>
		`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-overview": KanbanOverview;
	}

	interface HTMLElementEventMap {
		"kanban-overview-close-initiative": CustomEvent<unknown>;
		"kanban-overview-close-issue": CustomEvent<unknown>;
		"kanban-overview-open-initiative": CustomEvent<unknown>;
		"kanban-overview-open-issue": CustomEvent<unknown>;
	}
}