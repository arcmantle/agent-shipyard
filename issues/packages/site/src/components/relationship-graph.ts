import { LitElement, css, html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import type { GraphNode, RelationshipGraph } from "../models.js";

const KIND_COLOR: Record<string, string> = {
	adr: "var(--graph-adr)",
	debt: "var(--graph-debt)",
	initiative: "var(--graph-initiative)",
	issue: "var(--graph-issue)",
	prd: "var(--success)",
	project: "var(--graph-project)",
	story: "var(--graph-story)"
};

const STATUS_STROKE: Record<string, string> = {
	blocked: "var(--danger)",
	done: "var(--done)"
};

const NODE_W = 184;
const NODE_H = 34;
const COL_GAP = 244;
const PAD_X = 28;
const PAD_TOP = 56;
const ROW_H = 58;

type NodePosition = {
	x: number;
	y: number;
	cx: number;
	cy: number;
};

function truncateLabel(label: string, max: number) {
	return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

class RelationshipGraphView extends LitElement {
	static properties = {
		graph: { attribute: false }
	};

	public graph: RelationshipGraph | null = null;
	public themeObserver: MutationObserver | null = null;

	connectedCallback(): void {
		super.connectedCallback();
		this.themeObserver = new MutationObserver(() => this.requestUpdate());
		this.themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"], attributes: true });
	}

	disconnectedCallback(): void {
		this.themeObserver?.disconnect();
		this.themeObserver = null;
		super.disconnectedCallback();
	}

	protected onNodeClick(node: GraphNode) {
		this.dispatchEvent(
			new CustomEvent("node-open", {
				bubbles: true,
				composed: true,
				detail: { id: node.id, kind: node.kind }
			})
		);
	}

	protected nodeColor(node: GraphNode) {
		return KIND_COLOR[node.kind] ?? "var(--muted)";
	}

	protected nodeStroke(node: GraphNode) {
		if (node.kind === "issue" && node.status && STATUS_STROKE[node.status]) {
			return STATUS_STROKE[node.status];
		}

		return this.nodeColor(node);
	}

	render() {
		const graph = this.graph;
		if (!graph || graph.nodes.length === 0) {
			return nothing;
		}

		const columnNodes = new Map<number, GraphNode[]>();
		for (const node of graph.nodes) {
			const list = columnNodes.get(node.col) ?? [];
			list.push(node);
			columnNodes.set(node.col, list);
		}

		const columnIndices = [...columnNodes.keys()].sort((a, b) => a - b);
		const columns = Math.max(...graph.nodes.map((node) => node.col)) + 1;
		const maxCount = Math.max(...columnIndices.map((col) => columnNodes.get(col)?.length ?? 0));
		const width = PAD_X * 2 + (columns - 1) * COL_GAP + NODE_W;
		const height = PAD_TOP + maxCount * ROW_H + 24;

		const positions = new Map<string, NodePosition>();
		for (const col of columnIndices) {
			const list = columnNodes.get(col) ?? [];
			list.forEach((node, index) => {
				const x = PAD_X + col * COL_GAP;
				const y = PAD_TOP + index * ROW_H;
				positions.set(node.key, { cx: x + NODE_W / 2, cy: y + NODE_H / 2, x, y });
			});
		}

		const heads = graph.columns
			.map((title, col) => ({ col, title }))
			.filter((entry) => columnNodes.has(entry.col));

		return html`
		<svg
			width=${width}
			height=${height}
			viewBox=${`0 0 ${width} ${height}`}
			xmlns="http://www.w3.org/2000/svg"
		>
			${repeat(
				heads,
				(entry) => `head-${entry.col}`,
				(entry) => svg`<text
					class="ai-colhead"
					x=${PAD_X + entry.col * COL_GAP + NODE_W / 2}
					y="28"
					text-anchor="middle"
				>${entry.title}</text>`
			)}
			${repeat(
				graph.edges.filter((edge) => positions.has(edge.from) && positions.has(edge.to)),
				(edge) => `${edge.from}->${edge.to}`,
				(edge) => {
					const a = positions.get(edge.from)!;
					const b = positions.get(edge.to)!;
					const x1 = a.cx + NODE_W / 2;
					const y1 = a.cy;
					const x2 = b.cx - NODE_W / 2;
					const y2 = b.cy;
					return svg`
						<path
							class="ai-edge"
							d=${`M${x1} ${y1} C ${x1 + 46} ${y1}, ${x2 - 46} ${y2}, ${x2} ${y2}`}
							fill="none"
							stroke="var(--graph-edge)"
							stroke-width="1.5"
						/>
						${when(
							edge.label,
							() => svg`<text
								class="ai-edge-label"
								x=${(x1 + x2) / 2}
								y=${(y1 + y2) / 2 - 5}
								text-anchor="middle"
							>${edge.label}</text>`,
							() => nothing
						)}
					`;
				}
			)}
			${repeat(
				graph.nodes,
				(node) => node.key,
				(node) => {
					const position = positions.get(node.key)!;
					const color = this.nodeColor(node);
					const stroke = this.nodeStroke(node);
					const clickable = node.kind !== "project";
					return svg`<g
						class=${clickable ? "ai-node" : "ai-node ai-node-static"}
						data-id=${node.id}
						data-kind=${node.kind}
						style=${`cursor:${clickable ? "pointer" : "default"}`}
						@click=${clickable ? () => this.onNodeClick(node) : nothing}
					>
						<title>${node.fullLabel || node.label}</title>
						<rect
							class="ai-node-rect"
							x=${position.x}
							y=${position.y}
							width=${NODE_W}
							height=${NODE_H}
							rx="9"
							fill="var(--surface)"
							stroke=${stroke}
							stroke-width="1.5"
						/>
						<circle
							cx=${position.x + 15}
							cy=${position.cy}
							r="5"
							fill=${color}
						/>
						<text
							class="ai-node-label"
							x=${position.x + 28}
							y=${position.cy + 4}
						>${truncateLabel(node.label, 21)}</text>
					</g>`;
				}
			)}
		</svg>
		`;
	}

	static styles = css`
	:host {
		display: block;
	}
	svg {
		display: block;
	}
	.ai-node-label {
		font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		fill: var(--text);
		pointer-events: none;
	}
	.ai-colhead {
		font: 700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		fill: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.ai-edge-label {
		font: 600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		fill: var(--muted);
		pointer-events: none;
	}
	.ai-node-rect {
		transition: stroke-width 0.1s, filter 0.1s;
	}
	.ai-node:not(.ai-node-static):hover .ai-node-rect {
		stroke-width: 3;
			filter: drop-shadow(0 2px 6px var(--shadow));
	}
	`;
}

customElements.define("agent-issues-relationship-graph", RelationshipGraphView);

declare global {
	interface HTMLElementTagNameMap {
		"agent-issues-relationship-graph": RelationshipGraphView;
	}
}
