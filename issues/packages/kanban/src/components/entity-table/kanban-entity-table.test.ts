import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanEntityTableRenderServiceContext,
	type KanbanEntityTableState
} from "./kanban-entity-table.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanEntityTable", () => {
	it("renders entity rows from its typed render service", async () => {
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: signal<KanbanEntityTableState>({
					caption: "Plans",
					columns: [
						{ id: "reference", label: "Record" },
						{ id: "summary", label: "Summary" },
						{ id: "scope", label: "Scope" },
						{ id: "status", label: "Status" }
					],
					rows: [{
						description: "Local server boundary, mutation handling, and browser recovery.",
						reference: "PLAN-014",
						scope: "4 issues",
						status: "In progress",
						title: "Kanban runtime delivery"
					}]
				}),
				openEntity: () => {}
		});
		const entityTable = document.createElement("kanban-entity-table");
		document.body.append(entityTable);
		await entityTable.updateComplete;

		expect(entityTable.shadowRoot?.querySelector("table")).not.toBeNull();
		expect(entityTable.shadowRoot?.querySelector("caption")?.textContent).toContain("Plans");
		expect(entityTable.shadowRoot?.querySelectorAll("th")).toHaveLength(5);
		expect(entityTable.shadowRoot?.textContent).toContain("PLAN-014");
		expect(entityTable.shadowRoot?.textContent).toContain("Kanban runtime delivery");
	});

	it("sends an open intent through the render service and semantic event", async () => {
		const openedEntityReferences: string[] = [];
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: signal<KanbanEntityTableState>({
					caption: "Plans",
					columns: [
						{ id: "reference", label: "Record" },
						{ id: "summary", label: "Summary" },
						{ id: "scope", label: "Scope" },
						{ id: "status", label: "Status" }
					],
					rows: [{
						description: "Local server boundary, mutation handling, and browser recovery.",
						reference: "PLAN-014",
						scope: "4 issues",
						status: "In progress",
						title: "Kanban runtime delivery"
					}]
				}),
				openEntity: (reference: string) => {
					openedEntityReferences.push(reference);
				}
		});
		const entityTable = document.createElement("kanban-entity-table");
		const eventReferences: string[] = [];
		entityTable.addEventListener("kanban-entity-open", (event) => {
			eventReferences.push(event.detail.reference);
		});
		document.body.append(entityTable);
		await entityTable.updateComplete;

		entityTable.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();

		expect(openedEntityReferences).toEqual(["PLAN-014"]);
		expect(eventReferences).toEqual(["PLAN-014"]);
	});

	it("updates when its render-service signal changes", async () => {
		const entityTableState = signal<KanbanEntityTableState>({
			caption: "Plans",
			columns: [
				{ id: "reference", label: "Record" },
				{ id: "summary", label: "Summary" },
				{ id: "scope", label: "Scope" },
				{ id: "status", label: "Status" }
			],
			rows: [{
				description: "Local server boundary, mutation handling, and browser recovery.",
				reference: "PLAN-014",
				scope: "4 issues",
				status: "In progress",
				title: "Kanban runtime delivery"
			}]
		});
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: entityTableState,
				openEntity: () => {}
		});
		const entityTable = document.createElement("kanban-entity-table");
		document.body.append(entityTable);
		await entityTable.updateComplete;

		entityTableState.set({
			caption: "Product requirements",
			columns: [
				{ id: "reference", label: "Record" },
				{ id: "summary", label: "Summary" },
				{ id: "scope", label: "Scope" },
				{ id: "status", label: "Status" }
			],
			rows: [{
				description: "Make initiative work visible, editable, and safe to recover.",
				reference: "PRD-009",
				scope: "5 stories",
				status: "Active",
				title: "Kanban board workspace"
			}]
		});
		await entityTable.updateComplete;

		expect(entityTable.shadowRoot?.querySelector("caption")?.textContent).toContain("Product requirements");
		expect(entityTable.shadowRoot?.textContent).toContain("PRD-009");
		expect(entityTable.shadowRoot?.textContent).toContain("Kanban board workspace");
	});

	it("renders tables without a Scope column", async () => {
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: signal<KanbanEntityTableState>({
					caption: "Architecture decisions",
					columns: [
						{ id: "reference", label: "Record" },
						{ id: "summary", label: "Decision" },
						{ id: "status", label: "Status" }
					],
					rows: [{
						description: "The browser does not read the local database directly.",
						reference: "ADR-014",
						status: "Accepted",
						title: "Serve the board through a detached local runtime"
					}]
				}),
				openEntity: () => {}
		});
		const entityTable = document.createElement("kanban-entity-table");
		document.body.append(entityTable);
		await entityTable.updateComplete;

		expect(entityTable.shadowRoot?.querySelectorAll("th")).toHaveLength(4);
		expect(entityTable.shadowRoot?.querySelectorAll("tbody td")).toHaveLength(4);
		expect(entityTable.shadowRoot?.textContent).toContain("ADR-014");
		expect(entityTable.shadowRoot?.textContent).toContain("Accepted");
	});

	it("uses its table columns to align headers and cells", async () => {
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: signal<KanbanEntityTableState>({
					caption: "Architecture decisions",
					columns: [
						{ id: "reference", label: "Record" },
						{ id: "summary", label: "Decision" },
						{ id: "status", label: "Status" }
					],
					rows: [{
						description: "The browser does not read the local database directly.",
						reference: "ADR-014",
						scope: "Not displayed",
						status: "Accepted",
						title: "Serve the board through a detached local runtime"
					}]
				}),
				openEntity: () => {}
		});
		const entityTable = document.createElement("kanban-entity-table");
		document.body.append(entityTable);
		await entityTable.updateComplete;

		expect(entityTable.shadowRoot?.querySelectorAll("th")).toHaveLength(4);
		expect(entityTable.shadowRoot?.querySelectorAll("tbody td")).toHaveLength(4);
		expect(entityTable.shadowRoot?.querySelector("th:nth-child(2)")?.textContent).toContain("Decision");
	});

	it("keeps Scope cells aligned when a row has no Scope value", async () => {
		new ContextProvider(document.body, kanbanEntityTableRenderServiceContext, {
				entityTable: signal<KanbanEntityTableState>({
					caption: "Plans",
					columns: [
						{ id: "reference", label: "Record" },
						{ id: "summary", label: "Summary" },
						{ id: "scope", label: "Scope" },
						{ id: "status", label: "Status" }
					],
					rows: [{
						description: "A plan with no recorded scope.",
						reference: "PLAN-016",
						status: "Draft",
						title: "Release readiness"
					}]
				}),
				openEntity: () => {}
		});
		const entityTable = document.createElement("kanban-entity-table");
		document.body.append(entityTable);
		await entityTable.updateComplete;

		expect(entityTable.shadowRoot?.querySelectorAll("th")).toHaveLength(5);
		expect(entityTable.shadowRoot?.querySelectorAll("tbody td")).toHaveLength(5);
		expect(entityTable.shadowRoot?.querySelector("tbody td:nth-child(3)")?.textContent).toBe("");
	});
});