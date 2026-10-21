import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { kanbanBreadcrumbTrailRenderServiceContext, type KanbanBreadcrumbTrailState } from "./kanban-breadcrumb-trail.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanBreadcrumbTrail", () => {
	it("renders service-backed trail items with the current record identified", async () => {
		const breadcrumbTrailState = signal<KanbanBreadcrumbTrailState>({
			items: ["Workspace", "Initiative", "Portable Kanban design system"],
			label: "Record location"
		});
		new ContextProvider(document.body, {
			context: kanbanBreadcrumbTrailRenderServiceContext,
			initialValue: {
				breadcrumbTrail: breadcrumbTrailState
			}
		});
		const breadcrumbTrail = document.createElement("kanban-breadcrumb-trail");
		document.body.append(breadcrumbTrail);
		await breadcrumbTrail.updateComplete;

		expect(breadcrumbTrail.shadowRoot?.querySelector("nav")?.getAttribute("aria-label")).toBe("Record location");
		expect(breadcrumbTrail.shadowRoot?.querySelectorAll("li")).toHaveLength(3);
		expect(breadcrumbTrail.shadowRoot?.querySelector("li[aria-current=page]")?.textContent).toContain("Portable Kanban design system");

		breadcrumbTrailState.set({
			items: ["Workspace", "Current issue"],
			label: "Issue location"
		});
		await breadcrumbTrail.updateComplete;

		expect(breadcrumbTrail.shadowRoot?.querySelector("nav")?.getAttribute("aria-label")).toBe("Issue location");
		expect(breadcrumbTrail.shadowRoot?.querySelectorAll("li")).toHaveLength(2);
		expect(breadcrumbTrail.shadowRoot?.querySelector("li[aria-current=page]")?.textContent).toContain("Current issue");
	});
});