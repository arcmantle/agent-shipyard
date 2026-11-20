import { kanbanActivityEventShowcaseCase } from "./components/activity-event/showcase-case.js";
import { kanbanActivityTimelineShowcaseCase } from "./components/activity-timeline/showcase-case.js";
import { kanbanAppShellShowcaseCase } from "./components/app-shell/showcase-case.js";
import { kanbanBoardShowcaseCase } from "./components/board/showcase-case.js";
import { kanbanButtonShowcaseCase } from "./components/button/showcase-case.js";
import { kanbanBreadcrumbTrailShowcaseCase } from "./components/breadcrumb-trail/showcase-case.js";
import { kanbanCardShowcaseCase } from "./components/card/showcase-case.js";
import { kanbanCardMetadataShowcaseCase } from "./components/card-metadata/showcase-case.js";
import { kanbanColumnShowcaseCase } from "./components/column/showcase-case.js";
import { kanbanCommentComposerShowcaseCase } from "./components/comment-composer/showcase-case.js";
import { kanbanCommentItemShowcaseCase } from "./components/comment-item/showcase-case.js";
import { kanbanCommentThreadShowcaseCase } from "./components/comment-thread/showcase-case.js";
import { kanbanEntityTableShowcaseCase } from "./components/entity-table/showcase-case.js";
import { kanbanEntityViewShowcaseCase } from "./components/entity-view/showcase-case.js";
import { kanbanFieldDisplayShowcaseCase } from "./components/field-display/showcase-case.js";
import { kanbanFieldEditorShowcaseCase } from "./components/field-editor/showcase-case.js";
import { kanbanIconButtonShowcaseCase } from "./components/icon-button/showcase-case.js";
import { kanbanIssueOverlayShowcaseCase } from "./components/issue-overlay/showcase-case.js";
import { kanbanKeyboardFocusShowcaseCase } from "./components/keyboard-focus/showcase-case.js";
import { kanbanMobileNavigationDrawerShowcaseCase } from "./components/mobile-navigation-drawer/showcase-case.js";
import { kanbanNavigationTreeShowcaseCase } from "./components/navigation-tree/showcase-case.js";
import { kanbanOverviewShowcaseCase } from "./components/overview/showcase-case.js";
import { kanbanPriorityBadgeShowcaseCase } from "./components/priority-badge/showcase-case.js";
import { kanbanPopoverMenuShowcaseCase } from "./components/popover-menu/showcase-case.js";
import { kanbanRecordSummaryShowcaseCase } from "./components/record-summary/showcase-case.js";
import { kanbanRecordToolbarShowcaseCase } from "./components/record-toolbar/showcase-case.js";
import { kanbanRelationshipListShowcaseCase } from "./components/relationship-list/showcase-case.js";
import { kanbanSelectMenuShowcaseCase } from "./components/select-menu/showcase-case.js";
import { kanbanSidebarShowcaseCase } from "./components/sidebar/showcase-case.js";
import { kanbanShortcutHintShowcaseCase } from "./components/shortcut-hint/showcase-case.js";
import { kanbanSkeletonShowcaseCase } from "./components/skeleton/showcase-case.js";
import { kanbanStatusBadgeShowcaseCase } from "./components/status-badge/showcase-case.js";
import { kanbanTabsShowcaseCase } from "./components/tabs/showcase-case.js";
import { kanbanUnsavedChangesShowcaseCase } from "./components/unsaved-changes/showcase-case.js";
import type { ShowcaseCase } from "./showcase-case.js";

export const showcaseCases: readonly ShowcaseCase[] = [
	kanbanActivityEventShowcaseCase,
	kanbanActivityTimelineShowcaseCase,
	kanbanAppShellShowcaseCase,
	kanbanBoardShowcaseCase,
	kanbanButtonShowcaseCase,
	kanbanBreadcrumbTrailShowcaseCase,
	kanbanCardShowcaseCase,
	kanbanCardMetadataShowcaseCase,
	kanbanColumnShowcaseCase,
	kanbanTabsShowcaseCase,
	kanbanCommentComposerShowcaseCase,
	kanbanCommentItemShowcaseCase,
	kanbanCommentThreadShowcaseCase,
	kanbanEntityTableShowcaseCase,
	kanbanEntityViewShowcaseCase,
	kanbanFieldDisplayShowcaseCase,
	kanbanFieldEditorShowcaseCase,
	kanbanIconButtonShowcaseCase,
	kanbanIssueOverlayShowcaseCase,
	kanbanKeyboardFocusShowcaseCase,
	kanbanMobileNavigationDrawerShowcaseCase,
	kanbanNavigationTreeShowcaseCase,
	kanbanOverviewShowcaseCase,
	kanbanPriorityBadgeShowcaseCase,
	kanbanPopoverMenuShowcaseCase,
	kanbanRecordSummaryShowcaseCase,
	kanbanRecordToolbarShowcaseCase,
	kanbanRelationshipListShowcaseCase,
	kanbanSelectMenuShowcaseCase,
	kanbanSidebarShowcaseCase,
	kanbanShortcutHintShowcaseCase,
	kanbanSkeletonShowcaseCase,
	kanbanStatusBadgeShowcaseCase,
	kanbanUnsavedChangesShowcaseCase
];

export function getShowcaseCase(componentId: string | undefined): ShowcaseCase | undefined {
	return showcaseCases.find((showcaseCase) => showcaseCase.id === componentId);
}