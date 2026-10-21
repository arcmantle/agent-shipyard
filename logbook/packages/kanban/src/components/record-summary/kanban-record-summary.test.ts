import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import { kanbanRecordSummaryRenderServiceContext } from "./kanban-record-summary.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanRecordSummary", () => {
	it("renders record summary data from its typed render service", async () => {
		new ContextProvider(document.body, {
			context: kanbanRecordSummaryRenderServiceContext,
			initialValue: {
				recordSummary: signal({
					metadata: "Issue",
					owner: "R. Lee",
					reference: "ISS-322",
					title: "Define the board-server write contract"
				})
			}
		});
		const recordSummary = document.createElement("kanban-record-summary");
		document.body.append(recordSummary);
		await recordSummary.updateComplete;

		expect(recordSummary.shadowRoot?.querySelector("article")?.getAttribute("aria-label")).toBe("Summary for ISS-322");
		expect(recordSummary.shadowRoot?.querySelector(".primary span")?.textContent).toContain("ISS-322");
		expect(recordSummary.shadowRoot?.querySelector("h2")?.textContent).toContain("Define the board-server write contract");
		expect(recordSummary.shadowRoot?.querySelector("dl")?.textContent).toContain("Metadata");
		expect(recordSummary.shadowRoot?.querySelector("dl")?.textContent).toContain("Issue");
		expect(recordSummary.shadowRoot?.querySelector("dl")?.textContent).toContain("Owner");
		expect(recordSummary.shadowRoot?.querySelector("dl")?.textContent).toContain("R. Lee");
	});

	it("updates when its render service signal changes", async () => {
		const recordSummaryState = signal({
			metadata: "Issue",
			owner: "R. Lee",
			reference: "ISS-322",
			title: "Define the board-server write contract"
		});
		new ContextProvider(document.body, {
			context: kanbanRecordSummaryRenderServiceContext,
			initialValue: { recordSummary: recordSummaryState }
		});
		const recordSummary = document.createElement("kanban-record-summary");
		document.body.append(recordSummary);
		await recordSummary.updateComplete;

		recordSummaryState.set({
			metadata: "Bug",
			owner: "A. Kim",
			reference: "ISS-489",
			title: "Preserve optimistic mutation state"
		});
		await recordSummary.updateComplete;

		expect(recordSummary.shadowRoot?.textContent).toContain("ISS-489");
		expect(recordSummary.shadowRoot?.textContent).toContain("Preserve optimistic mutation state");
		expect(recordSummary.shadowRoot?.textContent).toContain("Bug");
		expect(recordSummary.shadowRoot?.textContent).toContain("A. Kim");
	});
});