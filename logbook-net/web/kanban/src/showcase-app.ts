import { provide } from "@lit/context";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { map } from "lit/directives/map.js";
import { when } from "lit/directives/when.js";

import { kanbanActivityEventRenderServiceContext } from "./components/activity-event/kanban-activity-event.js";
import { kanbanActivityTimelineRenderServiceContext } from "./components/activity-timeline/kanban-activity-timeline.js";
import { kanbanAppShellRenderServiceContext } from "./components/app-shell/kanban-app-shell.js";
import { kanbanBoardRenderServiceContext } from "./components/board/kanban-board.js";
import { kanbanButtonRenderServiceContext } from "./components/button/kanban-button.js";
import { kanbanBreadcrumbTrailRenderServiceContext } from "./components/breadcrumb-trail/kanban-breadcrumb-trail.js";
import { kanbanCardRenderServiceContext } from "./components/card/kanban-card.js";
import { kanbanCardMetadataRenderServiceContext } from "./components/card-metadata/kanban-card-metadata.js";
import { kanbanColumnRenderServiceContext } from "./components/column/kanban-column.js";
import { kanbanCommentComposerRenderServiceContext } from "./components/comment-composer/kanban-comment-composer.js";
import { kanbanCommentRenderServiceContext } from "./components/comment-item/kanban-comment-item.js";
import { kanbanCommentThreadRenderServiceContext } from "./components/comment-thread/kanban-comment-thread.js";
import { kanbanEntityTableRenderServiceContext } from "./components/entity-table/kanban-entity-table.js";
import { kanbanEntityViewRenderServiceContext } from "./components/entity-view/kanban-entity-view.js";
import { kanbanFieldDisplayRenderServiceContext } from "./components/field-display/kanban-field-display.js";
import { kanbanFieldEditorRenderServiceContext } from "./components/field-editor/kanban-field-editor.js";
import { kanbanIconButtonRenderServiceContext } from "./components/icon-button/kanban-icon-button.js";
import { kanbanIssueOverlayRenderServiceContext } from "./components/issue-overlay/kanban-issue-overlay.js";
import { kanbanKeyboardFocusRenderServiceContext } from "./components/keyboard-focus/kanban-keyboard-focus.js";
import { kanbanMobileNavigationDrawerRenderServiceContext } from "./components/mobile-navigation-drawer/kanban-mobile-navigation-drawer.js";
import { kanbanNavigationTreeRenderServiceContext } from "./components/navigation-tree/kanban-navigation-tree.js";
import { kanbanPriorityBadgeRenderServiceContext } from "./components/priority-badge/kanban-priority-badge.js";
import { kanbanPopoverMenuRenderServiceContext } from "./components/popover-menu/kanban-popover-menu.js";
import { kanbanRecordSummaryRenderServiceContext } from "./components/record-summary/kanban-record-summary.js";
import { kanbanRecordToolbarRenderServiceContext } from "./components/record-toolbar/kanban-record-toolbar.js";
import { kanbanRelationshipListRenderServiceContext } from "./components/relationship-list/kanban-relationship-list.js";
import { kanbanSelectMenuRenderServiceContext } from "./components/select-menu/kanban-select-menu.js";
import { kanbanSidebarRenderServiceContext } from "./components/sidebar/kanban-sidebar.js";
import { kanbanShortcutHintRenderServiceContext } from "./components/shortcut-hint/kanban-shortcut-hint.js";
import { kanbanSkeletonRenderServiceContext } from "./components/skeleton/kanban-skeleton.js";
import { kanbanStatusBadgeRenderServiceContext } from "./components/status-badge/kanban-status-badge.js";
import { kanbanTabsRenderServiceContext } from "./components/tabs/kanban-tabs.js";
import { kanbanUnsavedChangesRenderServiceContext } from "./components/unsaved-changes/kanban-unsaved-changes.js";
import { createActivityEventShowcaseFixture, type ActivityEventFixtureRenderService } from "./fixtures/activity-event-fixture.js";
import { createActivityTimelineShowcaseFixture, type ActivityTimelineFixtureRenderService } from "./fixtures/activity-timeline-fixture.js";
import { createAppShellShowcaseFixture, type AppShellFixtureRenderService } from "./fixtures/app-shell-fixture.js";
import { createBoardShowcaseFixture, type BoardFixtureRenderService } from "./fixtures/board-fixture.js";
import { createButtonShowcaseFixture, type ButtonFixtureRenderService } from "./fixtures/button-fixture.js";
import { createBreadcrumbTrailShowcaseFixture, type BreadcrumbTrailFixtureRenderService } from "./fixtures/breadcrumb-trail-fixture.js";
import { createCardShowcaseFixture, type CardFixtureRenderService } from "./fixtures/card-fixture.js";
import { createCardMetadataShowcaseFixture, type CardMetadataFixtureRenderService } from "./fixtures/card-metadata-fixture.js";
import { createColumnShowcaseFixture, type ColumnFixtureRenderService } from "./fixtures/column-fixture.js";
import { createCommentComposerShowcaseFixture, type CommentComposerFixtureRenderService } from "./fixtures/comment-composer-fixture.js";
import { createCommentShowcaseFixture, type CommentFixtureRenderService } from "./fixtures/comment-fixture.js";
import { createCommentThreadShowcaseFixture, type CommentThreadFixtureRenderService } from "./fixtures/comment-thread-fixture.js";
import { createEntityTableShowcaseFixture, type EntityTableFixtureRenderService } from "./fixtures/entity-table-fixture.js";
import { createEntityViewShowcaseFixture, type EntityViewFixtureRenderService } from "./fixtures/entity-view-fixture.js";
import { createFieldDisplayShowcaseFixture, type FieldDisplayFixtureRenderService } from "./fixtures/field-display-fixture.js";
import { createFieldEditorShowcaseFixture, type FieldEditorFixtureRenderService } from "./fixtures/field-editor-fixture.js";
import { createKeyboardFocusShowcaseFixture, type KeyboardFocusFixtureRenderService } from "./fixtures/keyboard-focus-fixture.js";
import { createIconButtonShowcaseFixture, type IconButtonFixtureRenderService } from "./fixtures/icon-button-fixture.js";
import { createIssueOverlayShowcaseFixture, type IssueOverlayFixtureRenderService } from "./fixtures/issue-overlay-fixture.js";
import { createNavigationTreeShowcaseFixture, type NavigationTreeFixtureRenderService } from "./fixtures/navigation-tree-fixture.js";
import { createMobileNavigationDrawerShowcaseFixture, type MobileNavigationDrawerFixtureRenderService } from "./fixtures/mobile-navigation-drawer-fixture.js";
import { createPriorityBadgeShowcaseFixture, type PriorityBadgeFixtureRenderService } from "./fixtures/priority-badge-fixture.js";
import { createPopoverMenuShowcaseFixture, type PopoverMenuFixtureRenderService } from "./fixtures/popover-menu-fixture.js";
import { createRecordSummaryShowcaseFixture, type RecordSummaryFixtureRenderService } from "./fixtures/record-summary-fixture.js";
import { createRecordToolbarShowcaseFixture, type RecordToolbarFixtureRenderService } from "./fixtures/record-toolbar-fixture.js";
import { createRelationshipListShowcaseFixture, type RelationshipListFixtureRenderService } from "./fixtures/relationship-list-fixture.js";
import { createSelectMenuShowcaseFixture, type SelectMenuFixtureRenderService } from "./fixtures/select-menu-fixture.js";
import { createSidebarShowcaseFixture, type SidebarFixtureRenderService } from "./fixtures/sidebar-fixture.js";
import { createShortcutHintShowcaseFixture, type ShortcutHintFixtureRenderService } from "./fixtures/shortcut-hint-fixture.js";
import { createSkeletonShowcaseFixture, type SkeletonFixtureRenderService } from "./fixtures/skeleton-fixture.js";
import { createStatusBadgeShowcaseFixture, type StatusBadgeFixtureRenderService } from "./fixtures/status-badge-fixture.js";
import { createTabsShowcaseFixture, type TabsFixtureRenderService } from "./fixtures/tabs-fixture.js";
import { createUnsavedChangesShowcaseFixture, type UnsavedChangesFixtureRenderService } from "./fixtures/unsaved-changes-fixture.js";
import { getShowcaseCase, showcaseCases } from "./showcase-cases.js";

