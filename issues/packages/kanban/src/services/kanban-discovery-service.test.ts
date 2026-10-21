import { describe, expect, it, vi } from "vitest";

import { KANBAN_DISCOVERY_PATH, KanbanDiscoveryService } from "./kanban-discovery-service.js";

describe("KanbanDiscoveryService", () => {
	it("loads available projects and selects the first project board", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			projects: [
				{
					id: "agent-issues",
					name: "Agent Issues",
					boards: [{ id: "active-work", name: "Active work" }]
				}
			]
		}), { status: 200 }));
		const service = new KanbanDiscoveryService(fetcher);

		await service.load();

		expect(fetcher).toHaveBeenCalledWith(KANBAN_DISCOVERY_PATH);
		expect(service.discovery.get()).toEqual({
			state: "ready",
			projects: [
				{
					id: "agent-issues",
					name: "Agent Issues",
					boards: [{ id: "active-work", name: "Active work" }]
				}
			],
			selectedProjectId: "agent-issues",
			selectedBoardId: "active-work"
		});
	});

	it("selects an available project and its first board", async () => {
		const service = new KanbanDiscoveryService(vi.fn().mockResolvedValue(new Response(JSON.stringify({
			projects: [
				{ id: "agent-issues", name: "Agent Issues", boards: [{ id: "active-work", name: "Active work" }] },
				{ id: "platform", name: "Platform", boards: [{ id: "backlog", name: "Backlog" }] }
			]
		}), { status: 200 })));
		await service.load();

		service.selectProject("platform");

		expect(service.discovery.get()).toMatchObject({
			state: "ready",
			selectedProjectId: "platform",
			selectedBoardId: "backlog"
		});
	});

	it("selects an available board within the active project", async () => {
		const service = new KanbanDiscoveryService(vi.fn().mockResolvedValue(new Response(JSON.stringify({
			projects: [
				{
					id: "agent-issues",
					name: "Agent Issues",
					boards: [
						{ id: "active-work", name: "Active work" },
						{ id: "completed-work", name: "Completed work" }
					]
				}
			]
		}), { status: 200 })));
		await service.load();

		service.selectBoard("completed-work");

		expect(service.discovery.get()).toMatchObject({
			state: "ready",
			selectedProjectId: "agent-issues",
			selectedBoardId: "completed-work"
		});
	});

	it("ignores selections before discovery is ready", () => {
		const service = new KanbanDiscoveryService(vi.fn());

		service.selectProject("platform");
		service.selectBoard("backlog");

		expect(service.discovery.get()).toEqual({
			state: "loading",
			projects: [],
			selectedProjectId: null,
			selectedBoardId: null
		});
	});

	it("ignores unavailable project and board selections", async () => {
		const service = new KanbanDiscoveryService(vi.fn().mockResolvedValue(new Response(JSON.stringify({
			projects: [
				{ id: "agent-issues", name: "Agent Issues", boards: [{ id: "active-work", name: "Active work" }] },
				{ id: "platform", name: "Platform", boards: [{ id: "backlog", name: "Backlog" }] }
			]
		}), { status: 200 })));
		await service.load();

		service.selectProject("missing");
		service.selectBoard("backlog");

		expect(service.discovery.get()).toMatchObject({
			state: "ready",
			selectedProjectId: "agent-issues",
			selectedBoardId: "active-work"
		});
	});

	it("reports an error state when discovery returns an unsuccessful response", async () => {
		const service = new KanbanDiscoveryService(vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));

		await service.load();

		expect(service.discovery.get()).toEqual({
			state: "error",
			projects: [],
			selectedProjectId: null,
			selectedBoardId: null,
			message: "Discovery request failed with status 404."
		});
	});
});