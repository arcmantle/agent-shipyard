import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ENTITY_KINDS } from "../features/entity-store/domain.js";
import { isInitiativeTab, type InitiativeTab } from "../features/entity-store/store-types.js";
import {
	InstructionFragmentError,
	InstructionResetAllError,
	splitInstructionMarkdown,
	type CommitInstructionChangesInput,
	type CreateInstructionFragmentInput,
	type PreviewInstructionInput,
	type RemoveInstructionFragmentInput,
	type ResetInstructionAllInput,
	type SaveInstructionSourceInput
} from "../features/storage-driver/instruction-store.js";
import type { SearchRequest, SearchSourceType } from "../features/storage-driver/search-store.js";
import type { StorageDriver } from "../features/storage-driver/storage-driver.js";
import { mergeProjectChangeEventDetails, projectChangeEventForWrite, type ProjectChangeEvent } from "../rpc/change-events.js";
import { rpcMethods, writeMethods } from "../rpc/rpc-methods.js";
import type { ConfirmationTokenStore } from "./confirmation-tokens.js";

export type SiteStoreScope = { tenant: string; projectIdentity?: string; correlationId?: string };
export type SiteStoreOwner = { type: "local" } | { type: "cloud"; tenantId: string; userId: string };
export type OpenedSiteStore = { store: StorageDriver; dbPath: string; owner: SiteStoreOwner; backend: "local" | "cloud" };
export type OpenSiteStore = (scope: SiteStoreScope) => Promise<OpenedSiteStore>;

export type SiteRouteOptions = {
	openStore: OpenSiteStore;
	defaultTenant: string;
	/** Open `/events` SSE responses; the host broadcasts change events to them. */
	clients: Set<ServerResponse>;
	confirmationTokens: ConfirmationTokenStore;
	instructionVersion: () => string;
	resolveAsset: (pathname: string) => { path: string; contentType: string } | undefined;
	/** Called after a project mutation through a local-backend store, with the new snapshot signature. */
	onLocalMutation?: (event: ProjectChangeEvent, signature: string) => void;
	onMutation?: (event: ProjectChangeEvent) => void;
};

async function useSiteStore<T>(openStore: OpenSiteStore, scope: SiteStoreScope, fn: (store: StorageDriver, dbPath: string) => Promise<T>): Promise<T> {
	const { store, dbPath } = await openStore(scope);

	try {
		return await fn(store, dbPath);
	} finally {
		await store.close();
	}
}

const PROJECT_MUTATION_METHODS = new Set([
	"applyRelations",
	"archiveEntity",
	"createEntity",
	"createIssueComment",
	"createPlanEntry",
	"defineContextTerm",
	"deleteEntity",
	"deleteIssueComment",
	"deletePlanEntry",
	"forgetContextTerm",
	"linkEntities",
	"linkPlanEntryEntity",
	"moveEntity",
	"restoreContextRevision",
	"restoreContextTermRevision",
	"restoreEntityRevision",
	"setEntityBody",
	"unlinkEntities",
	"unlinkPlanEntryEntity",
	"updateEntity",
	"updateEntityStatus",
	"updateIssueComment",
	"updatePlanEntry",
	"upsertContext"
]);