@customElement("kanban-showcase")
export class KanbanShowcase extends LitElement {
	@provide({ context: kanbanActivityEventRenderServiceContext })
	public activityEventFixtureService: ActivityEventFixtureRenderService = createActivityEventShowcaseFixture();

	@provide({ context: kanbanActivityTimelineRenderServiceContext })
	public activityTimelineFixtureService: ActivityTimelineFixtureRenderService = createActivityTimelineShowcaseFixture();

	@provide({ context: kanbanAppShellRenderServiceContext })
	public appShellFixtureService: AppShellFixtureRenderService = createAppShellShowcaseFixture();

	@provide({ context: kanbanBoardRenderServiceContext })
	public boardFixtureService: BoardFixtureRenderService = createBoardShowcaseFixture();

	@provide({ context: kanbanButtonRenderServiceContext })
	public buttonFixtureService: ButtonFixtureRenderService = createButtonShowcaseFixture();

	@provide({ context: kanbanBreadcrumbTrailRenderServiceContext })
	public breadcrumbTrailFixtureService: BreadcrumbTrailFixtureRenderService = createBreadcrumbTrailShowcaseFixture();

	@provide({ context: kanbanCardRenderServiceContext })
	public cardFixtureService: CardFixtureRenderService = createCardShowcaseFixture();

