import { signal } from "@lit-labs/signals";

import type { KanbanNavigationTreeRenderService, KanbanNavigationTreeState } from "../components/navigation-tree/kanban-navigation-tree.js";

const navigationTree: KanbanNavigationTreeState = {
	expandedNodeIds: ["project-agent-issues", "epic-platform-foundations", "initiative-editable-kanban-board"],
	navigationLabel: "Project, epic, initiative, and record navigation",
	nodes: [{
		children: [{
			children: [{
				children: [
					{ current: true, id: "issue-navigation-tree", kind: "Issue", label: "Implement Navigation tree component" },
					{ id: "issue-board-contract", kind: "Issue", label: "Define the board-server write contract" }
				],
				id: "initiative-editable-kanban-board",
				kind: "Initiative",
				label: "Editable Kanban board"
			}],
			id: "epic-platform-foundations",
			kind: "Epic",
			label: "Platform foundations"
		}],
		id: "project-agent-issues",
		kind: "Project",
		label: "Agent Issues"
	}]
};

export class NavigationTreeFixtureRenderService implements KanbanNavigationTreeRenderService {
	public navigationTree = signal(navigationTree);
	public selectedNodeIds: string[] = [];
	public toggledNodeIds: string[] = [];

	public selectNode(nodeId: string) {
		this.selectedNodeIds.push(nodeId);
	}

	public toggleNode(nodeId: string) {
		this.toggledNodeIds.push(nodeId);
		const state = this.navigationTree.get();
		const expandedNodeIds = state.expandedNodeIds.includes(nodeId)
			? state.expandedNodeIds.filter((expandedNodeId) => expandedNodeId !== nodeId)
			: [...state.expandedNodeIds, nodeId];
		this.navigationTree.set({ ...state, expandedNodeIds });
	}
}

export function createNavigationTreeShowcaseFixture(): NavigationTreeFixtureRenderService {
	return new NavigationTreeFixtureRenderService();
}