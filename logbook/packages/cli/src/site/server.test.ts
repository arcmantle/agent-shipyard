import { describe, expect, it, vi } from "vitest";

const openStorageDriverMock = vi.hoisted(() => vi.fn());
vi.mock("../runtime/open-storage-driver.js", () => ({ openStorageDriver: openStorageDriverMock }));

const readBuildContentHashMock = vi.hoisted(() => vi.fn(() => "test-build-hash"));
vi.mock("@agent-issues/api-local", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@agent-issues/api-local")>();
	return { ...actual, readBuildContentHash: readBuildContentHashMock };
});

const { startLiveSite, stopLiveSite } = await import("./server.js");

function fakeStore() {
	return { close: vi.fn(async () => {}), getSnapshotSignature: vi.fn(async () => "test-signature") } as never;
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			throw new Error("SSE stream ended before the next event.");
		}
		buffer += decoder.decode(value, { stream: true });
		const boundary = buffer.indexOf("\n\n");
		if (boundary !== -1) {
			const dataLine = buffer.slice(0, boundary).split("\n").find((line) => line.startsWith("data: "));
			if (dataLine) {
				return JSON.parse(dataLine.slice("data: ".length));
			}
		}
	}
}

describe("startLiveSite (ISS190)", () => {
	it("stops completely while an SSE client is connected", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0, tenant: "demo" });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const eventController = new AbortController();
		await fetch(`http://127.0.0.1:${port}/events`, { signal: eventController.signal });
		const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));

		await stopLiveSite({ port });
		const result = await Promise.race([
			closePromise.then(() => "closed" as const),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100))
		]);
		eventController.abort();
		if (result === "timed-out") {
			await closePromise;
		}

		expect(result).toBe("closed");
	});

	it("continues local change polling after a transient signature failure", async () => {
		const signatures = ["initial", new Error("database temporarily unavailable"), "recovered"];
		const readLocalSignature = vi.fn(() => {
			const signature = signatures.shift() ?? "recovered";
			if (signature instanceof Error) throw signature;
			return signature;
		});
		openStorageDriverMock.mockClear();
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ pollIntervalMs: 5, port: 0, readLocalSignature, tenant: "demo" });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			await vi.waitFor(() => expect(readLocalSignature.mock.calls.length).toBeGreaterThanOrEqual(3));
			expect(openStorageDriverMock).toHaveBeenCalledOnce();
			await expect(fetch(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({ ok: true });
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});

	it("returns 500 for a rejected request and keeps serving the site", async () => {
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listTenants: vi.fn(async () => { throw new Error("database temporarily unavailable"); })
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0, tenant: "demo" });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const failedResponse = await fetch(`http://127.0.0.1:${port}/site-config.json`);
			expect(failedResponse.status).toBe(500);
			await expect(fetch(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({ ok: true });
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});

	it("rejects tenant-wide writes through the project mutation route", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0, tenant: "demo" });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/project-mutation?tenant=demo&project=PROJ1`, {
				body: JSON.stringify({ correlationId: "tenant-write", method: "importCanonicalChains", params: { bundle: {} } }),
				headers: { "content-type": "application/json" },
				method: "POST"
			});

			expect(response.status).toBe(400);
		} finally {
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});

	it("executes a project mutation and broadcasts its scoped event", async () => {
		const initiative = { body: "", createdAt: "2026-01-01T00:00:00.000Z", id: "INIT1", kind: "initiative", status: "active", title: "Owner", updatedAt: "2026-01-01T00:00:00.000Z" };
		const originalIssue = { ...initiative, body: "Before", id: "ISS1", kind: "issue", status: "todo", title: "Write path" };
		const updatedIssue = { ...originalIssue, body: "After" };
		let currentIssue = originalIssue;
		const getEntityDetails = vi.fn(async (entityId: string) => entityId === initiative.id
			? { entity: initiative, incoming: [], outgoing: [], planEntries: [] }
			: { entity: currentIssue, incoming: [{ entity: initiative, relationType: "tracks" }], outgoing: [], planEntries: [] });
		const updateEntity = vi.fn(async () => {
			currentIssue = updatedIssue;
			return updatedIssue;
		});
		const store = {
			close: vi.fn(async () => {}),
			getEntityDetails,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			updateEntity
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0, tenant: "demo" });
		await new Promise<void>((resolve) => handle.server.once("listening", resolve));
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const eventController = new AbortController();

		try {
			const eventResponse = await fetch(`http://127.0.0.1:${port}/events`, { signal: eventController.signal });
			const eventReader = eventResponse.body!.getReader();
			await readSseEvent(eventReader);

			const response = await fetch(`http://127.0.0.1:${port}/api/project-mutation?tenant=demo&project=PROJ1`, {
				body: JSON.stringify({
					correlationId: "write-1",
					method: "updateEntity",
					params: { body: "After", entityId: "ISS1", expectedContentHash: "hash", expectedRevision: 1 }
				}),
				headers: { "content-type": "application/json" },
				method: "POST"
			});
			const payload = await response.json();
			const event = await readSseEvent(eventReader);

			expect(payload.result).toEqual(updatedIssue);
			expect(payload.event).toMatchObject({
				affectedEntityIds: ["ISS1"],
				affectedInitiativeIds: ["INIT1"],
				category: "entity",
				correlationId: "write-1",
				projectId: "PROJ1",
				type: "snapshot-changed"
			});
			expect(event).toEqual(payload.event);
			expect(updateEntity).toHaveBeenCalledOnce();
			expect(openStorageDriverMock).toHaveBeenCalledWith(expect.objectContaining({
				correlationId: "write-1",
				databaseOptions: expect.objectContaining({ projectIdentity: "PROJ1" })
			}));
		} finally {
			eventController.abort();
			const closePromise = new Promise<void>((resolve) => handle.server.once("close", resolve));
			handle.close();
			await closePromise;
		}
	});

	it("forwards an entity detail request through the tenant-scoped site route", async () => {
		const entityDetail = { entity: { body: "Entity body", id: "ISS1" }, incoming: [], outgoing: [], planEntries: [] };
		const getEntityDetails = vi.fn(async () => entityDetail);
		const store = {
			close: vi.fn(async () => {}),
			getEntityDetails,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listEntities: vi.fn(async () => [entityDetail.entity])
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/entity-detail?entity=ISS1&project=PROJ2`);

			expect(await response.json()).toEqual(entityDetail);
			expect(getEntityDetails).toHaveBeenCalledWith("ISS1");
			expect(openStorageDriverMock).toHaveBeenLastCalledWith(expect.objectContaining({
				databaseOptions: expect.objectContaining({ projectIdentity: "PROJ2" })
			}));
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards scoped entity and project-section reads without using a snapshot", async () => {
		const entityRelations = { entity: { id: "ISS1", kind: "issue" }, incoming: [], outgoing: [], planEntries: [] };
		const issueComments = { comments: [], nextBefore: null, total: 0 };
		const planEntries = { entries: [], nextBefore: null, total: 0 };
		const projectAdrs = [{ id: "ADR1" }];
		const initiative = { id: "INIT1", title: "Payments" };
		const initiativeAdrs = [{ id: "ADR2" }];
		const projectAdrSection = { initiativeAdrs: [{ adrs: initiativeAdrs, initiative }], projectAdrs };
		const debt = { entities: [{ id: "DEBT1" }], total: 1 };
		const context = { initiatives: [{ context: { scopeEntityId: "INIT1" }, terms: [] }], shared: { context: { exists: true }, terms: [] }, terms: [], duplicateTerms: [] };
		const relations = [{ fromId: "INIT1", toId: "ISS1", type: "tracks" }];
		const queryEntityRelations = vi.fn(async () => entityRelations);
		const listIssueComments = vi.fn(async () => issueComments);
		const listPlanEntryPage = vi.fn(async () => planEntries);
		const listProjectAdrs = vi.fn(async () => projectAdrs);
		const queryEntities = vi.fn(async () => debt);
		const getContextDirectory = vi.fn(async () => context);
		const getInitiativeTab = vi.fn(async () => ({ records: initiativeAdrs, relations: [], tab: "adrs" }));
		const listEntities = vi.fn(async (kind: string) => kind === "initiative" ? [initiative] : kind === "issue" ? [{ id: "ISS1" }] : []);
		const listAllRelations = vi.fn(async () => relations);
		const store = {
			close: vi.fn(async () => {}),
			getContextDirectory,
			getInitiativeTab,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listAllRelations,
			listEntities,
			listIssueComments,
			listPlanEntryPage,
			listProjectAdrs,
			queryEntities,
			queryEntityRelations
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const requestOpenIndex = openStorageDriverMock.mock.calls.length;
			await expect(fetch(`http://127.0.0.1:${port}/api/entity-relations?entity=ISS1&project=PROJ2`).then((response) => response.json())).resolves.toEqual(entityRelations);
			await expect(fetch(`http://127.0.0.1:${port}/api/issue-comments?issue=ISS1&project=PROJ2`).then((response) => response.json())).resolves.toEqual(issueComments);
			await expect(fetch(`http://127.0.0.1:${port}/api/plan-entries?plan=PLAN1&project=PROJ2`).then((response) => response.json())).resolves.toEqual(planEntries);
			await expect(fetch(`http://127.0.0.1:${port}/api/project-adrs?project=PROJ2`).then((response) => response.json())).resolves.toEqual(projectAdrSection);
			await expect(fetch(`http://127.0.0.1:${port}/api/project-debt?project=PROJ2`).then((response) => response.json())).resolves.toEqual({ records: debt.entities, relations: [] });
			await expect(fetch(`http://127.0.0.1:${port}/api/project-context?project=PROJ2`).then((response) => response.json())).resolves.toEqual(context);
			await expect(fetch(`http://127.0.0.1:${port}/api/project-graph?project=PROJ2`).then((response) => response.json())).resolves.toEqual({ records: [initiative, { id: "ISS1" }], relations });

			expect(queryEntityRelations).toHaveBeenCalledWith({ entityId: "ISS1" });
			expect(listIssueComments).toHaveBeenCalledWith({ issueId: "ISS1" });
			expect(listPlanEntryPage).toHaveBeenCalledWith({ planId: "PLAN1" });
			expect(listProjectAdrs).toHaveBeenCalledOnce();
			expect(getInitiativeTab).toHaveBeenCalledWith({ initiativeId: "INIT1", tab: "adrs" });
			expect(queryEntities).toHaveBeenCalledWith({ kind: "debt" });
			expect(getContextDirectory).toHaveBeenCalledOnce();
			expect(listAllRelations).toHaveBeenCalledOnce();
			expect(openStorageDriverMock.mock.calls.slice(requestOpenIndex).every(([options]) =>
				options.databaseOptions?.projectIdentity === "PROJ2"
			)).toBe(true);
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards an initiative detail request through the tenant-scoped site route", async () => {
		const initiativeDetail = { initiative: { body: "Initiative body", id: "INIT1" } };
		const getInitiativeDetail = vi.fn(async () => initiativeDetail);
		const store = {
			close: vi.fn(async () => {}),
			getInitiativeDetail,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listEntities: vi.fn(async () => [initiativeDetail.initiative])
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/initiative-detail?initiative=INIT1&project=PROJ2`);

			expect(await response.json()).toEqual(initiativeDetail);
			expect(getInitiativeDetail).toHaveBeenCalledWith({ initiativeId: "INIT1" });
			expect(openStorageDriverMock).toHaveBeenLastCalledWith(expect.objectContaining({
				databaseOptions: expect.objectContaining({ projectIdentity: "PROJ2" })
			}));
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards an initiative tab request through the tenant-scoped site route", async () => {
		const initiativeTab = { tab: "issues", records: [], relations: [] };
		const getInitiativeTab = vi.fn(async () => initiativeTab);
		const store = {
			close: vi.fn(async () => {}),
			getInitiativeTab,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listEntities: vi.fn(async () => [{ id: "INIT1" }])
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/initiative-tab?initiative=INIT1&tab=issues&project=PROJ2`);

			expect(await response.json()).toEqual(initiativeTab);
			expect(getInitiativeTab).toHaveBeenCalledWith({ initiativeId: "INIT1", tab: "issues" });
			expect(openStorageDriverMock).toHaveBeenLastCalledWith(expect.objectContaining({
				databaseOptions: expect.objectContaining({ projectIdentity: "PROJ2" })
			}));
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards a project summary request through the tenant-scoped site route", async () => {
		const projectSummary = {
			kind: "available",
			project: { id: "PROJ1" },
			epics: [],
			counts: { epics: 0, initiatives: 0, completedInitiatives: 0 }
		};
		const getProjectSummary = vi.fn(async () => projectSummary);
		const store = {
			close: vi.fn(async () => {}),
			getProjectSummary,
			getSnapshotSignature: vi.fn(async () => "test-signature")
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/project-summary?project=PROJ1`);

			expect(await response.json()).toEqual(projectSummary);
			expect(getProjectSummary).toHaveBeenCalledWith({ projectId: "PROJ1" });
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards the provider search capability through the tenant-scoped site route", async () => {
		const getSearchCapability = vi.fn(async () => ({ state: "rebuilding" }));
		const store = {
			close: vi.fn(async () => {}),
			getSearchCapability,
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			listTenants: vi.fn(async () => [{ displayName: "Demo", id: "demo" }])
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search/capability?tenant=demo`);

			expect(await response.json()).toEqual({ state: "rebuilding" });
			expect(getSearchCapability).toHaveBeenCalledOnce();
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards a current-project search request and its final response", async () => {
		const responseBody = { results: [], state: "available" };
		const search = vi.fn(async () => responseBody);
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=current-project&project=PROJ1`);

			expect(await response.json()).toEqual(responseBody);
			expect(search).toHaveBeenCalledWith({ query: "roadmap", scope: { projectId: "PROJ1", type: "current-project" } });
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("rejects invalid search parameters before calling the storage provider", async () => {
		const search = vi.fn();
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=current-project&project=PROJ1&limit=0`);

			expect(response.status).toBe(400);
			expect(search).not.toHaveBeenCalled();
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("forwards all-project search filters and limits", async () => {
		const search = vi.fn(async () => ({ results: [], state: "unsupported" }));
		const store = {
			close: vi.fn(async () => {}),
			getSnapshotSignature: vi.fn(async () => "test-signature"),
			search
		} as never;
		openStorageDriverMock.mockResolvedValue({ store, dbPath: "/tmp/agent-issues.db", backend: "local" });
		const handle = await startLiveSite({ port: 0 });
		await new Promise<void>((resolve) => {
			handle.server.once("listening", resolve);
		});
		const address = handle.server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/search?query=roadmap&scope=all-projects&sourceTypes=entity,context&limit=20`);

			expect(await response.json()).toEqual({ results: [], state: "unsupported" });
			expect(search).toHaveBeenCalledWith({
				filters: { sourceTypes: ["entity", "context"] },
				limit: 20,
				query: "roadmap",
				scope: { type: "all-projects" }
			});
		} finally {
			const closePromise = new Promise<void>((resolve) => {
				handle.server.once("close", resolve);
			});
			handle.close();
			await closePromise;
		}
	});

	it("passes this install's build-content-hash to openStorageDriver's daemon routing", async () => {
		openStorageDriverMock.mockResolvedValue({ store: fakeStore(), dbPath: "/tmp/agent-issues.db", backend: "local" });

		const handle = await startLiveSite({ port: 0 });

		try {
			expect(openStorageDriverMock).toHaveBeenCalledWith(
				expect.objectContaining({ localDaemon: { buildHash: "test-build-hash" } })
			);
		} finally {
			handle.close();
		}
	});

});
