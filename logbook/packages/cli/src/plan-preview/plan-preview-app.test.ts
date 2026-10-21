// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { ProposedPlan } from "@agent-issues/core";
import { PlanPreviewApp } from "./plan-preview-app.js";
import "./plan-preview-app.js";

function proposedPlan(): ProposedPlan & { status: string; revision: number } {
	return {
		reference: "PLAN_123",
		title: "Plan Preview Design",
		goal: "Review the Plan before it becomes ready.",
		context: "Use the MCP Apps contract.",
		revision: 3,
		current: [
			{
				key: "decisions",
				title: "Decisions",
				entries: [{ body: "Use a small Lit app.", contentHash: "entry-hash", createdAt: "2026-09-04T00:00:00.000Z", createdBy: "user", id: "entry-1", planId: "plan-1", reference: "PLAN_ENTRY_123", referencedEntityIds: [], revision: 1, role: "decision", scopeDirection: null, shortReference: "PLAN_ENTRY_123", supersededEntryIds: [], tombstone: false, updatedAt: "2026-09-04T00:00:00.000Z", updatedBy: "user" }]
			}
		],
		hasActiveQuestions: false,
		snapshotDigest: "a".repeat(64),
		status: "in-progress"
	};
}

describe("PlanPreviewApp", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("shows a Proposed Plan only after the review is expanded", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string }; updateComplete: Promise<unknown> };
		element.plan = proposedPlan();
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("h1")?.textContent).toContain("Plan Preview Design");
		const toggle = element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(element.shadowRoot?.querySelector("[data-section=goal]")).toBeNull();
		toggle?.click();
		await element.updateComplete;

		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(element.shadowRoot?.querySelector("[data-section=goal]")?.textContent).toContain("Review the Plan before it becomes ready.");
		expect(element.shadowRoot?.querySelector("[data-section=context]")?.textContent).toContain("Use the MCP Apps contract.");
		expect(element.shadowRoot?.querySelector("[data-group=decisions]")?.textContent).toContain("Use a small Lit app.");
		expect(element.shadowRoot?.querySelector("[data-group=questions]")).toBeNull();
		expect(element.shadowRoot?.querySelector("[data-revision]")?.textContent).toContain("Revision 3");
	});

	it("shows the ready state without confirmation or return actions", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string }; updateComplete: Promise<unknown> };
		element.plan = { ...proposedPlan(), status: "ready" };
		document.body.append(element);
		await element.updateComplete;
		(element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]"))?.click();
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[data-state=ready]")?.textContent).toContain("Plan ready");
		expect(element.shadowRoot?.querySelector("button[data-action=confirm]")).toBeNull();
		expect(element.shadowRoot?.querySelector("button[data-action=return]")).toBeNull();
	});

	it("does not render confirmation or return actions", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string }; updateComplete: Promise<unknown> };
		element.plan = proposedPlan();
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("button[data-action=confirm]")).toBeNull();
		expect(element.shadowRoot?.querySelector("button[data-action=return]")).toBeNull();
	});

	it("keeps reviewed content visible with an accessible loading, error, and Plan-changed state", async () => {
		let retries = 0;
		const loadingElement = document.createElement("plan-preview-app") as HTMLElement & { plan: ProposedPlan & { status: string } | null; updateComplete: Promise<unknown> };
		document.body.append(loadingElement);
		await loadingElement.updateComplete;
		expect(loadingElement.shadowRoot?.querySelector("[role=status]")?.textContent).toContain("Loading Plan Preview.");

		const element = document.createElement("plan-preview-app") as HTMLElement & {
			plan: ProposedPlan & { status: string };
			errorMessage: string | null;
			retryAction: () => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		element.plan = proposedPlan();
		element.errorMessage = "Plan changed";
		element.retryAction = async () => {
			retries += 1;
		};
		document.body.append(element);
		await element.updateComplete;
		(element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]"))?.click();
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[data-section=goal]")?.textContent).toContain("Review the Plan before it becomes ready.");
		expect(element.shadowRoot?.querySelector("[role=alert]")?.textContent).toContain("Plan changed");
		expect(element.shadowRoot?.querySelector("button[data-action=confirm]")).toBeNull();
		(element.shadowRoot?.querySelector("button[data-action=retry]") as HTMLButtonElement).click();
		await Promise.resolve();
		expect(retries).toBe(1);
	});

	it("renders authored Markdown as sanitized HTML and opens links through the host", async () => {
		const opened: string[] = [];
		const element = document.createElement("plan-preview-app") as HTMLElement & {
			plan: ProposedPlan & { status: string; revision: number };
			openLink: (url: string) => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		element.plan = {
			...proposedPlan(),
			goal: "See [the contract](https://example.test/contract).\n\n<script>window.planPreviewXss = true</script>"
		};
		element.openLink = async (url) => {
			opened.push(url);
		};
		document.body.append(element);
		await element.updateComplete;
		(element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]"))?.click();
		await element.updateComplete;

		const goal = element.shadowRoot?.querySelector("[data-section=goal]");
		const link = goal?.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://example.test/contract");
		expect(goal?.querySelector("script")).toBeNull();
		expect(goal?.innerHTML).not.toContain("<script>");
		expect((window as Window & { planPreviewXss?: boolean }).planPreviewXss).toBeUndefined();
		link?.click();
		await Promise.resolve();
		expect(opened).toEqual(["https://example.test/contract"]);
	});

	it("keeps the review toggle keyboard-focusable", async () => {
		const element = document.createElement("plan-preview-app") as HTMLElement & {
			plan: ProposedPlan & { status: string };
			updateComplete: Promise<unknown>;
		};
		element.plan = proposedPlan();
		document.body.append(element);
		await element.updateComplete;

		const toggle = element.shadowRoot?.querySelector("button[data-action=toggle]") as HTMLButtonElement;
		expect(toggle.disabled).toBe(false);
		expect(toggle.tabIndex).toBeGreaterThanOrEqual(0);
		toggle.focus();
		expect(element.shadowRoot?.activeElement).toBe(toggle);
		expect(PlanPreviewApp.styles.toString()).toContain("button:focus-visible");
	});
});