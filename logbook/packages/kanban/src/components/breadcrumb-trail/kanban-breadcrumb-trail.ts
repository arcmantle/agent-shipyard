import { consume, createContext } from "@lit/context";
import { SignalWatcher } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

export type KanbanBreadcrumbTrailState = {
	items: readonly string[];
	label: string;
};

export type KanbanBreadcrumbTrailRenderService = {
	breadcrumbTrail: { get(): KanbanBreadcrumbTrailState };
};

export const kanbanBreadcrumbTrailRenderServiceContext = createContext<KanbanBreadcrumbTrailRenderService>(Symbol("kanban-breadcrumb-trail-render-service"));

@customElement("kanban-breadcrumb-trail")
export class KanbanBreadcrumbTrail extends SignalWatcher(LitElement) {
	@consume({ context: kanbanBreadcrumbTrailRenderServiceContext, subscribe: true })
	@state()
	public service: KanbanBreadcrumbTrailRenderService | undefined;

	protected getAriaCurrent(index: number, itemCount: number): "false" | "page" {
		return index === itemCount - 1 ? "page" : "false";
	}

	protected render() {
		const breadcrumbTrail = this.service?.breadcrumbTrail.get();
		if (breadcrumbTrail === undefined) {
			return html``;
		}

		return html`
		<nav
			aria-label=${breadcrumbTrail.label}
			class="breadcrumb-trail"
		>
			<ol>
				${map(breadcrumbTrail.items, (item, index) => html`
				<li aria-current=${this.getAriaCurrent(index, breadcrumbTrail.items.length)}>${item}</li>
				`)}
			</ol>
		</nav>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
	}

	.breadcrumb-trail {
		color: var(--color-text-secondary);
		font-family: var(--font-family-ui);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-strong);
		min-width: var(--size-0);
	}

	ol {
		display: flex;
		flex-wrap: wrap;
		gap: var(--size-3);
		list-style: none;
		margin: var(--size-0);
		padding: var(--size-0);
	}

	li {
		align-items: center;
		display: inline-flex;
		min-width: var(--size-0);
	}

	li:not(:last-child)::after {
		color: var(--color-text-tertiary);
		content: "/";
		margin-left: var(--size-3);
	}

	li[aria-current="page"] {
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 47.5rem) {
		ol {
			flex-wrap: nowrap;
		}

		li:not(:last-child) {
			display: none;
		}

		li[aria-current="page"] {
			flex: 1;
		}

		li[aria-current="page"]::before {
			color: var(--color-text-tertiary);
			content: "... /";
			margin-right: var(--size-3);
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-breadcrumb-trail": KanbanBreadcrumbTrail;
	}
}