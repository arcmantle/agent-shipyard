import { afterEach, describe, expect, it } from "vitest";

import "./relationship-graph.js";
import type { RelationshipGraph } from "../models.js";

function makeGraph(): RelationshipGraph {
	return {
		columns: ["Initiative", "PRDs & ADRs", "User stories", "Issues"],
		edges: [
			{ from: "INIT1", to: "US1" },
			{ from: "US1", to: "ISS1" }
		],
		nodes: [
			{ col: 0, fullLabel: "Console Viewer", id: "INIT1", key: "INIT1", kind: "initiative", label: "Console Viewer" },
			{ col: 2, fullLabel: "Explore the graph", id: "US1", key: "US1", kind: "story", label: "Explore the graph" },
			{ col: 3, fullLabel: "Render nodes", id: "ISS1", key: "ISS1", kind: "issue", label: "Render nodes", status: "done" }
		]
	};
}

async function mountGraph(graph: RelationshipGraph | null) {
	const view = document.createElement("agent-issues-relationship-graph");
	view.graph = graph;
	document.body.appendChild(view);
	await view.updateComplete;
	return view;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("relationship graph", () => {
	it("renders one SVG node per graph node", async () => {
		const view = await mountGraph(makeGraph());

		const nodes = view.shadowRoot?.querySelectorAll(".ai-node") ?? [];
		expect(nodes.length).toBe(3);
	});

	it("uses graph theme tokens for nodes and edges", async () => {
		const view = await mountGraph(makeGraph());

		expect(view.shadowRoot?.querySelector('.ai-node[data-id="INIT1"] .ai-node-rect')?.getAttribute("fill")).toBe("var(--surface)");
		expect(view.shadowRoot?.querySelector('.ai-node[data-id="INIT1"] circle')?.getAttribute("fill")).toBe("var(--graph-initiative)");
		expect(view.shadowRoot?.querySelector(".ai-edge")?.getAttribute("stroke")).toBe("var(--graph-edge)");
	});

	it("emits node-open with the record id when a node is clicked", async () => {
		const view = await mountGraph(makeGraph());
		let openedId: string | null = null;
		view.addEventListener("node-open", (event) => {
			openedId = (event as CustomEvent<{ id: string }>).detail.id;
		});

		const issueNode = view.shadowRoot?.querySelector<SVGGElement>('.ai-node[data-id="ISS1"]');
		issueNode?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

		expect(openedId).toBe("ISS1");
	});

	it("renders a relationship label for a labeled edge", async () => {
		const graph = makeGraph();
		graph.edges = [{ from: "US1", label: "resolves", to: "ISS1" }];
		const view = await mountGraph(graph);

		expect(view.shadowRoot?.querySelector(".ai-edge-label")?.textContent).toBe("resolves");
	});
});
