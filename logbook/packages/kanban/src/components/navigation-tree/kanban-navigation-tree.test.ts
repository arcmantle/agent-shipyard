import { ContextProvider } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { afterEach, describe, expect, it } from "vitest";

import {
	kanbanNavigationTreeRenderServiceContext,
	type KanbanNavigationTreeState
} from "./kanban-navigation-tree.js";

afterEach(() => {
	document.body.replaceChildren();
});

describe("KanbanNavigationTree", () => {
	it("updates the visible tree when the service changes expanded nodes", async () => {
		const navigationTreeState = signal<KanbanNavigationTreeState>({
			expandedNodeIds: ["project-agent-issues"],
			navigationLabel: "Project navigation",
			nodes: [{
				children: [{ id: "issue-navigation-tree", kind: "Issue", label: "Implement Navigation tree component" }],
				id: "project-agent-issues",
				kind: "Project",
				label: "Agent Issues"
			}]
		});
		new ContextProvider(document.body, {
			context: kanbanNavigationTreeRenderServiceContext,
			initialValue: {
				navigationTree: navigationTreeState,
				selectNode: () => undefined,
				toggleNode: () => undefined
			}
		});
		const navigationTree = document.createElement("kanban-navigation-tree");
		document.body.append(navigationTree);
		await navigationTree.updateComplete;

		navigationTreeState.set({ ...navigationTreeState.get(), expandedNodeIds: [] });
		await navigationTree.updateComplete;

		expect(navigationTree.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
		expect(navigationTree.shadowRoot?.textContent).not.toContain("Implement Navigation tree component");
	});

	it("sends record selection through the render service and semantic event", async () => {
		const navigationTreeState = signal<KanbanNavigationTreeState>({
			expandedNodeIds: [],
			navigationLabel: "Project navigation",
			nodes: [{ id: "issue-navigation-tree", kind: "Issue", label: "Implement Navigation tree component" }]
		});
		const selectedNodeIds: string[] = [];
		new ContextProvider(document.body, {
			context: kanbanNavigationTreeRenderServiceContext,
			initialValue: {
				navigationTree: navigationTreeState,
				selectNode: (nodeId) => {
					selectedNodeIds.push(nodeId);
				},
				toggleNode: () => undefined
			}
		});
		const navigationTree = document.createElement("kanban-navigation-tree");
		const events: Array<{ nodeId: string }> = [];
		navigationTree.addEventListener("kanban-navigation-tree-select", (event) => {
			events.push(event.detail);
		});
		document.body.append(navigationTree);
		await navigationTree.updateComplete;

		navigationTree.shadowRoot?.querySelector<HTMLButtonElement>("button.navigation-tree-record")?.click();

		expect(selectedNodeIds).toEqual(["issue-navigation-tree"]);
		expect(events).toEqual([{ nodeId: "issue-navigation-tree" }]);
	});

	it("renders service-backed records and sends a node toggle intent", async () => {
		const navigationTreeState = signal<KanbanNavigationTreeState>({
			expandedNodeIds: ["project-agent-issues"],
			navigationLabel: "Project, epic, initiative, and record navigation",
			nodes: [{
			children: [{
				current: true,
				id: "issue-navigation-tree",
				kind: "Issue",
				label: "Implement Navigation tree component"
			}],
			id: "project-agent-issues",
			kind: "Project",
			label: "Agent Issues"
		}]
		});
		const toggledNodeIds: string[] = [];
		new ContextProvider(document.body, {
			context: kanbanNavigationTreeRenderServiceContext,
			initialValue: {
				navigationTree: navigationTreeState,
				selectNode: () => undefined,
				toggleNode: (nodeId) => {
					toggledNodeIds.push(nodeId);
				}
			}
		});
		const navigationTree = document.createElement("kanban-navigation-tree");
		const events: Array<{ nodeId: string }> = [];
		navigationTree.addEventListener("kanban-navigation-tree-toggle", (event) => {
			events.push(event.detail);
		});
		document.body.append(navigationTree);
		await navigationTree.updateComplete;

		expect(navigationTree.shadowRoot?.querySelector("nav")?.getAttribute("aria-label")).toBe("Project, epic, initiative, and record navigation");
		expect(navigationTree.shadowRoot?.querySelector("button[aria-current=page]")?.textContent).toContain("Implement Navigation tree component");
		expect(navigationTree.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.getAttribute("aria-label")).toBe("Collapse Project Agent Issues");

		navigationTree.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();

		expect(toggledNodeIds).toEqual(["project-agent-issues"]);
		expect(events).toEqual([{ nodeId: "project-agent-issues" }]);
	});
});