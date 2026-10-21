import { signal } from "@lit-labs/signals";

export const KANBAN_DISCOVERY_PATH = "/__agent_issues/kanban/discovery";

export type KanbanBoard = {
	id: string;
	name: string;
};

export type KanbanProject = {
	id: string;
	name: string;
	boards: KanbanBoard[];
};

export type KanbanDiscoveryState =
	| { state: "loading"; projects: KanbanProject[]; selectedProjectId: null; selectedBoardId: null }
	| { state: "ready"; projects: KanbanProject[]; selectedProjectId: string; selectedBoardId: string }
	| { state: "error"; projects: KanbanProject[]; selectedProjectId: null; selectedBoardId: null; message: string };

type KanbanDiscoveryResponse = {
	projects: KanbanProject[];
};

type KanbanFetch = (input: RequestInfo | URL) => Promise<Response>;

export class KanbanDiscoveryService {
	constructor(fetcher: KanbanFetch) {
		this.fetcher = fetcher;
		this.discovery = signal<KanbanDiscoveryState>({
			state: "loading",
			projects: [],
			selectedProjectId: null,
			selectedBoardId: null
		});
	}

	public discovery: ReturnType<typeof signal<KanbanDiscoveryState>>;

	protected fetcher: KanbanFetch;

	public async load(): Promise<void> {
		this.discovery.set({
			state: "loading",
			projects: [],
			selectedProjectId: null,
			selectedBoardId: null
		});

		try {
			const response = await this.fetcher(KANBAN_DISCOVERY_PATH);
			if (!response.ok) {
				throw new Error(`Discovery request failed with status ${response.status}.`);
			}

			const { projects } = await response.json() as KanbanDiscoveryResponse;
			const project = projects[0];
			const board = project?.boards[0];
			if (project === undefined || board === undefined) {
				throw new Error("Discovery response did not include a project board.");
			}

			this.discovery.set({
				state: "ready",
				projects,
				selectedProjectId: project.id,
				selectedBoardId: board.id
			});
		} catch (error) {
			this.discovery.set({
				state: "error",
				projects: [],
				selectedProjectId: null,
				selectedBoardId: null,
				message: error instanceof Error ? error.message : "Discovery request failed."
			});
		}
	}

	public selectProject(projectId: string): void {
		const discovery = this.discovery.get();
		if (discovery.state !== "ready") {
			return;
		}

		const project = discovery.projects.find((candidate) => candidate.id === projectId);
		const board = project?.boards[0];
		if (project === undefined || board === undefined) {
			return;
		}

		this.discovery.set({
			...discovery,
			selectedProjectId: project.id,
			selectedBoardId: board.id
		});
	}

	public selectBoard(boardId: string): void {
		const discovery = this.discovery.get();
		if (discovery.state !== "ready") {
			return;
		}

		const project = discovery.projects.find((candidate) => candidate.id === discovery.selectedProjectId);
		if (!project?.boards.some((board) => board.id === boardId)) {
			return;
		}

		this.discovery.set({ ...discovery, selectedBoardId: boardId });
	}
}