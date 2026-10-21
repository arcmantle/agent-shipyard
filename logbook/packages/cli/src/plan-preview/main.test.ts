// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProposedPlan } from "@agent-issues/core";

const appState = vi.hoisted(() => ({
	apps: [] as Array<{
		callServerTool: ReturnType<typeof vi.fn>;
		sendMessage: ReturnType<typeof vi.fn>;
		openLink: ReturnType<typeof vi.fn>;
		ontoolresult?: (result: { structuredContent?: unknown }) => void;
	}>
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
	App: class {
		public callServerTool = vi.fn();
		public sendMessage = vi.fn().mockResolvedValue({});
		public openLink = vi.fn().mockResolvedValue({});
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

function proposedPlan(): ProposedPlan & { status: string; revision: number } {
	return {
		reference: "PLAN_123",
		title: "Plan Preview Design",
		goal: "Review the Plan before it becomes ready.",
		context: "Use the MCP Apps contract.",
		revision: 3,
		current: [],
		hasActiveQuestions: false,
		snapshotDigest: "a".repeat(64),
		status: "in-progress"
	};
}

describe("Plan Preview host workflow", () => {
	afterEach(() => {
		document.body.replaceChildren();
		appState.apps.splice(0);
		vi.resetModules();
	});

	it("delivers the Plan Preview and opens links through the host", async () => {
		document.body.innerHTML = "<plan-preview-app></plan-preview-app>";
		await import("./main.js");
		const app = appState.apps[0];
		const element = document.querySelector("plan-preview-app") as HTMLElement & {
			plan: ProposedPlan & { status: string };
			openLink: (url: string) => Promise<void>;
			updateComplete: Promise<unknown>;
		};
		const plan = proposedPlan();
		app.ontoolresult?.({ structuredContent: { plan } });
		await element.updateComplete;

		expect(element.plan).toEqual(plan);
		expect(app.callServerTool).not.toHaveBeenCalled();
		expect(app.sendMessage).not.toHaveBeenCalled();

		await element.openLink("https://example.test/plan");
		expect(app.openLink).toHaveBeenCalledWith({ url: "https://example.test/plan" });
	});
});
