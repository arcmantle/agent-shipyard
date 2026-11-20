import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanCardMetadataRenderServiceContext,
	type KanbanCardMetadataState
} from "./kanban-card-metadata.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanCardMetadata", () => {
	it("renders accessible card metadata from its typed render service", async () => {
		new ContextProvider(document.body, kanbanCardMetadataRenderServiceContext, {
			cardMetadata: signal<KanbanCardMetadataState>({
				blockerCount: 2,
				due: { label: "Overdue", overdue: true },
				owner: "R. Lee",
				priority: { label: "High", variant: "high" },
				reference: "ISS-322",
				relationshipCount: 1,
				status: { label: "Todo", variant: "default" }
			})
		});
		const element = document.createElement("kanban-card-metadata");
		document.body.append(element);
		await element.updateComplete;

		const metadata = element.shadowRoot?.querySelector<HTMLElement>("section");
		expect(metadata?.getAttribute("aria-label")).toBe("Metadata for ISS-322");
		expect(element.shadowRoot?.textContent).toContain("Todo");
		expect(element.shadowRoot?.textContent).toContain("High");
		expect(element.shadowRoot?.querySelector("dt")?.textContent).toBe("Owner");
		expect(element.shadowRoot?.textContent).toContain("R. Lee");
		expect(element.shadowRoot?.querySelector("dd.is-overdue")?.textContent).toBe("Overdue");
		expect(element.shadowRoot?.querySelector("dd.is-blocked")?.textContent).toBe("2 blockers");
		expect(element.shadowRoot?.textContent).toContain("1 relationship");
	});

	it("updates its metadata when the service signal changes", async () => {
		const cardMetadata = signal<KanbanCardMetadataState>({
			blockerCount: 0,
			due: { label: "No due date", overdue: false },
			owner: "Unassigned",
			priority: { label: "Low", variant: "low" },
			reference: "ISS-322",
			relationshipCount: 0,
			status: { label: "Todo", variant: "default" }
		});
		new ContextProvider(document.body, kanbanCardMetadataRenderServiceContext, { cardMetadata });
		const element = document.createElement("kanban-card-metadata");
		document.body.append(element);
		await element.updateComplete;

		cardMetadata.set({
			blockerCount: 1,
			due: { label: "Overdue", overdue: true },
			owner: "R. Lee",
			priority: { label: "High", variant: "high" },
			reference: "ISS-322",
			relationshipCount: 2,
			status: { label: "Blocked", variant: "blocked" }
		});
		await element.updateComplete;

		expect(element.shadowRoot?.textContent).toContain("Blocked");
		expect(element.shadowRoot?.querySelector(".status-badge")?.classList.contains("is-blocked")).toBe(true);
		expect(element.shadowRoot?.querySelector(".priority-badge")?.classList.contains("is-high")).toBe(true);
		expect(element.shadowRoot?.textContent).toContain("R. Lee");
		expect(element.shadowRoot?.querySelector("dd.is-overdue")?.textContent).toBe("Overdue");
		expect(element.shadowRoot?.querySelector("dd.is-blocked")?.textContent).toBe("1 blocker");
		expect(element.shadowRoot?.textContent).toContain("2 relationships");
	});
});