export async function handleSiteRequest(request: IncomingMessage, response: ServerResponse, options: SiteRouteOptions): Promise<void> {
	const { openStore, defaultTenant, clients, confirmationTokens, instructionVersion } = options;
	const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
	const requestedTenant = requestUrl.searchParams.get("tenant")?.trim() || defaultTenant;
	const requestedProjectIdentity = requestUrl.searchParams.get("project")?.trim() || undefined;

	if (requestUrl.pathname === "/api/instructions/reset-all/inspect" || requestUrl.pathname === "/api/instructions/reset-all") {
		const inspecting = requestUrl.pathname.endsWith("/inspect");
		if (request.method !== (inspecting ? "GET" : "POST")) {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		let reset: Pick<ResetInstructionAllInput, "expectedRevisions"> & { confirmationToken: string } | undefined;
		if (!inspecting) {
			try {
				const chunks = await readRequestBody(request);
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!value || !Array.isArray(value.expectedRevisions) || typeof value.confirmationToken !== "string") throw new Error("Reset All requires inspected revisions and a confirmation token.");
				reset = { expectedRevisions: value.expectedRevisions, confirmationToken: value.confirmationToken };
			} catch (error) {
				writeText(response, 400, error instanceof Error ? error.message : "Invalid Reset All request.");
				return;
			}
		}
		try {
			const opened = await openStore({ tenant: requestedTenant });
			try {
				const impact = await opened.store.inspectInstructionResetAll({ version: instructionVersion() });
				if (inspecting) {
					const confirmation = confirmationTokens.issue("instruction_reset_all", { owner: opened.owner, impact });
					writeJson(response, { ...impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
				} else {
					confirmationTokens.consume(reset!.confirmationToken, "instruction_reset_all", { owner: opened.owner, impact });
					writeJson(response, await opened.store.resetInstructionAll({ version: instructionVersion(), expectedRevisions: reset!.expectedRevisions }));
				}
			} finally {
				await opened.store.close();
			}
		} catch (error) {
			if (error instanceof InstructionResetAllError) writeJson(response, { error: error.message, reason: error.reason, currentInspection: error.currentInspection }, undefined, error.reason === "revision-conflict" ? 409 : 400);
			else writeText(response, 400, error instanceof Error ? error.message : "Reset All failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/fragments/create" || requestUrl.pathname === "/api/instructions/fragments/remove") {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		const creating = requestUrl.pathname.endsWith("/create");
		let fragment: CreateInstructionFragmentInput | RemoveInstructionFragmentInput;
		try {
			const chunks = await readRequestBody(request);
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<CreateInstructionFragmentInput & RemoveInstructionFragmentInput> | null;
			if (!value || typeof value.key !== "string" || !value.key.startsWith("fragment/")
				|| (creating ? typeof value.body !== "string" : !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision! < 1)) {
				throw new Error("Invalid fragment request.");
			}
			fragment = creating
				? { key: value.key, body: value.body!, version: instructionVersion() }
				: { key: value.key, expectedRevision: value.expectedRevision!, version: instructionVersion() };
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Invalid fragment request.");
			return;
		}
		try {
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, (store) => creating
				? store.createInstructionFragment(fragment as CreateInstructionFragmentInput)
				: store.removeInstructionFragment(fragment as RemoveInstructionFragmentInput));
			writeJson(response, result);
		} catch (error) {
			if (error instanceof InstructionFragmentError) {
				writeJson(response, { message: error.message, reason: error.reason, currentSource: error.currentSource, affectedReferences: error.affectedReferences }, undefined, 400);
			} else writeText(response, 400, error instanceof Error ? error.message : "Fragment operation failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/source" && request.method === "POST") {
		let save: SaveInstructionSourceInput;
		try {
			const chunks = await readRequestBody(request);
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<SaveInstructionSourceInput> | null;
			if (!value || typeof value.key !== "string" || !value.key.trim() || typeof value.body !== "string"
				|| !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision! < 1) throw new Error("Invalid instruction save request.");
			save = { key: value.key, body: value.body, expectedRevision: value.expectedRevision!, version: instructionVersion() };
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Invalid instruction save request.");
			return;
		}
		try {
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, async (store) => {
				const current = await store.readInstructionSource(save);
				if (splitInstructionMarkdown(current.body).frontmatter !== splitInstructionMarkdown(save.body).frontmatter) {
					throw new Error("Plugin frontmatter is read-only.");
				}
				return store.saveInstructionSource(save);
			});
			writeJson(response, result);
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Instruction save failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/reset/inspect" || requestUrl.pathname === "/api/instructions/reset") {
		const inspecting = requestUrl.pathname.endsWith("/inspect");
		if (request.method !== (inspecting ? "GET" : "POST")) {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		try {
			let key = requestUrl.searchParams.get("key");
			let expectedRevision: number | undefined;
			if (!inspecting) {
				const chunks = await readRequestBody(request);
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				key = value?.key;
				expectedRevision = value?.expectedRevision;
				if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 1) throw new Error("Invalid instruction reset revision.");
			}
			if (typeof key !== "string" || !key.trim()) throw new Error("An instruction key is required.");
			const resetKey = key;
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, async (store) => {
				if (inspecting) return await store.inspectInstructionReset({ key: resetKey, version: instructionVersion() });
				return await store.resetInstructionSource({ key: resetKey, version: instructionVersion(), expectedRevision: expectedRevision! });
			});
			writeJson(response, result);
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Instruction reset failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/restore") {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		try {
			const chunks = await readRequestBody(request);
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { key?: string; revision?: number; expectedRevision?: number } | null;
			if (!value || typeof value.key !== "string" || !value.key.trim()
				|| !Number.isSafeInteger(value.revision) || value.revision! < 1
				|| !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision! < 1) {
				throw new Error("Invalid instruction restore request.");
			}
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, (store) => store.restoreInstructionRevision({ key: value.key!, revision: value.revision!, expectedRevision: value.expectedRevision!, version: instructionVersion() }));
			writeJson(response, result);
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Instruction restore failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/changes") {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		try {
			const chunks = await readRequestBody(request);
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<CommitInstructionChangesInput> | null;
			if (!value || !Array.isArray(value.changes) || !value.changes.length
				|| value.changes.some((change) => !change || typeof change.key !== "string" || !change.key.trim()
					|| !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 1
					|| (change.operation !== "save" && change.operation !== "remove")
					|| (change.operation === "save" && typeof change.body !== "string"))) {
				throw new Error("Invalid instruction changes request.");
			}
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, async (store) => {
				for (const change of value.changes!) {
					if (change.operation !== "save") continue;
					const current = await store.readInstructionSource({ version: instructionVersion(), key: change.key });
					if (splitInstructionMarkdown(current.body).frontmatter !== splitInstructionMarkdown(change.body).frontmatter) {
						throw new Error("Plugin frontmatter is read-only.");
					}
				}
				return store.commitInstructionChanges({ version: instructionVersion(), changes: value.changes! });
			});
			writeJson(response, result);
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Instruction changes failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/instructions/preview") {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}
		let preview: PreviewInstructionInput;
		try {
			const chunks = await readRequestBody(request);
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<PreviewInstructionInput> | null;
			if (!value || typeof value.key !== "string" || !value.key.trim() || !Array.isArray(value.changes) || !value.changes.length
				|| value.changes.some((change) => !change || typeof change.key !== "string" || typeof change.body !== "string")) {
				throw new Error("Invalid instruction preview request.");
			}
			preview = { key: value.key, changes: value.changes, version: instructionVersion() };
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Invalid instruction preview request.");
			return;
		}
		try {
			const result = await useSiteStore(openStore, { tenant: requestedTenant }, (store) => store.previewInstruction(preview));
			writeJson(response, result);
		} catch (error) {
			writeText(response, 500, error instanceof Error ? error.message : "Instruction preview failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/api/project-mutation") {
		if (request.method !== "POST") {
			writeText(response, 405, "Method Not Allowed");
			return;
		}

		let mutation: ProjectMutationRequest;
		try {
			mutation = await readProjectMutationRequest(request);
		} catch (error) {
			writeText(response, 400, error instanceof Error ? error.message : "Invalid project mutation request.");
			return;
		}

		try {
			writeJson(response, await executeProjectMutation({
				mutation,
				onLocalMutation: options.onLocalMutation,
				onMutation: options.onMutation,
				openStore,
				projectId: requestedProjectIdentity,
				tenant: requestedTenant
			}));
		} catch (error) {
			writeText(response, 500, error instanceof Error ? error.message : "Project mutation failed.");
		}
		return;
	}

	if (request.method !== "GET") {
		writeText(response, 405, "Method Not Allowed");
		return;
	}

	if (["/api/instructions/catalog", "/api/instructions/source", "/api/instructions/compare", "/api/instructions/dependencies", "/api/instructions/history", "/api/instructions/revision"].includes(requestUrl.pathname)) {
		const key = requestUrl.searchParams.get("key")?.trim();
		const revision = Number(requestUrl.searchParams.get("revision"));
		if (requestUrl.pathname !== "/api/instructions/catalog" && !key) {
			writeText(response, 400, "Instruction key is required.");
			return;
		}
		if (requestUrl.pathname === "/api/instructions/revision" && (!Number.isSafeInteger(revision) || revision < 1)) {
			writeText(response, 400, "A positive instruction revision is required.");
			return;
		}
		try {
			const opened = await openStore({ tenant: requestedTenant });
			try {
				const result = requestUrl.pathname === "/api/instructions/history"
					? await opened.store.listInstructionHistory({ key: key!, version: instructionVersion() })
					: requestUrl.pathname === "/api/instructions/revision"
					? await opened.store.readInstructionRevision({ key: key!, version: instructionVersion(), revision })
					: requestUrl.pathname === "/api/instructions/dependencies"
					? await opened.store.inspectInstructionDependencies({ key: key!, version: instructionVersion() })
					: requestUrl.pathname === "/api/instructions/compare"
					? await opened.store.compareInstructionSource({ key: key!, version: instructionVersion() })
					: key
					? await opened.store.readInstructionSource({ key, version: instructionVersion() })
					: { ...await opened.store.listInstructionSources({ version: instructionVersion() }), owner: opened.owner };
				writeJson(response, result);
			} finally {
				await opened.store.close();
			}
		} catch (error) {
			writeText(response, 500, error instanceof Error ? error.message : "Instruction read failed.");
		}
		return;
	}

	if (requestUrl.pathname === "/site-config.json") {
		writeJson(
			response,
			await readSiteConfig(openStore, defaultTenant)
		);
		return;
	}

	if (requestUrl.pathname === "/api/snapshot") {
		writeJson(
			response,
			await readSnapshot(
				openStore,
				requestedTenant,
				defaultTenant,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/project-summary") {
		const startedAt = performance.now();
		const projectSummary = await readProjectSummary(
			openStore,
			requestedTenant,
			defaultTenant,
			requestedProjectIdentity
		);
		writeJson(
			response,
			projectSummary,
			{ durationMs: performance.now() - startedAt, metricName: "project-summary" }
		);
		return;
	}

	if (requestUrl.pathname === "/api/entity-detail") {
		const entityId = requestUrl.searchParams.get("entity")?.trim();
		if (!entityId) {
			writeText(response, 400, "Invalid entity detail request.");
			return;
		}

		writeJson(
			response,
			await readEntityDetails(
				openStore,
				requestedTenant,
				defaultTenant,
				entityId,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/entity-relations") {
		const entityId = requestUrl.searchParams.get("entity")?.trim();
		if (!entityId) {
			writeText(response, 400, "Invalid entity relations request.");
			return;
		}

		writeJson(response, await readEntityRelations(openStore, requestedTenant, defaultTenant, entityId, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/issue-comments") {
		const issueId = requestUrl.searchParams.get("issue")?.trim();
		if (!issueId) {
			writeText(response, 400, "Invalid issue comments request.");
			return;
		}

		const before = requestUrl.searchParams.get("before")?.trim();
		const all = requestUrl.searchParams.get("all") === "true";
		writeJson(response, await readIssueComments(openStore, requestedTenant, defaultTenant, requestedProjectIdentity, { issueId, ...(before ? { before } : {}), ...(all ? { all } : {}) }));
		return;
	}

	if (requestUrl.pathname === "/api/plan-entries") {
		const planId = requestUrl.searchParams.get("plan")?.trim();
		if (!planId) {
			writeText(response, 400, "Invalid Plan entries request.");
			return;
		}

		const before = requestUrl.searchParams.get("before")?.trim();
		const all = requestUrl.searchParams.get("all") === "true";
		writeJson(response, await readPlanEntryPage(openStore, requestedTenant, defaultTenant, requestedProjectIdentity, { planId, ...(before ? { before } : {}), ...(all ? { all } : {}) }));
		return;
	}

	if (requestUrl.pathname === "/api/project-adrs") {
		writeJson(response, await readProjectAdrs(openStore, requestedTenant, defaultTenant, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-debt") {
		writeJson(response, await readProjectDebt(openStore, requestedTenant, defaultTenant, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-context") {
		writeJson(response, await readProjectContext(openStore, requestedTenant, defaultTenant, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/project-graph") {
		writeJson(response, await readProjectGraph(openStore, requestedTenant, defaultTenant, requestedProjectIdentity));
		return;
	}

	if (requestUrl.pathname === "/api/initiative-tab") {
		const initiativeId = requestUrl.searchParams.get("initiative")?.trim();
		const tab = requestUrl.searchParams.get("tab");
		if (!initiativeId || !isInitiativeTab(tab)) {
			writeText(response, 400, "Invalid initiative tab request.");
			return;
		}

		writeJson(
			response,
			await readInitiativeTab(
				openStore,
				requestedTenant,
				defaultTenant,
				initiativeId,
				tab,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/initiative-detail") {
		const initiativeId = requestUrl.searchParams.get("initiative")?.trim();
		if (!initiativeId) {
			writeText(response, 400, "Invalid initiative detail request.");
			return;
		}

		writeJson(
			response,
			await readInitiativeDetail(
				openStore,
				requestedTenant,
				defaultTenant,
				initiativeId,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/projects") {
		writeJson(
			response,
			await readProjectDiscovery(
				openStore,
				requestedTenant,
				defaultTenant,
				requestedProjectIdentity
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/search/capability") {
		writeJson(
			response,
			await readSearchCapability(
				openStore,
				requestedTenant,
				defaultTenant
			)
		);
		return;
	}

	if (requestUrl.pathname === "/api/search") {
		const searchRequest = parseSearchRequest(requestUrl);
		if (!searchRequest) {
			writeText(response, 400, "Invalid search request.");
			return;
		}

		writeJson(
			response,
			await readSearch(
				openStore,
				requestedTenant,
				defaultTenant,
				searchRequest
			)
		);
		return;
	}

	if (requestUrl.pathname === "/events") {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		});
		response.write("retry: 1000\n");
		response.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);
		clients.add(response);

		request.on("close", () => {
			clients.delete(response);
		});
		return;
	}

	const asset = options.resolveAsset(requestUrl.pathname);
	if (asset) {
		response.writeHead(200, {
			"Content-Type": asset.contentType,
			"Cache-Control": asset.path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable"
		});
		response.end(readFileSync(asset.path));
		return;
	}

	writeText(response, 404, "Not Found");
}

async function readSiteConfig(
	openStore: OpenSiteStore,
	defaultTenant: string
) {
	return useSiteStore(
		openStore,
		{ tenant: defaultTenant },
		async (store, resolvedDbPath) => {
			const availableTenants = await store.listTenants();
			const currentTenant = availableTenants.some((tenant) => tenant.id === defaultTenant)
				? defaultTenant
				: (availableTenants[0]?.id ?? defaultTenant);

			return {
				availableTenants,
				currentTenant,
				dbPath: resolvedDbPath
			};
		}
	);
}

async function readSnapshot(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectId: string | undefined
) {
	if (!projectId) {
		return { kind: "unavailable" } as const;
	}

	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	return useSiteStore(openStore, { tenant }, (store) => store.getDatabaseSnapshot({ projectId }));
}

async function readTenantScoped<T>(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined,
	read: (store: StorageDriver) => Promise<T>
): Promise<T | { kind: "unavailable" }> {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" };
		}
	}

	try {
		return await useSiteStore(openStore, { projectIdentity, tenant }, read);
	} catch (error) {
		if (isUnavailableProjectEntityError(error)) {
			return { kind: "unavailable" };
		}

		throw error;
	}
}

function isUnavailableProjectEntityError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Entity not found");
}

async function readEntityRelations(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	entityId: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, async (store) => {
		const relations = await store.queryEntityRelations({ entityId });
		return await hasSelectedProjectEntity(store, relations.entity.kind, relations.entity.id)
			? relations
			: { kind: "unavailable" as const };
	});
}

async function readIssueComments(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined,
	input: { issueId: string; before?: string; all?: boolean }
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, (store) => store.listIssueComments(input));
}

async function readPlanEntryPage(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined,
	input: { planId: string; before?: string; all?: boolean }
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, (store) => store.listPlanEntryPage(input));
}

async function readProjectAdrs(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, async (store) => {
		const [projectAdrs, initiatives] = await Promise.all([
			store.listProjectAdrs(),
			store.listEntities("initiative")
		]);
		const initiativeAdrs = await Promise.all(initiatives.map(async (initiative) => ({
			adrs: (await store.getInitiativeTab({ initiativeId: initiative.id, tab: "adrs" })).records,
			initiative
		})));
		return { initiativeAdrs, projectAdrs };
	});
}

async function readProjectDebt(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, async (store) => {
		const result = await store.queryEntities({ kind: "debt" });
		return { records: result.entities, relations: [] };
	});
}

async function readProjectContext(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, (store) => store.getContextDirectory());
}

async function readProjectGraph(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectIdentity: string | undefined
) {
	return readTenantScoped(openStore, tenant, defaultTenant, projectIdentity, async (store) => {
		const records = [...new Map((await Promise.all(ENTITY_KINDS.map((kind) => store.listEntities(kind)))).flat().map((record) => [record.id, record])).values()];
		const recordIds = new Set(records.map((record) => record.id));
		const relations = (await store.listAllRelations()).filter((relation) => recordIds.has(relation.fromId) && recordIds.has(relation.toId));
		return { records, relations };
	});
}

async function readProjectDiscovery(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectId: string | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	return useSiteStore(
		openStore,
		{ tenant },
		(store) => store.getProjectDiscovery(projectId ? { projectId } : undefined)
	);
}

async function readProjectSummary(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	projectId: string | undefined
) {
	if (!projectId) {
		return { kind: "unavailable" } as const;
	}

	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	return useSiteStore(
		openStore,
		{ tenant },
		(store) => store.getProjectSummary({ projectId })
	);
}

async function readEntityDetails(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	entityId: string,
	projectIdentity: string | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	try {
		return await useSiteStore(
			openStore,
			{ projectIdentity, tenant },
			async (store) => {
				const details = await store.getEntityDetails(entityId);
				return await hasSelectedProjectEntity(store, details.entity.kind, details.entity.id)
					? details
					: { kind: "unavailable" as const };
			}
		);
	} catch (error) {
		if (isUnavailableProjectEntityError(error)) {
			return { kind: "unavailable" };
		}

		throw error;
	}
}

async function readInitiativeTab(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	initiativeId: string,
	tab: InitiativeTab,
	projectIdentity: string | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	try {
		return await useSiteStore(
			openStore,
			{ projectIdentity, tenant },
			async (store) => await hasSelectedProjectEntity(store, "initiative", initiativeId)
				? store.getInitiativeTab({ initiativeId, tab })
				: { kind: "unavailable" as const }
		);
	} catch (error) {
		if (isUnavailableProjectEntityError(error)) {
			return { kind: "unavailable" };
		}

		throw error;
	}
}

async function readInitiativeDetail(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	initiativeId: string,
	projectIdentity: string | undefined
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { kind: "unavailable" } as const;
		}
	}

	try {
		return await useSiteStore(
			openStore,
			{ projectIdentity, tenant },
			async (store) => await hasSelectedProjectEntity(store, "initiative", initiativeId)
				? store.getInitiativeDetail({ initiativeId })
				: { kind: "unavailable" as const }
		);
	} catch (error) {
		if (isUnavailableProjectEntityError(error)) {
			return { kind: "unavailable" };
		}

		throw error;
	}
}

async function hasSelectedProjectEntity(store: StorageDriver, kind: string, entityIdentity: string): Promise<boolean> {
	return (await store.listEntities(kind)).some((entity) =>
		entity.id === entityIdentity || entity.reference === entityIdentity || entity.shortReference === entityIdentity
	);
}

async function readSearchCapability(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { state: "unsupported" } as const;
		}
	}

	return useSiteStore(
		openStore,
		{ tenant },
		(store) => store.getSearchCapability()
	);
}

async function readSearch(
	openStore: OpenSiteStore,
	tenant: string,
	defaultTenant: string,
	searchRequest: SearchRequest
) {
	if (tenant !== defaultTenant) {
		const availableTenants = await useSiteStore(
			openStore,
			{ tenant: defaultTenant },
			(store) => store.listTenants()
		);
		if (!availableTenants.some((availableTenant) => availableTenant.id === tenant)) {
			return { state: "unsupported" } as const;
		}
	}

	return useSiteStore(
		openStore,
		{ tenant },
		(store) => store.search(searchRequest)
	);
}

function parseSearchRequest(requestUrl: URL): SearchRequest | null {
	const query = requestUrl.searchParams.get("query")?.trim();
	const scope = requestUrl.searchParams.get("scope");
	const projectId = requestUrl.searchParams.get("project")?.trim();
	const sourceTypes = parseSearchSourceTypes(requestUrl.searchParams.get("sourceTypes"));
	const limit = parseSearchLimit(requestUrl.searchParams.get("limit"));
	if (!query || !scope || sourceTypes === null || limit === null) {
		return null;
	}

	const filters = sourceTypes.length > 0 ? { sourceTypes } : undefined;
	if (scope === "all-projects") {
		return { filters, limit: limit ?? undefined, query, scope: { type: "all-projects" } };
	}
	if (scope === "current-project" && projectId) {
		return { filters, limit: limit ?? undefined, query, scope: { projectId, type: "current-project" } };
	}

	return null;
}

function parseSearchSourceTypes(value: string | null): SearchSourceType[] | null {
	if (!value) {
		return [];
	}

	const validSourceTypes: SearchSourceType[] = ["entity", "context", "context-term", "issue-comment", "plan-entry"];
	const sourceTypes = value.split(",").map((sourceType) => sourceType.trim()).filter(Boolean);
	return sourceTypes.every((sourceType): sourceType is SearchSourceType => validSourceTypes.includes(sourceType as SearchSourceType))
		? [...new Set(sourceTypes)]
		: null;
}

function parseSearchLimit(value: string | null): number | null | undefined {
	if (value === null) {
		return undefined;
	}

	if (!/^\d+$/.test(value)) {
		return null;
	}

	const limit = Number(value);
	return limit > 0 && limit <= 100 ? limit : null;
}

type ProjectMutationRequest = {
	correlationId: string;
	method: string;
	params?: unknown;
};

const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

class RequestBodyTooLargeError extends Error {
	public constructor() {
		super("Request body is too large.");
	}
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer[]> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BODY_BYTES) {
			request.destroy();
			throw new RequestBodyTooLargeError();
		}
		chunks.push(buffer);
	}
	return chunks;
}

async function readProjectMutationRequest(request: IncomingMessage): Promise<ProjectMutationRequest> {
	const chunks = await readRequestBody(request);

	const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ProjectMutationRequest>;
	if (
		typeof value.correlationId !== "string" ||
		value.correlationId.length === 0 ||
		typeof value.method !== "string" ||
		!writeMethods.has(value.method) ||
		!PROJECT_MUTATION_METHODS.has(value.method) ||
		!rpcMethods[value.method]
	) {
		throw new Error("Invalid project mutation request.");
	}
	return { correlationId: value.correlationId, method: value.method, params: value.params };
}

async function executeProjectMutation(input: {
	mutation: ProjectMutationRequest;
	onLocalMutation: SiteRouteOptions["onLocalMutation"];
	onMutation: SiteRouteOptions["onMutation"];
	openStore: OpenSiteStore;
	projectId: string | undefined;
	tenant: string;
}): Promise<{ event: ProjectChangeEvent; result: unknown }> {
	const opened = await input.openStore({ correlationId: input.mutation.correlationId, projectIdentity: input.projectId, tenant: input.tenant });
	const handler = rpcMethods[input.mutation.method]!;

	try {
		const before = await projectChangeEventForWrite(opened.store, input.mutation.method, input.projectId, input.mutation.params, undefined, input.mutation.correlationId);
		const result = await handler(opened.store, input.mutation.params);
		const after = await projectChangeEventForWrite(opened.store, input.mutation.method, input.projectId, input.mutation.params, result, input.mutation.correlationId);
		const event: ProjectChangeEvent = {
			...mergeProjectChangeEventDetails(before, after),
			at: new Date().toISOString(),
			type: "snapshot-changed"
		};
		if (opened.backend === "local" && input.onLocalMutation) {
			input.onLocalMutation(event, await opened.store.getSnapshotSignature());
		}
		input.onMutation?.(event);
		return { event, result };
	} finally {
		await opened.store.close();
	}
}

function writeJson(
	response: ServerResponse,
	payload: unknown,
	diagnostics?: { durationMs: number; metricName: string },
	statusCode = 200
) {
	const body = `${JSON.stringify(payload)}\n`;
	const payloadBytes = Buffer.byteLength(body);
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...(diagnostics ? {
			"Server-Timing": `${diagnostics.metricName};dur=${diagnostics.durationMs.toFixed(3)}`,
			"X-Agent-Issues-Payload-Bytes": String(payloadBytes),
			"X-Agent-Issues-Response-Duration-Ms": String(diagnostics.durationMs)
		} : {})
	});
	response.end(body);
}

function writeText(response: ServerResponse, statusCode: number, body: string) {
	response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(body);
}
