import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	kanbanRecordToolbarRenderServiceContext,
	type KanbanRecordToolbarState
} from "./kanban-record-toolbar.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanRecordToolbar", () => {
	it("renders accessible record controls from its typed render service", async () => {
		const recordToolbar = signal<KanbanRecordToolbarState>({
			actions: [
				{ id: "details", label: "Record details" },
				{ id: "create", label: "Create issue" }
			],
			filter: "all",
			filterOptions: [
				{ label: "All issues", value: "all" },
				{ label: "Todo", value: "todo" }
			],
			query: "",
			reference: "INIT-05",
			title: "Editable Kanban board",
			view: "board"
		});
		new ContextProvider(document.body, kanbanRecordToolbarRenderServiceContext, {
			recordToolbar,
			performAction: () => undefined,
			setFilter: () => undefined,
			setQuery: () => undefined,
			setView: () => undefined
		});
		const toolbar = document.createElement("kanban-record-toolbar");
		document.body.append(toolbar);
		await toolbar.updateComplete;

		expect(toolbar.shadowRoot?.querySelector("section")?.getAttribute("aria-label")).toBe("Editable Kanban board controls");
		expect(toolbar.shadowRoot?.querySelector("code")?.textContent).toBe("INIT-05");
		expect(toolbar.shadowRoot?.querySelector("h2")?.textContent).toBe("Editable Kanban board");
		expect(toolbar.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.placeholder).toBe("Search records");
		expect(toolbar.shadowRoot?.querySelector<HTMLSelectElement>("select")?.value).toBe("all");
		expect(toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[data-view=board]")?.getAttribute("aria-pressed")).toBe("true");

		recordToolbar.set({
			...recordToolbar.get(),
			query: "server",
			title: "Shared Kanban board",
			view: "table"
		});
		await toolbar.updateComplete;

		expect(toolbar.shadowRoot?.querySelector("h2")?.textContent).toBe("Shared Kanban board");
		expect(toolbar.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("server");
		expect(toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[data-view=table]")?.getAttribute("aria-pressed")).toBe("true");
	});

	it("sends an action intent through its render service and semantic event", async () => {
		const performAction = vi.fn();
		new ContextProvider(document.body, kanbanRecordToolbarRenderServiceContext, {
			recordToolbar: signal<KanbanRecordToolbarState>({
				actions: [{ id: "create", label: "Create issue" }],
				filter: "all",
				filterOptions: [{ label: "All issues", value: "all" }],
				query: "",
				reference: "INIT-05",
				title: "Editable Kanban board",
				view: "board"
			}),
			performAction,
			setFilter: () => undefined,
			setQuery: () => undefined,
			setView: () => undefined
		});
		const toolbar = document.createElement("kanban-record-toolbar");
		const intent = vi.fn();
		toolbar.addEventListener("kanban-record-toolbar-action", intent);
		document.body.append(toolbar);
		await toolbar.updateComplete;

		toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[data-action-id=create]")?.click();

		expect(performAction).toHaveBeenCalledWith("create");
		expect(intent).toHaveBeenCalledOnce();
		expect(intent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ detail: { actionId: "create" } }));
	});

	it("sends query, filter, and view intents through its render service", async () => {
		const setFilter = vi.fn();
		const setQuery = vi.fn();
		const setView = vi.fn();
		new ContextProvider(document.body, kanbanRecordToolbarRenderServiceContext, {
			recordToolbar: signal<KanbanRecordToolbarState>({
				actions: [],
				filter: "all",
				filterOptions: [
					{ label: "All issues", value: "all" },
					{ label: "Blocked", value: "blocked" }
				],
				query: "",
				reference: "INIT-05",
				title: "Editable Kanban board",
				view: "board"
			}),
			performAction: () => undefined,
			setFilter,
			setQuery,
			setView
		});
		const toolbar = document.createElement("kanban-record-toolbar");
		const filterIntent = vi.fn();
		const queryIntent = vi.fn();
		const viewIntent = vi.fn();
		toolbar.addEventListener("kanban-record-toolbar-filter", filterIntent);
		toolbar.addEventListener("kanban-record-toolbar-query", queryIntent);
		toolbar.addEventListener("kanban-record-toolbar-view", viewIntent);
		document.body.append(toolbar);
		await toolbar.updateComplete;

		const search = toolbar.shadowRoot?.querySelector<HTMLInputElement>("input[type=search]");
		if (search === undefined || search === null) {
			throw new Error("The Record toolbar search control did not render.");
		}
		search.value = "server contract";
		search.dispatchEvent(new InputEvent("input"));
		const filter = toolbar.shadowRoot?.querySelector<HTMLSelectElement>("select");
		if (filter === undefined || filter === null) {
			throw new Error("The Record toolbar filter did not render.");
		}
		filter.value = "blocked";
		filter.dispatchEvent(new Event("change"));
		toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[data-view=table]")?.click();

		expect(setQuery).toHaveBeenCalledWith("server contract");
		expect(queryIntent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ detail: { query: "server contract" } }));
		expect(setFilter).toHaveBeenCalledWith("blocked");
		expect(filterIntent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ detail: { filter: "blocked" } }));
		expect(setView).toHaveBeenCalledWith("table");
		expect(viewIntent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ detail: { view: "table" } }));
	});
});