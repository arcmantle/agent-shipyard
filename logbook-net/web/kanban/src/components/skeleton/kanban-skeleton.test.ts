import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanSkeletonRenderServiceContext,
	type KanbanSkeletonState
} from "./kanban-skeleton.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanSkeleton", () => {
	it("renders a card loading skeleton from its typed render service", async () => {
		new ContextProvider(document.body, kanbanSkeletonRenderServiceContext, {
			skeleton: signal<KanbanSkeletonState>({ layout: "card" })
		});
		const skeleton = document.createElement("kanban-skeleton");
		document.body.append(skeleton);
		await skeleton.updateComplete;

		const status = skeleton.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.getAttribute("aria-busy")).toBe("true");
		expect(status?.getAttribute("aria-label")).toBe("Loading card");
		expect(status?.querySelector(".skeleton-card")).not.toBeNull();
	});

	it("updates its loading layout when its service signal changes", async () => {
		const skeletonState = signal<KanbanSkeletonState>({ layout: "card" });
		new ContextProvider(document.body, kanbanSkeletonRenderServiceContext, {
			skeleton: skeletonState
		});
		const skeleton = document.createElement("kanban-skeleton");
		document.body.append(skeleton);
		await skeleton.updateComplete;

		skeletonState.set({ layout: "table" });
		await skeleton.updateComplete;

		const status = skeleton.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.getAttribute("aria-label")).toBe("Loading table");
		expect(status?.querySelector(".skeleton-table")).not.toBeNull();
		expect(status?.querySelector(".skeleton-card")).toBeNull();
	});

	it("renders a record-panel loading skeleton from its typed render service", async () => {
		new ContextProvider(document.body, kanbanSkeletonRenderServiceContext, {
			skeleton: signal<KanbanSkeletonState>({ layout: "panel" })
		});
		const skeleton = document.createElement("kanban-skeleton");
		document.body.append(skeleton);
		await skeleton.updateComplete;

		const status = skeleton.shadowRoot?.querySelector<HTMLElement>("[role=status]");
		expect(status?.getAttribute("aria-label")).toBe("Loading record panel");
		expect(status?.querySelector(".skeleton-panel")).not.toBeNull();
	});
});