	@provide({ context: kanbanCardMetadataRenderServiceContext })
	public cardMetadataFixtureService: CardMetadataFixtureRenderService = createCardMetadataShowcaseFixture();

	@provide({ context: kanbanColumnRenderServiceContext })
	public columnFixtureService: ColumnFixtureRenderService = createColumnShowcaseFixture();

	@provide({ context: kanbanTabsRenderServiceContext })
	public tabsFixtureService: TabsFixtureRenderService = createTabsShowcaseFixture();

	@provide({ context: kanbanCommentComposerRenderServiceContext })
	public commentComposerFixtureService: CommentComposerFixtureRenderService = createCommentComposerShowcaseFixture();

	@provide({ context: kanbanCommentRenderServiceContext })
	public commentFixtureService: CommentFixtureRenderService = createCommentShowcaseFixture();

	@provide({ context: kanbanCommentThreadRenderServiceContext })
	public commentThreadFixtureService: CommentThreadFixtureRenderService = createCommentThreadShowcaseFixture();

	@provide({ context: kanbanEntityTableRenderServiceContext })
	public entityTableFixtureService: EntityTableFixtureRenderService = createEntityTableShowcaseFixture();

	@provide({ context: kanbanEntityViewRenderServiceContext })
	public entityViewFixtureService: EntityViewFixtureRenderService = createEntityViewShowcaseFixture();

	@provide({ context: kanbanFieldDisplayRenderServiceContext })
	public fieldDisplayFixtureService: FieldDisplayFixtureRenderService = createFieldDisplayShowcaseFixture();

	@provide({ context: kanbanFieldEditorRenderServiceContext })
	public fieldEditorFixtureService: FieldEditorFixtureRenderService = createFieldEditorShowcaseFixture();

	@provide({ context: kanbanIconButtonRenderServiceContext })
	public iconButtonFixtureService: IconButtonFixtureRenderService = createIconButtonShowcaseFixture();

	@provide({ context: kanbanIssueOverlayRenderServiceContext })
	public issueOverlayFixtureService: IssueOverlayFixtureRenderService = createIssueOverlayShowcaseFixture();

	@provide({ context: kanbanKeyboardFocusRenderServiceContext })
	public keyboardFocusFixtureService: KeyboardFocusFixtureRenderService = createKeyboardFocusShowcaseFixture();

