import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanDiscoveryService } from "./services/kanban-discovery-service.js";
import "./kanban-app.js";
import type { KanbanApp } from "./kanban-app.js";

afterEach(() => {
	document.body.replaceChildren();
	window.history.replaceState({}, "", "/");
});

describe("Kanban application discovery", () => {
	it("renders the deterministic Card fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-card");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-card");
		await showcase?.updateComplete;

		const card = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-card");
		expect(card).not.toBeNull();
		await card?.updateComplete;
		expect(card?.shadowRoot?.querySelector("button")?.getAttribute("aria-label")).toBe("Open ISS-322: Define the board-server write contract");
	});

	it("renders the deterministic Column fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-column");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-column");
		await showcase?.updateComplete;

		const column = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-column");
		expect(column).not.toBeNull();
		await column?.updateComplete;
		expect(column?.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Todo issues");
		expect(column?.shadowRoot?.textContent).toContain("2 issues");
	});

	it("renders the deterministic Record toolbar fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-record-toolbar");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-record-toolbar");
		await showcase?.updateComplete;

		const toolbar = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-record-toolbar");
		expect(toolbar).not.toBeNull();
		await toolbar?.updateComplete;
		expect(toolbar?.shadowRoot?.querySelector("h2")?.textContent).toBe("Editable Kanban board");
	});

	it("renders discovery loading and ready states through its service", async () => {
		let resolveFetch: (response: Response) => void;
		const pendingFetch = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const app = document.createElement("kanban-app") as KanbanApp & { discoveryService: KanbanDiscoveryService };
		app.discoveryService = new KanbanDiscoveryService(vi.fn().mockResolvedValue(pendingFetch));
		document.body.append(app);

		await app.updateComplete;

		expect(app.shadowRoot?.querySelector("[role=status]")?.textContent).toContain("Loading boards.");
		resolveFetch!(new Response(JSON.stringify({
			projects: [{ id: "agent-issues", name: "Agent Issues", boards: [{ id: "active-work", name: "Active work" }] }]
		}), { status: 200 }));
		await vi.waitFor(() => {
			expect(app.discoveryService.discovery.get()).toMatchObject({
				state: "ready",
				selectedProjectId: "agent-issues",
				selectedBoardId: "active-work"
			});
		});
	});

	it("lets a user select an available project and board", async () => {
		const app = document.createElement("kanban-app") as KanbanApp & { discoveryService: KanbanDiscoveryService };
		app.discoveryService = new KanbanDiscoveryService(vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
			projects: [
				{ id: "agent-issues", name: "Agent Issues", boards: [{ id: "active-work", name: "Active work" }] },
				{ id: "platform", name: "Platform", boards: [{ id: "backlog", name: "Backlog" }] }
			]
		}), { status: 200 }))));
		document.body.append(app);

		await vi.waitFor(() => {
			expect(app.shadowRoot?.textContent).toContain("Agent Issues");
		});
		const project = app.shadowRoot?.querySelector<HTMLSelectElement>("select[name=project]");
		project!.value = "platform";
		project!.dispatchEvent(new Event("change"));
		expect(app.discoveryService.discovery.get()).toMatchObject({
			state: "ready",
			selectedProjectId: "platform",
			selectedBoardId: "backlog"
		});
		await app.updateComplete;

		const board = app.shadowRoot?.querySelector<HTMLSelectElement>("select[name=board]");
		expect(board?.value).toBe("backlog");
	});

	it("renders discovery request failures from its service", async () => {
		const app = document.createElement("kanban-app") as KanbanApp & { discoveryService: KanbanDiscoveryService };
		app.discoveryService = new KanbanDiscoveryService(vi.fn().mockRejectedValue(new Error("Discovery unavailable.")));
		document.body.append(app);

		await app.discoveryService.load();
		await vi.waitFor(() => {
			expect(app.shadowRoot?.innerHTML).toContain("Discovery unavailable.");
		});
	});

	it("renders the deterministic Record summary fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-record-summary");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-record-summary");
		await showcase?.updateComplete;

		const recordSummary = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-record-summary");
		expect(recordSummary).not.toBeNull();
		await recordSummary?.updateComplete;
		expect(recordSummary?.shadowRoot?.textContent).toContain("Define the board-server write contract");
	});

	it("renders the deterministic Field editor fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-field-editor");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-field-editor");
		await showcase?.updateComplete;

		const fieldEditor = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-field-editor");
		expect(fieldEditor).not.toBeNull();
		await fieldEditor?.updateComplete;
		expect(fieldEditor?.shadowRoot?.querySelector<HTMLInputElement>("input")?.value).toBe("Define the board-server write contract");
	});

	it("renders the deterministic Relationship list fixture at its component route", async () => {
		window.history.replaceState({}, "", "/components/kanban-relationship-list");
		const app = document.createElement("kanban-app");
		document.body.append(app);
		await app.updateComplete;

		const showcase = app.shadowRoot?.querySelector<HTMLElement & { componentId?: string; updateComplete: Promise<boolean> }>("kanban-showcase");
		expect(showcase?.componentId).toBe("kanban-relationship-list");
		await showcase?.updateComplete;

		const relationshipList = showcase?.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kanban-relationship-list");
		expect(relationshipList).not.toBeNull();
		await relationshipList?.updateComplete;
		expect(relationshipList?.shadowRoot?.textContent).toContain("Editable Kanban board");
	});
});