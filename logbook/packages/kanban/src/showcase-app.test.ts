import { afterEach, describe, expect, it } from "vitest";

import "./kanban-app.js";

afterEach(() => {
	document.body.replaceChildren();
	window.history.replaceState({}, "", "/");
});

describe("Kanban application routes", () => {
	it("keeps the board at the root route", async () => {
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".board-shell")).not.toBeNull();
		expect(app.shadowRoot?.querySelector("kanban-showcase")).toBeNull();
	});

	it("renders the fixture catalog at the components route", async () => {
		window.history.replaceState({}, "", "/components");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase).not.toBeNull();
		await showcase?.updateComplete;

		expect(showcase?.shadowRoot?.querySelector("kanban-button")).not.toBeNull();
	});

	it("navigates from the catalog to the selected component", async () => {
		window.history.replaceState({}, "", "/components");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-showcase");
		await showcase?.updateComplete;
		showcase?.shadowRoot?.querySelector<HTMLAnchorElement>('a[href="/components/kanban-button"]')?.click();
		await app.updateComplete;

		const selectedShowcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string }>("kanban-showcase");
		expect(selectedShowcase?.componentId).toBe("kanban-button");
		expect(window.location.pathname).toBe("/components/kanban-button");
	});

	it("renders the deterministic button fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-button");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase).not.toBeNull();
		expect(showcase?.componentId).toBe("kanban-button");
		await showcase?.updateComplete;

		const button = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-button");
		expect(button).not.toBeNull();
		await button?.updateComplete;
		expect(button?.shadowRoot?.textContent).toContain("Create issue");
		expect(button?.shadowRoot?.querySelector(".is-primary")).not.toBeNull();
	});

	it("renders the deterministic Tabs fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-tabs");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-tabs");
		await showcase?.updateComplete;

		const tabs = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-tabs");
		expect(tabs).not.toBeNull();
		await tabs?.updateComplete;
		expect(tabs?.shadowRoot?.querySelector("[aria-current=page]")?.textContent).toContain("Issues");
		tabs?.shadowRoot?.querySelector<HTMLButtonElement>("[data-tab-id=plans]")?.click();
		await tabs?.updateComplete;
		expect(tabs?.shadowRoot?.querySelector("[aria-current=page]")?.textContent).toContain("Plans");
	});

	it("renders the deterministic Breadcrumb trail fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-breadcrumb-trail");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-breadcrumb-trail");
		await showcase?.updateComplete;

		const breadcrumbTrail = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-breadcrumb-trail");
		expect(breadcrumbTrail).not.toBeNull();
		await breadcrumbTrail?.updateComplete;
		expect(breadcrumbTrail?.shadowRoot?.querySelector("li[aria-current=page]")?.textContent).toContain("Portable Kanban design system");
	});

	it("renders the deterministic Comment item fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-comment-item");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-comment-item");
		await showcase?.updateComplete;

		const comment = showcase?.shadowRoot?.querySelector("kanban-comment-item");
		expect(comment).not.toBeNull();
	});

	it("renders the deterministic Comment composer fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-comment-composer");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-comment-composer");
		await showcase?.updateComplete;

		const composer = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-comment-composer");
		expect(composer).not.toBeNull();
		await composer?.updateComplete;
		expect(composer?.shadowRoot?.querySelector("textarea")?.getAttribute("placeholder")).toBe("Write a comment");
		expect(composer?.shadowRoot?.querySelector("button[type=submit]")?.textContent).toContain("Post comment");
	});

	it("renders the deterministic Field display fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-field-display");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-field-display");
		await showcase?.updateComplete;

		const fieldDisplay = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-field-display");
		expect(fieldDisplay).not.toBeNull();
		await fieldDisplay?.updateComplete;
		expect(fieldDisplay?.shadowRoot?.querySelector("dt")?.textContent).toContain("Title");
		expect(fieldDisplay?.shadowRoot?.querySelector("dd")?.textContent).toContain("Define the board-server write contract");
	});

	it("renders the deterministic Sidebar fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-sidebar");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-sidebar");
		await showcase?.updateComplete;

		const sidebar = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-sidebar");
		expect(sidebar).not.toBeNull();
		await sidebar?.updateComplete;
		expect(sidebar?.shadowRoot?.querySelector("aside")?.getAttribute("aria-label")).toBe("Project and initiative navigation");
		expect(sidebar?.shadowRoot?.textContent).toContain("agent-issues");
	});

	it("renders the deterministic Issue overlay fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-issue-overlay");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-issue-overlay");
		await showcase?.updateComplete;

		const issueOverlay = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-issue-overlay");
		expect(issueOverlay).not.toBeNull();
		await issueOverlay?.updateComplete;
		expect(issueOverlay?.shadowRoot?.querySelector<HTMLElement>(".overlay-shell")?.hidden).toBe(true);

		showcase?.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=open-issue-overlay]")?.click();
		await issueOverlay?.updateComplete;

		expect(issueOverlay?.shadowRoot?.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Issue details");
		expect(issueOverlay?.shadowRoot?.textContent).toContain("Define the board-server write contract");
		expect(issueOverlay?.shadowRoot?.querySelector<HTMLElement>(".overlay-shell")?.hidden).toBe(false);
	});

	it("renders the deterministic Overview composition fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-overview");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-overview");
		await showcase?.updateComplete;

		const overview = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-overview");
		expect(overview).not.toBeNull();
		await overview?.updateComplete;
		expect(overview?.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=main]")?.assignedElements()[0]?.localName).toBe("kanban-entity-view");
		expect(overview?.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=initiative-overlay]")?.assignedElements()[0]?.textContent).toContain("Editable Kanban board");
		expect(overview?.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=issue-overlay]")?.assignedElements()[0]?.localName).toBe("kanban-issue-overlay");
	});

	it("renders the deterministic Navigation tree fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-navigation-tree");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-navigation-tree");
		await showcase?.updateComplete;

		const navigationTree = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-navigation-tree");
		expect(navigationTree).not.toBeNull();
		await navigationTree?.updateComplete;
		expect(navigationTree?.shadowRoot?.querySelector("button[aria-current=page]")?.textContent).toContain("Implement Navigation tree component");
	});

	it("renders the deterministic Shortcut hint fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-shortcut-hint");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-shortcut-hint");
		await showcase?.updateComplete;

		const shortcutHint = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-shortcut-hint");
		expect(shortcutHint).not.toBeNull();
		await shortcutHint?.updateComplete;
		expect(shortcutHint?.shadowRoot?.textContent).toContain("Cmd");
		expect(shortcutHint?.shadowRoot?.textContent).toContain("K");
	});

	it("renders the deterministic Skeleton fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-skeleton");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-skeleton");
		await showcase?.updateComplete;

		const skeleton = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-skeleton");
		expect(skeleton).not.toBeNull();
		await skeleton?.updateComplete;
		expect(skeleton?.shadowRoot?.querySelector("[role=status]")?.getAttribute("aria-label")).toBe("Loading card");
		expect(skeleton?.shadowRoot?.querySelector(".skeleton-card")).not.toBeNull();
	});

	it("renders the deterministic App shell fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-app-shell");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-app-shell");
		await showcase?.updateComplete;

		const appShell = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-app-shell");
		expect(appShell).not.toBeNull();
		await appShell?.updateComplete;
		expect(appShell?.shadowRoot?.querySelector("main")?.getAttribute("aria-label")).toBe("Kanban workspace");
		expect(appShell?.shadowRoot?.querySelector<HTMLSlotElement>("slot[name=sidebar]")?.assignedElements()).toHaveLength(1);
	});
	it("renders the deterministic Card metadata fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-card-metadata");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-card-metadata");
		await showcase?.updateComplete;

		const cardMetadata = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-card-metadata");
		expect(cardMetadata).not.toBeNull();
		await cardMetadata?.updateComplete;
		expect(cardMetadata?.shadowRoot?.textContent).toContain("ISS-322");
		expect(cardMetadata?.shadowRoot?.querySelector("dd.is-blocked")?.textContent).toBe("2 blockers");
	});

	it("renders the deterministic Comment thread fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-comment-thread");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-comment-thread");
		await showcase?.updateComplete;

		const commentThread = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-comment-thread");
		expect(commentThread).not.toBeNull();
		await commentThread?.updateComplete;
		expect(commentThread?.shadowRoot?.querySelector("ol")?.textContent).toContain("Keep server behavior identical for local and cloud workspaces.");
	});

	it("renders the deterministic Priority badge fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-priority-badge");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-priority-badge");
		await showcase?.updateComplete;

		const badge = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-priority-badge");
		expect(badge).not.toBeNull();
		await badge?.updateComplete;
		expect(badge?.shadowRoot?.querySelector("[role=status]")?.textContent).toContain("High");
		expect(badge?.shadowRoot?.querySelector(".is-high")).not.toBeNull();
	});

	it("renders the deterministic Icon button fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-icon-button");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-icon-button");
		await showcase?.updateComplete;

		const iconButton = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-icon-button");
		expect(iconButton).not.toBeNull();
		await iconButton?.updateComplete;
		expect(iconButton?.shadowRoot?.querySelector("button")?.getAttribute("aria-label")).toBe("Create");
		expect(iconButton?.shadowRoot?.querySelector("button")?.textContent).toContain("+");
	});

	it("renders the deterministic Select menu fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-select-menu");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-select-menu");
		await showcase?.updateComplete;

		const selectMenu = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-select-menu");
		expect(selectMenu).not.toBeNull();
		await selectMenu?.updateComplete;
		expect(selectMenu?.shadowRoot?.querySelector("label")?.textContent).toContain("Status");
		expect(selectMenu?.shadowRoot?.querySelector("button")?.textContent).toContain("Todo");
		expect(selectMenu?.shadowRoot?.querySelector("[role=listbox]")?.getAttribute("popover")).toBe("auto");
	});

	it("renders the deterministic Popover menu fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-popover-menu");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-popover-menu");
		await showcase?.updateComplete;

		const popoverMenu = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-popover-menu");
		expect(popoverMenu).not.toBeNull();
		await popoverMenu?.updateComplete;
		expect(popoverMenu?.shadowRoot?.querySelector("button")?.textContent).toContain("Issue actions");
		expect(popoverMenu?.shadowRoot?.querySelector("[data-action-id=archive]")?.textContent).toContain("Archive issue");
	});

	it("renders the deterministic Mobile navigation drawer fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-mobile-navigation-drawer");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-mobile-navigation-drawer");
		await showcase?.updateComplete;

		const drawer = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-mobile-navigation-drawer");
		expect(drawer).not.toBeNull();
		await drawer?.updateComplete;
		expect(drawer?.shadowRoot?.querySelector("nav")?.getAttribute("aria-label")).toBe("Project and initiative navigation");
		expect(drawer?.shadowRoot?.textContent).toContain("Editable Kanban board");

		drawer?.shadowRoot?.querySelector<HTMLButtonElement>(".close-button")?.click();
		await drawer?.updateComplete;
		expect(drawer?.shadowRoot?.querySelector("aside")?.hasAttribute("inert")).toBe(true);

		showcase?.shadowRoot?.querySelector<HTMLButtonElement>("[data-action=open-mobile-navigation-drawer]")?.click();
		await drawer?.updateComplete;
		expect(drawer?.shadowRoot?.querySelector("aside")?.hasAttribute("inert")).toBe(false);
	});

	it("renders the deterministic Keyboard focus fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-keyboard-focus");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-keyboard-focus");
		await showcase?.updateComplete;

		const keyboardFocus = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-keyboard-focus");
		expect(keyboardFocus).not.toBeNull();
		await keyboardFocus?.updateComplete;
		expect(keyboardFocus?.shadowRoot?.querySelector("h2")?.textContent).toBe("Record actions");
		expect(keyboardFocus?.shadowRoot?.querySelector("button:not([disabled])")?.textContent).toContain("Save changes");
		expect(keyboardFocus?.shadowRoot?.querySelector("button[disabled]")?.textContent).toContain("Archive issue");
	});

	it("renders the deterministic Unsaved changes fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-unsaved-changes");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-unsaved-changes");
		await showcase?.updateComplete;

		const indicator = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-unsaved-changes");
		expect(indicator).not.toBeNull();
		await indicator?.updateComplete;
		expect(indicator?.shadowRoot?.querySelector("[role=status]")?.textContent).toContain("Unsaved changes");
	});

	it("renders the deterministic Activity event fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-activity-event");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-activity-event");
		await showcase?.updateComplete;

		const activityEvent = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-activity-event");
		expect(activityEvent).not.toBeNull();
		await activityEvent?.updateComplete;
		expect(activityEvent?.shadowRoot?.querySelector("time")?.textContent).toContain("Today, 10:24");
		expect(activityEvent?.shadowRoot?.querySelector(".is-accent")).not.toBeNull();
	});

	it("renders the deterministic Activity timeline fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-activity-timeline");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-activity-timeline");
		await showcase?.updateComplete;

		const timeline = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-activity-timeline");
		expect(timeline).not.toBeNull();
		await timeline?.updateComplete;
		expect(timeline?.shadowRoot?.querySelector("ol")?.getAttribute("aria-label")).toBe("Initiative activity");
		expect(timeline?.shadowRoot?.textContent).toContain("R. Lee moved ISS-318 to In progress");
	});

	it("renders the deterministic Entity view fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-entity-view");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-entity-view");
		await showcase?.updateComplete;

		const entityView = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-entity-view");
		expect(entityView).not.toBeNull();
		await entityView?.updateComplete;
		expect(entityView?.shadowRoot?.querySelector("h2")?.textContent).toContain("Delivery plans");
		expect(entityView?.shadowRoot?.querySelector("button")?.textContent).toContain("New plan");
	});

	it("renders the deterministic Entity table fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-entity-table");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-entity-table");
		await showcase?.updateComplete;

		const entityTable = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-entity-table");
		expect(entityTable).not.toBeNull();
		await entityTable?.updateComplete;
		expect(entityTable?.shadowRoot?.querySelector("caption")?.textContent).toContain("Plans");
	});

	it("renders a return-to-catalog state for an unknown component", async () => {
		window.history.replaceState({}, "", "/components/unknown-component");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		expect(app.shadowRoot?.querySelector(".not-found")).not.toBeNull();
		expect(app.shadowRoot?.textContent).toContain("unknown-component");
		expect(app.shadowRoot?.querySelector('a[href="/components"]')).not.toBeNull();
	});
});