// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssueBreakdownDraft } from "@agent-issues/core";

const appState = vi.hoisted(() => ({
	apps: [] as Array<{
		callServerTool: ReturnType<typeof vi.fn>;
		sendMessage: ReturnType<typeof vi.fn>;
		ontoolresult?: (result: { structuredContent?: unknown }) => void;
	}>
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
	App: class {
		public callServerTool = vi.fn();
		public sendMessage = vi.fn().mockResolvedValue({});
		public ontoolresult?: (result: { structuredContent?: unknown }) => void;
		public onhostcontextchanged?: () => void;

		constructor() {
			appState.apps.push(this);
		}

		public async connect(): Promise<void> {}

		public getHostContext(): undefined {
			return undefined;
		}
	},
	applyDocumentTheme: vi.fn(),
	applyHostFonts: vi.fn(),
	applyHostStyleVariables: vi.fn()
}));

function issueBreakdownDraft(): IssueBreakdownDraft {
	return {
		id: "draft-1",
		targetId: "initiative-1",
		targetReference: "INIT_123",
		issues: [],
		snapshotDigest: "a".repeat(64),
		status: "active",
		approvedAt: null,
		createdIssueReferences: []
	};
}

describe("Issue Preview host workflow", () => {
	afterEach(() => {
		document.body.replaceChildren();
		appState.apps.splice(0);
		vi.resetModules();
	});

	it("delivers the Issue Preview draft to the read-only app", async () => {
		document.body.innerHTML = "<issue-preview-app></issue-preview-app>";
		await import("./main.js");
		const app = appState.apps[0];
		const element = document.querySelector("issue-preview-app") as HTMLElement & {
			draft: IssueBreakdownDraft;
			updateComplete: Promise<unknown>;
		};
		const draft = issueBreakdownDraft();
		app.ontoolresult?.({ structuredContent: { draft } });
		await element.updateComplete;

		expect(element.draft).toEqual(draft);
		expect(app.callServerTool).not.toHaveBeenCalled();
		expect(app.sendMessage).not.toHaveBeenCalled();
	});
});