	@provide({ context: kanbanMobileNavigationDrawerRenderServiceContext })
	public mobileNavigationDrawerFixtureService: MobileNavigationDrawerFixtureRenderService = createMobileNavigationDrawerShowcaseFixture();

	@provide({ context: kanbanNavigationTreeRenderServiceContext })
	public navigationTreeFixtureService: NavigationTreeFixtureRenderService = createNavigationTreeShowcaseFixture();

	@provide({ context: kanbanPriorityBadgeRenderServiceContext })
	public priorityBadgeFixtureService: PriorityBadgeFixtureRenderService = createPriorityBadgeShowcaseFixture();

	@provide({ context: kanbanPopoverMenuRenderServiceContext })
	public popoverMenuFixtureService: PopoverMenuFixtureRenderService = createPopoverMenuShowcaseFixture();

	@provide({ context: kanbanRecordSummaryRenderServiceContext })
	public recordSummaryFixtureService: RecordSummaryFixtureRenderService = createRecordSummaryShowcaseFixture();

	@provide({ context: kanbanRecordToolbarRenderServiceContext })
	public recordToolbarFixtureService: RecordToolbarFixtureRenderService = createRecordToolbarShowcaseFixture();

	@provide({ context: kanbanRelationshipListRenderServiceContext })
	public relationshipListFixtureService: RelationshipListFixtureRenderService = createRelationshipListShowcaseFixture();

	@provide({ context: kanbanSelectMenuRenderServiceContext })
	public selectMenuFixtureService: SelectMenuFixtureRenderService = createSelectMenuShowcaseFixture();

	@provide({ context: kanbanSidebarRenderServiceContext })
	public sidebarFixtureService: SidebarFixtureRenderService = createSidebarShowcaseFixture();

	@provide({ context: kanbanShortcutHintRenderServiceContext })
	public shortcutHintFixtureService: ShortcutHintFixtureRenderService = createShortcutHintShowcaseFixture();

	@provide({ context: kanbanSkeletonRenderServiceContext })
	public skeletonFixtureService: SkeletonFixtureRenderService = createSkeletonShowcaseFixture();

	@provide({ context: kanbanStatusBadgeRenderServiceContext })
	public statusBadgeFixtureService: StatusBadgeFixtureRenderService = createStatusBadgeShowcaseFixture();

	@provide({ context: kanbanUnsavedChangesRenderServiceContext })
	public unsavedChangesFixtureService: UnsavedChangesFixtureRenderService = createUnsavedChangesShowcaseFixture();

	@property({ type: String })
	public componentId: string | undefined;

	protected handleNavigation(event: MouseEvent) {
		const link = event.currentTarget as HTMLAnchorElement;
		event.preventDefault();
		this.dispatchEvent(
			new CustomEvent("kanban-navigate", {
				bubbles: true,
				composed: true,
				detail: { href: link.href }
			})
		);
	}

	protected handleStageClick(event: MouseEvent) {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}

		if (target.closest<HTMLElement>("[data-action=open-issue-overlay]")) {
			this.issueOverlayFixtureService.open();
		}

