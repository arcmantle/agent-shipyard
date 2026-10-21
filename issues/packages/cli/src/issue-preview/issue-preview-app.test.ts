// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { IssueBreakdownDraft } from "@agent-issues/core";
import { IssuePreviewApp } from "./issue-preview-app.js";
import "./issue-preview-app.js";

function issueBreakdownDraft(): IssueBreakdownDraft {
	return {
		id: "draft-1",
		targetId: "initiative-1",
		targetReference: "INIT_123",
		issues: [
			{
				key: "storage",
				title: "Store the draft",
				outcome: "The proposed graph persists.",
				scope: ["Add draft storage."],
				workMode: "AFK",
				acceptanceCriteria: ["The draft has a digest."],
				planEntryIds: ["PLAN_ENTRY_123"],
				relationReferences: []
			},
			{
				key: "preview",
				title: "Show the preview",
				outcome: "The user can review it.",
				scope: ["Render the graph."],
				workMode: "HITL",
				acceptanceCriteria: ["The graph is read-only."],
				parentKey: "storage",
				relationReferences: [{ relationType: "blocks", targetKey: "storage" }, { relationType: "fixes", targetReference: "US_123" }]
			}
		],
		snapshotDigest: "a".repeat(64),
		status: "active",
		approvedAt: null,
		createdIssueReferences: []
	};
}

describe("IssuePreviewApp", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("shows a loading state until a draft arrives", async () => {
		const element = document.createElement("issue-preview-app") as HTMLElement & { updateComplete: Promise<unknown> };
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[role=status]")?.textContent).toContain("Loading Issue Preview.");
		expect(element.shadowRoot?.querySelector("button[data-action=toggle]")).toBeNull();
	});

	it("shows the proposed issue graph only after the review is expanded", async () => {
		const element = document.createElement("issue-preview-app") as HTMLElement & { draft: IssueBreakdownDraft; updateComplete: Promise<unknown> };
		element.draft = issueBreakdownDraft();
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("h1")?.textContent).toContain("Issue breakdown");
		const toggle = element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(element.shadowRoot?.textContent).not.toContain("Store the draft");
		toggle?.click();
		await element.updateComplete;

		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		expect(element.shadowRoot?.textContent).toContain("Store the draft");
		expect(element.shadowRoot?.textContent).toContain("The proposed graph persists.");
		expect(element.shadowRoot?.textContent).toContain("Add draft storage.");
		expect(element.shadowRoot?.textContent).toContain("AFK");
		expect(element.shadowRoot?.textContent).toContain("The draft has a digest.");
		expect(element.shadowRoot?.textContent).toContain("Plan entries");
		expect(element.shadowRoot?.textContent).toContain("PLAN_ENTRY_123");
		expect(element.shadowRoot?.textContent).toContain("Parent: storage");
		expect(element.shadowRoot?.textContent).toContain("blocks: storage");
		expect(element.shadowRoot?.textContent).toContain("fixes: US_123");
	});

	it("does not render approval or return actions", async () => {
		const element = document.createElement("issue-preview-app") as HTMLElement & { draft: IssueBreakdownDraft; updateComplete: Promise<unknown> };
		element.draft = issueBreakdownDraft();
		document.body.append(element);
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("button[data-action=approve]")).toBeNull();
		expect(element.shadowRoot?.querySelector("button[data-action=return]")).toBeNull();
	});

	it("keeps the review toggle keyboard-focusable", async () => {
		const element = document.createElement("issue-preview-app") as HTMLElement & { draft: IssueBreakdownDraft; updateComplete: Promise<unknown> };
		element.draft = issueBreakdownDraft();
		document.body.append(element);
		await element.updateComplete;

		const toggle = element.shadowRoot?.querySelector("button[data-action=toggle]") as HTMLButtonElement;
		expect(toggle.disabled).toBe(false);
		expect(toggle.tabIndex).toBeGreaterThanOrEqual(0);
		toggle.focus();
		expect(element.shadowRoot?.activeElement).toBe(toggle);
		expect(IssuePreviewApp.styles.toString()).toContain("button:focus-visible");
	});

	it("shows a changed-draft message and reload action", async () => {
		let reloads = 0;
		const element = document.createElement("issue-preview-app") as HTMLElement & {
			draft: IssueBreakdownDraft;
			errorMessage: string | null;
			retryAction: () => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		element.draft = issueBreakdownDraft();
		element.errorMessage = "Issue breakdown changed";
		element.retryAction = async () => {
			reloads += 1;
		};
		document.body.append(element);
		await element.updateComplete;
		(element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]"))?.click();
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[role=alert]")?.textContent).toContain("Issue breakdown changed");
		(element.shadowRoot?.querySelector("button[data-action=reload]") as HTMLButtonElement).click();
		await Promise.resolve();
		expect(reloads).toBe(1);
	});

	it("hides unused relations and displays the approved state", async () => {
		const element = document.createElement("issue-preview-app") as HTMLElement & { draft: IssueBreakdownDraft; updateComplete: Promise<unknown> };
		element.draft = { ...issueBreakdownDraft(), status: "approved", approvedAt: "2026-09-06T00:00:00.000Z", createdIssueReferences: ["ISS_123"] };
		document.body.append(element);
		await element.updateComplete;
		(element.shadowRoot?.querySelector<HTMLButtonElement>("button[data-action=toggle]"))?.click();
		await element.updateComplete;

		expect(element.shadowRoot?.querySelector("[data-issue=storage]")?.textContent).not.toContain("Relations");
		expect(element.shadowRoot?.querySelector("[data-state=approved]")?.textContent).toContain("Issue breakdown approved");
		expect(element.shadowRoot?.querySelector("button[data-action=approve]")).toBeNull();
	});
});