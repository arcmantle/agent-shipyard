import { provide } from "@lit/context";
import { signal } from "@lit-labs/signals";
import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { map } from "lit/directives/map.js";

import {
	kanbanCardRenderServiceContext,
	type KanbanCardRenderService,
	type KanbanCardState
} from "../card/kanban-card.js";
import {
	kanbanColumnRenderServiceContext,
	type KanbanColumnRenderService,
	type KanbanColumnState
} from "../column/kanban-column.js";

type KanbanBoardShowcaseColumnState = KanbanColumnState & {
	cards: readonly KanbanCardState[];
};

const boardColumns: readonly KanbanBoardShowcaseColumnState[] = [
	{
		cardCount: 2,
		cards: [
			{
				blockerCount: 2,
				due: { label: "Today", overdue: false },
				id: "issue-322",
				isBlocked: false,
				owner: "R. Lee",
				priority: { label: "High", variant: "high" },
				reference: "ISS-322",
				relationshipCount: 3,
				status: { label: "Todo", variant: "default" },
				title: "Define the board-server write contract"
			},
			{
				blockerCount: 0,
				due: { label: "Tomorrow", overdue: false },
				id: "issue-327",
				isBlocked: false,
				owner: "Unassigned",
				priority: { label: "Medium", variant: "medium" },
				reference: "ISS-327",
				relationshipCount: 1,
				status: { label: "Todo", variant: "default" },
				title: "Render a compact issue card"
			}
		],
		id: "todo",
		title: "Todo"
	},
	{
		cardCount: 2,
		cards: [
			{
				blockerCount: 0,
				due: { label: "Friday", overdue: false },
				id: "issue-318",
				isBlocked: false,
				owner: "R. Lee",
				priority: { label: "Medium", variant: "medium" },
				reference: "ISS-318",
				relationshipCount: 0,
				status: { label: "In progress", variant: "active" },
				title: "Keep pending edits stable through snapshot refresh"
			},
			{
				blockerCount: 0,
				due: { label: "Next week", overdue: false },
				id: "issue-320",
				isBlocked: false,
				owner: "M. Diaz",
				priority: { label: "Low", variant: "low" },
				reference: "ISS-320",
				relationshipCount: 1,
				status: { label: "In progress", variant: "active" },
				title: "Add separate relation sections to the overlay"
			}
		],
		id: "in-progress",
		title: "In progress"
	},
	{
		cardCount: 1,
		cards: [
			{
				blockerCount: 1,
				due: { label: "Overdue", overdue: true },
				id: "issue-319",
				isBlocked: true,
				owner: "A. Patel",
				priority: { label: "High", variant: "high" },
				reference: "ISS-319",
				relationshipCount: 1,
				status: { label: "Blocked", variant: "blocked" },
				title: "Start the detached Kanban server"
			}
		],
		id: "blocked",
		title: "Blocked"
	},
	{
		cardCount: 2,
		cards: [
			{
				blockerCount: 0,
				due: { label: "Complete", overdue: false },
				id: "issue-312",
				isBlocked: false,
				owner: "J. Chen",
				priority: { label: "Low", variant: "low" },
				reference: "ISS-312",
				relationshipCount: 0,
				status: { label: "Done", variant: "default" },
				title: "Specify optimistic mutation recovery"
			},
			{
				blockerCount: 0,
				due: { label: "Complete", overdue: false },
				id: "issue-309",
				isBlocked: false,
				owner: "M. Diaz",
				priority: { label: "Medium", variant: "medium" },
				reference: "ISS-309",
				relationshipCount: 2,
				status: { label: "Done", variant: "default" },
				title: "Set the shared Kanban token scale"
			}
		],
		id: "done",
		title: "Done"
	}
];

class KanbanBoardShowcaseCardRenderService implements KanbanCardRenderService {
	public card = signal<KanbanCardState>(boardColumns[0].cards[0]);

	public openCard() {}
}

class KanbanBoardShowcaseColumnRenderService implements KanbanColumnRenderService {
	public column = signal<KanbanColumnState>({
		cardCount: boardColumns[0].cardCount,
		id: boardColumns[0].id,
		title: boardColumns[0].title
	});
}

@customElement("kanban-board-showcase-card")
export class KanbanBoardShowcaseCard extends LitElement {
	@provide({ context: kanbanCardRenderServiceContext })
	public service = new KanbanBoardShowcaseCardRenderService();

	@property({ attribute: false })
	public card: KanbanCardState = boardColumns[0].cards[0];

	protected willUpdate() {
		this.service.card.set(this.card);
	}

	protected render() {
		return html`<kanban-card></kanban-card>`;
	}

	public static styles = css`
	:host {
		display: block;
	}
	`;
}

@customElement("kanban-board-showcase-column")
export class KanbanBoardShowcaseColumn extends LitElement {
	@provide({ context: kanbanColumnRenderServiceContext })
	public service = new KanbanBoardShowcaseColumnRenderService();

	@property({ attribute: false })
	public column: KanbanColumnState = boardColumns[0];

	protected willUpdate() {
		this.service.column.set(this.column);
	}

	protected render() {
		return html`
		<kanban-column>
			<slot></slot>
		</kanban-column>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-112);
	}
	`;
}

@customElement("kanban-board-showcase")
export class KanbanBoardShowcase extends LitElement {
	protected renderColumn(column: KanbanBoardShowcaseColumnState) {
		return html`
		<kanban-board-showcase-column .column=${column}>
			${map(column.cards, (card) => html`
			<kanban-board-showcase-card .card=${card}></kanban-board-showcase-card>
			`)}
		</kanban-board-showcase-column>
		`;
	}

	protected render() {
		return html`
		<kanban-board>
			${map(boardColumns, (column) => this.renderColumn(column))}
		</kanban-board>
		`;
	}

	public static styles = css`
	:host {
		display: block;
		min-width: var(--size-0);
		width: 100%;
	}
	`;
}

declare global {
	interface HTMLElementTagNameMap {
		"kanban-board-showcase": KanbanBoardShowcase;
		"kanban-board-showcase-card": KanbanBoardShowcaseCard;
		"kanban-board-showcase-column": KanbanBoardShowcaseColumn;
	}
}