		if (target.closest<HTMLElement>("[data-action=open-mobile-navigation-drawer]")) {
			this.mobileNavigationDrawerFixtureService.open();
		}
	}

	protected getSectionLabel(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.sectionLabel;
		}

		return "Component catalog";
	}

	protected getCaptionDescription(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.description;
		}

		return "Use the component rail to inspect each registered Kanban element in isolation.";
	}

	protected getCaptionTitle(): string {
		const showcaseCase = this.getSelectedCase();
		if (showcaseCase) {
			return showcaseCase.label;
		}

		return "Component catalog";
	}

	protected getNavigationClass(componentId: string) {
		return classMap({ "is-active": this.componentId === componentId });
	}

	protected getNavigationState(componentId: string): "false" | "page" {
		if (this.componentId === componentId) {
			return "page";
		}

		return "false";
	}

	protected getSelectedCase() {
		return getShowcaseCase(this.componentId);
	}

	protected getStageClass() {
		return classMap({
			"component-stage": true,
			"is-catalog": this.componentId === undefined
		});
	}

	protected renderSelectedCase(componentId: string) {
		const showcaseCase = getShowcaseCase(componentId);
		if (showcaseCase === undefined) {
			return html``;
		}

		return showcaseCase.render();
	}

	protected render() {
		return html`
		<nav
			aria-label="Component selector"
			class="component-rail"
		>
			<div class="rail-title">
				<span aria-hidden="true" class="rail-mark">A</span>
				<span>Concept A</span>
			</div>
			<section
				aria-labelledby="registered-components"
				class="rail-group"
			>
				<h2 id="registered-components">Registered components</h2>
				${map(showcaseCases, (showcaseCase) => html`
				<a
					aria-current=${this.getNavigationState(showcaseCase.id)}
					class=${this.getNavigationClass(showcaseCase.id)}
					href=${`/components/${showcaseCase.id}`}
					@click=${this.handleNavigation}
				>
					${showcaseCase.label}
				</a>
				`)}
			</section>
		</nav>
		<main class="component-workspace">
			<section class="component-draft">
				<header class="draft-caption">
					<span>Concept A component draft</span>
					<h1>${this.getCaptionTitle()}</h1>
					<p>${this.getCaptionDescription()}</p>
				</header>
				<section
					aria-label=${this.getSectionLabel()}
					class=${this.getStageClass()}
					@click=${this.handleStageClick}
				>
				${when(
					this.componentId,
					(componentId) => this.renderSelectedCase(componentId),
					() => map(showcaseCases, (showcaseCase) => html`
					<article class="component-preview">
						<h2>${showcaseCase.label}</h2>
						${showcaseCase.render()}
					</article>
					`)
				)}
				</section>
			</section>
		</main>
		`;
	}

	public static styles = css`
	:host {
		background: var(--color-surface-canvas);
		color: var(--color-text-primary);
		display: block;
		font-family: var(--font-family-ui);
		height: 100dvh;
		overflow: hidden;
	}

	.component-rail {
		background: var(--color-surface-sidebar);
		box-sizing: border-box;
		color: var(--color-text-inverse);
		inset: var(--size-0) auto var(--size-0) var(--size-0);
		overflow-y: auto;
		padding: var(--size-12) var(--size-7);
		position: fixed;
		width: var(--size-104);
		z-index: 1;
	}

	.rail-title {
		align-items: center;
		display: flex;
		font-size: var(--font-size-brand);
		font-weight: var(--font-weight-heavy);
		gap: var(--size-5);
		letter-spacing: var(--letter-spacing-brand);
		padding: var(--size-0) var(--size-4) var(--size-11);
		text-transform: uppercase;
	}

	.rail-mark {
		align-items: center;
		background: var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		display: inline-flex;
		font-size: var(--font-size-meta);
		height: var(--size-13);
		justify-content: center;
		width: var(--size-13);
	}

	.rail-group {
		border-top: var(--border-width) solid var(--color-border-sidebar);
		display: grid;
		gap: var(--size-2);
		margin: var(--size-0);
		padding: var(--size-7) var(--size-0) var(--size-0);
	}

	.rail-group h2 {
		color: var(--color-text-tertiary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		margin: var(--size-0) var(--size-0) var(--size-2);
		padding: var(--size-0) var(--size-4);
		text-transform: uppercase;
	}

	.rail-group a {
		border-radius: var(--radius-control);
		color: var(--color-text-inverse-muted);
		font-size: var(--font-size-control);
		font-weight: var(--font-weight-strong);
		line-height: var(--line-height-ui);
		padding: var(--size-5) var(--size-4);
		text-decoration: none;
	}

	.rail-group a:hover {
		background: var(--color-surface-sidebar-hover);
		color: var(--color-surface-panel);
	}

	.rail-group a.is-active {
		background: var(--color-surface-sidebar-selected);
		color: var(--color-surface-panel);
	}

	.rail-group a:focus-visible {
		outline: var(--size-1) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.component-workspace {
		box-sizing: border-box;
		height: 100%;
		margin-left: var(--size-104);
		min-width: 0;
		overflow-y: auto;
	}

	.component-draft {
		align-items: center;
		background: var(--color-surface-preview);
		box-sizing: border-box;
		display: grid;
		min-height: 100%;
		padding: var(--size-26) var(--size-12);
	}

	.draft-caption,
	.component-stage {
		width: min(var(--size-560), 100%);
	}

	.draft-caption {
		color: var(--color-text-secondary);
		margin-bottom: var(--size-9);
	}

	.draft-caption > span {
		color: var(--color-text-secondary);
		font-size: var(--font-size-meta);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		text-transform: uppercase;
	}

	.draft-caption h1 {
		color: var(--color-text-primary);
		font-family: var(--font-family-display);
		font-size: var(--font-size-display);
		font-weight: var(--font-weight-display);
		letter-spacing: var(--size-0);
		line-height: var(--line-height-tight);
		margin: var(--size-2) var(--size-0);
	}

	.draft-caption p {
		font-size: var(--font-size-body);
		line-height: var(--line-height-body);
		margin: var(--size-0);
		max-width: 68ch;
	}

	.component-stage {
		align-items: center;
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-preview);
		border-radius: var(--radius-panel);
		box-shadow: var(--shadow-preview);
		box-sizing: border-box;
		display: grid;
		gap: var(--size-12);
		min-height: var(--size-150);
		padding: var(--size-12);
	}

	.component-stage:not(.is-catalog) {
		justify-items: stretch;
	}

	.component-stage.is-catalog {
		align-items: stretch;
		grid-template-columns: repeat(auto-fit, minmax(var(--size-140), 1fr));
	}

	.issue-overlay-trigger {
		background: var(--color-accent);
		border: var(--border-width) solid var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		cursor: pointer;
		font: inherit;
		font-weight: var(--font-weight-strong);
		padding: var(--size-5) var(--size-8);
	}

	.issue-overlay-trigger:hover {
		background: var(--color-accent-secondary);
		border-color: var(--color-accent-secondary);
	}

	.issue-overlay-trigger:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.mobile-navigation-drawer-trigger {
		background: var(--color-accent);
		border: var(--border-width) solid var(--color-accent);
		border-radius: var(--radius-control);
		color: var(--color-surface-sidebar);
		cursor: pointer;
		font: inherit;
		font-weight: var(--font-weight-strong);
		padding: var(--size-5) var(--size-8);
	}

	.mobile-navigation-drawer-trigger:hover {
		background: var(--color-accent-secondary);
		border-color: var(--color-accent-secondary);
	}

	.mobile-navigation-drawer-trigger:focus-visible {
		outline: var(--size-2) solid var(--color-accent-secondary);
		outline-offset: var(--size-1);
	}

	.component-preview {
		background: var(--color-surface-canvas);
		border: var(--border-width) solid var(--color-border-preview);
		border-radius: var(--radius-panel);
		display: grid;
		gap: var(--size-8);
		padding: var(--size-8);
	}

	.component-preview h2 {
		color: var(--color-text-secondary);
		font-size: var(--font-size-label);
		font-weight: var(--font-weight-heavy);
		letter-spacing: var(--letter-spacing-label);
		margin: var(--size-0);
		text-transform: uppercase;
	}

	@media (max-width: 47.5rem) {
		:host {
			height: auto;
			overflow: visible;
		}

		.component-rail {
			inset: auto;
			padding: var(--size-8);
			position: static;
			width: auto;
		}

		.rail-title {
			padding-bottom: var(--size-8);
		}

		.rail-group {
			grid-template-columns: repeat(auto-fit, minmax(var(--size-80), 1fr));
		}

		.rail-group h2 {
			grid-column: 1 / -1;
		}

		.component-workspace {
			height: auto;
			margin-left: 0;
			overflow: visible;
		}

		.component-draft {
			align-items: start;
			min-height: 100vh;
			padding: var(--size-18) var(--size-9);
		}
	}

	@media (max-width: 31.25rem) {
		.component-stage {
			padding: var(--size-6);
		}

		.component-stage.is-catalog {
			grid-template-columns: 1fr;
		}
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-showcase": KanbanShowcase;
	}
}