import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openLocalDaemonStore, readBuildContentHash, resolveWorkspaceObservation, type LocalDaemonStoreOptions } from "@agent-issues/api-local";
import {
	BACKFILLABLE_BODY_KINDS,
	InstructionFragmentError,
	InstructionResetAllError,
	InstructionWriteError,
	backfillBodies,
	computeEntityContentHash,
	encodeCanonicalReference,
	PLAN_ENTRY_ROLES,
	PLAN_ENTRY_SCOPE_DIRECTIONS,
	projectProposedPlan,
	toContextSummary,
	toEntitySummary,
	type ContextDetails,
	type ContextDirectory,
	type QueryContextDirectoryResult,
	type EntityRecord,
	type EntitySummary,
	type RelationDirection,
	type RelationType,
	type StorageDriver
} from "@agent-issues/core";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveProjectIdentity } from "../runtime/project-identity.js";
import { ConfirmationTokenStore } from "../runtime/confirmation-tokens.js";
import { resolveMcpWorkspaceScope, type McpWorkspaceScope } from "./client-workspace.js";
import { formatInstructionResponse } from "./instruction-response.js";
import { formatMarkdownResponse } from "./markdown-response.js";
import packageJson from "../../package.json" with { type: "json" };
import { getInstructionVersion } from "../runtime/instruction-version.js";

const PLAN_PREVIEW_RESOURCE_URI = "ui://agent-issues/plan-preview.html";
const PLAN_PREVIEW_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const ISSUE_PREVIEW_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const PLAN_PREVIEW_RESOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PREVIEW_RESOURCE_SCRIPT = readFileSync(
	path.resolve(PLAN_PREVIEW_RESOURCE_DIRECTORY, path.basename(PLAN_PREVIEW_RESOURCE_DIRECTORY) === "dist" ? "plan-preview.js" : "../../dist/plan-preview.js"),
	"utf8"
);
const PLAN_PREVIEW_RESOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><plan-preview-app></plan-preview-app><script type="module">${PLAN_PREVIEW_RESOURCE_SCRIPT}</script></body></html>`;
const ISSUE_PREVIEW_RESOURCE_URI = "ui://agent-issues/issue-preview.html";
const ISSUE_PREVIEW_RESOURCE_SCRIPT = readFileSync(
	path.resolve(PLAN_PREVIEW_RESOURCE_DIRECTORY, path.basename(PLAN_PREVIEW_RESOURCE_DIRECTORY) === "dist" ? "issue-preview.js" : "../../dist/issue-preview.js"),
	"utf8"
);
const ISSUE_PREVIEW_RESOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><issue-preview-app></issue-preview-app><script type="module">${ISSUE_PREVIEW_RESOURCE_SCRIPT}</script></body></html>`;

const issueBreakdownRelationSchema = z.object({
	relationType: z.string().min(1),
	targetId: z.string().min(1).optional(),
	targetKey: z.string().min(1).optional(),
	targetReference: z.string().min(1).optional()
});

const issueBreakdownIssueSchema = z.object({
	key: z.string().min(1),
	title: z.string().min(1),
	outcome: z.string().min(1),
	scope: z.array(z.string().min(1)),
	workMode: z.string().min(1),
	acceptanceCriteria: z.array(z.string().min(1)),
	parentKey: z.string().min(1).optional(),
	planEntryIds: z.array(z.string().min(1)).optional(),
	relationReferences: z.array(issueBreakdownRelationSchema)
});

const relationTypesSchema = z.array(z.string().min(1), { error: "Relation types must be an array of nonempty strings." });
const boundedRelationTypesSchema = z.preprocess(
	(value) => relationTypesSchema.safeParse(value).success ? value : null,
	relationTypesSchema
).meta(z.toJSONSchema(relationTypesSchema, { io: "input", target: "draft-7" }));

const resourceBodyPartSchema = {
	revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
};
const resourceBodySchema = z.discriminatedUnion("resource", [
	z.object({ resource: z.literal("entity"), entityId: z.string().min(1), ...resourceBodyPartSchema }).strict(),
	z.object({ resource: z.literal("comment"), commentId: z.string().min(1), ...resourceBodyPartSchema }).strict(),
	z.object({ resource: z.literal("planEntry"), entryId: z.string().min(1), ...resourceBodyPartSchema }).strict(),
	z.object({ resource: z.literal("context"), scopeRef: z.string().min(1).optional(), ...resourceBodyPartSchema }).strict(),
	z.object({ resource: z.literal("contextTerm"), scopeRef: z.string().min(1).optional(), term: z.string().min(1), ...resourceBodyPartSchema }).strict(),
	z.object({ resource: z.literal("instructionSource"), key: z.string().min(1), ...resourceBodyPartSchema }).strict()
]);

const collectionContinuationSchema = z.string().min(1).max(2048).optional();
const resourceCreateSchema = z.discriminatedUnion("resource", [
	z.object({
		resource: z.literal("entity"),
		kind: z.string().min(1),
		title: z.string().min(1),
		body: z.string().optional(),
		parentId: z.string().min(1).optional(),
		status: z.string().min(1).optional(),
		category: z.string().min(1).optional(),
		priority: z.string().min(1).optional(),
		type: z.string().min(1).optional(),
		links: z.array(z.object({ relationType: z.string().min(1), targetId: z.string().min(1) })).optional()
	}).strict(),
	z.object({
		resource: z.literal("comment"),
		issueId: z.string().min(1),
		body: z.string().min(1),
		referencedIssueIds: z.array(z.string().min(1)).optional()
	}).strict(),
	z.object({
		resource: z.literal("planEntry"),
		planId: z.string().min(1),
		role: z.enum(PLAN_ENTRY_ROLES),
		body: z.string().min(1),
		scopeDirection: z.enum(PLAN_ENTRY_SCOPE_DIRECTIONS).optional(),
		referencedEntityIds: z.array(z.string().min(1)).optional(),
		supersededEntryIds: z.array(z.string().min(1)).optional()
	}).strict(),
	z.object({
		resource: z.literal("context"),
		scopeRef: z.string().min(1).optional(),
		title: z.string().min(1),
		summary: z.string().min(1),
		expectedRevision: z.number().int().positive().optional(),
		expectedContentHash: z.string().min(1).optional()
	}).strict()
]);
const resourceEditSchema = z.discriminatedUnion("resource", [
	z.object({
		resource: z.literal("entity"),
		entityId: z.string().min(1),
		title: z.string().min(1).optional(),
		body: z.string().optional(),
		category: z.string().min(1).optional(),
		priority: z.string().min(1).optional(),
		type: z.string().min(1).nullable().optional(),
		expectedRevision: z.number().int().positive(),
		expectedContentHash: z.string().min(1)
	}).strict(),
	z.object({
		resource: z.literal("comment"),
		commentId: z.string().min(1),
		body: z.string().min(1),
		referencedIssueIds: z.array(z.string().min(1)).optional(),
		expectedRevision: z.number().int().positive(),
		expectedContentHash: z.string().min(1)
	}).strict(),
	z.object({
		resource: z.literal("planEntry"),
		entryId: z.string().min(1),
		body: z.string().min(1),
		expectedRevision: z.number().int().positive(),
		expectedContentHash: z.string().min(1)
	}).strict()
]);
const resourceDeleteSchema = z.discriminatedUnion("resource", [
	z.discriminatedUnion("action", [
		z.object({ resource: z.literal("entity"), action: z.literal("inspect"), entityId: z.string().min(1) }).strict(),
		z.object({ resource: z.literal("entity"), action: z.literal("delete"), entityId: z.string().min(1), confirmationToken: z.string().uuid() }).strict()
	]),
	z.discriminatedUnion("action", [
		z.object({ resource: z.literal("tenant"), action: z.literal("inspect"), tenantId: z.string().min(1) }).strict(),
		z.object({ resource: z.literal("tenant"), action: z.literal("delete"), tenantId: z.string().min(1), confirmationToken: z.string().uuid() }).strict()
	]),
	z.object({
		resource: z.literal("comment"),
		action: z.literal("delete"),
		commentId: z.string().min(1),
		expectedRevision: z.number().int().positive(),
		expectedContentHash: z.string().min(1)
	}).strict(),
	z.object({
		resource: z.literal("planEntry"),
		action: z.literal("delete"),
		entryId: z.string().min(1),
		expectedRevision: z.number().int().positive(),
		expectedContentHash: z.string().min(1)
	}).strict(),
	z.object({
		resource: z.literal("contextTerm"),
		action: z.literal("delete"),
		scopeRef: z.string().min(1).optional(),
		term: z.string().min(1),
		expectedRevision: z.number().int().positive().optional(),
		expectedContentHash: z.string().min(1).optional()
	}).strict()
]);
const resourceListSchema = z.discriminatedUnion("resource", [
	z.object({ resource: z.literal("entity"), kind: z.string().min(1), statuses: z.array(z.string().min(1)).optional(), parentId: z.string().min(1).optional(), limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("orphanEntity"), kind: z.string().min(1).optional(), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("planEntry"), planId: z.string().min(1), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("context"), view: z.enum(["list", "directory"]).default("list"), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("comment"), issueId: z.string().min(1), before: collectionContinuationSchema, all: z.boolean().optional() }).strict(),
	z.object({ resource: z.literal("instructionSource"), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("tenant"), continuation: collectionContinuationSchema }).strict()
]);
type ResourceListRequest = z.infer<typeof resourceListSchema>;

const selectedRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const resourceHistorySchema = z.discriminatedUnion("resource", [
	z.object({ resource: z.literal("comment"), action: z.literal("list"), commentId: z.string().min(1), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("planEntry"), action: z.literal("list"), entryId: z.string().min(1), continuation: collectionContinuationSchema }).strict(),
	z.object({ resource: z.literal("entity"), action: z.literal("revision"), entityId: z.string().min(1), revision: selectedRevisionSchema }).strict(),
	z.object({ resource: z.literal("context"), action: z.literal("revision"), scopeRef: z.string().min(1).optional(), revision: selectedRevisionSchema }).strict(),
	z.object({ resource: z.literal("contextTerm"), action: z.literal("revision"), scopeRef: z.string().min(1).optional(), term: z.string().min(1), revision: selectedRevisionSchema }).strict(),
	z.discriminatedUnion("action", [
		z.object({ resource: z.literal("instructionSource"), action: z.literal("list"), key: z.string().min(1), continuation: collectionContinuationSchema }).strict(),
		z.object({ resource: z.literal("instructionSource"), action: z.literal("revision"), key: z.string().min(1), revision: selectedRevisionSchema }).strict()
	])
]);
type ResourceHistoryRequest = z.infer<typeof resourceHistorySchema>;

export type McpServerOptions = {
	projectIdentity?: string;
	fallbackWorkspaceRoot?: string;
	openStore: (scope?: McpWorkspaceScope) => Promise<
		Pick<
			StorageDriver,
			| "createEntity"
			| "updateEntity"
			| "getEntityDetails"
			| "listEntityHistory"
			| "queryEntities"
			| "queryEntityRelations"
			| "archiveEntity"
			| "deleteEntity"
			| "listContexts"
			| "getContextDetails"
			| "getContextDirectory"
			| "queryContextDirectory"
			| "upsertContext"
			| "defineContextTerm"
			| "forgetContextTerm"
			| "materializeContextRevision"
			| "materializeContextTermRevision"
			| "createIssueComment"
			| "updateIssueComment"
			| "deleteIssueComment"
			| "listIssueComments"
			| "listIssueCommentHistory"
			| "createPlanEntry"
			| "getPlanEntry"
			| "updatePlanEntry"
			| "deletePlanEntry"
			| "linkPlanEntryEntity"
			| "unlinkPlanEntryEntity"
			| "listPlanEntries"
			| "listPlanEntryHistory"
			| "confirmPlan"
			| "moveEntity"
			| "updateEntityStatus"
			| "getProspectorSettings"
			| "retrieveInstruction"
			| "previewInstruction"
			| "listInstructionSources"
			| "readInstructionSource"
			| "compareInstructionSource"
			| "inspectInstructionDependencies"
			| "saveInstructionSource"
			| "listInstructionHistory"
			| "readInstructionRevision"
			| "restoreInstructionRevision"
			| "inspectInstructionReset"
			| "resetInstructionSource"
			| "inspectInstructionResetAll"
			| "resetInstructionAll"
			| "commitInstructionChanges"
			| "createInstructionFragment"
			| "removeInstructionFragment"
			| "linkEntities"
			| "unlinkEntities"
			| "listOrphans"
			| "getInitiativeBundle"
			| "listTenants"
			| "renameTenant"
			| "deleteTenant"
			| "materializeEntityRevision"
			| "restoreEntityRevision"
			| "getDatabaseSnapshot"
			| "setEntityBody"
			| "getIssueBreakdownDraft"
			| "getLatestIssueBreakdownDraft"
			| "createIssueBreakdownDraft"
			| "approveIssueBreakdownDraft"
			| "tenantId"
		>
	>;
	now?: () => number;
};

export function createMcpServer(options: McpServerOptions): McpServer {
	const server = new McpServer({ name: "agent-issues", version: packageJson.version });
	const confirmationTokens = new ConfirmationTokenStore(options.now ?? Date.now);
	const entityListSecret = randomBytes(32);

	async function resolveScope(): Promise<McpWorkspaceScope> {
		return resolveMcpWorkspaceScope({
			listRoots: () => server.server.listRoots(),
			capabilities: server.server.getClientCapabilities(),
			fallbackWorkspaceRoot: options.fallbackWorkspaceRoot,
			projectIdentity: options.projectIdentity,
			resolveIdentity: (workspaceRoot) => resolveProjectIdentity(workspaceRoot).identity
		});
	}

	async function openStore(): Promise<Awaited<ReturnType<McpServerOptions["openStore"]>>> {
		return options.openStore(await resolveScope());
	}

	async function readPlanEntryPart(input: { entryId: string; revision?: number; offset?: number; documentHash?: string }) {
		const toolName = "resource_show";
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const entry = await store.getPlanEntry({ entryId: input.entryId });
			let selected: Record<string, unknown> = entry;
			const revision = input.revision ?? entry.revision;
			if (input.revision !== undefined) {
				const history = await store.listPlanEntryHistory({ entryId: entry.id });
				const target = history.find((item) => item.targetRevision === input.revision);
				if (!target) throw new Error(`Plan-entry revision ${input.revision} is unavailable.`);
				const { headRevision: _headRevision, ...snapshot } = target;
				selected = { ...snapshot, reference: entry.reference, planId: entry.planId, revision };
			}
			const { body, ...metadata } = selected;
			const text = JSON.stringify(metadata);
			const documentHash = createHash("sha256").update(JSON.stringify({ toolName, resource: "planEntry", view: "details", scope, tenantId: store.tenantId, entryId: entry.id, revision, text })).digest("hex");
			return formatMarkdownResponse(text, { reference: entry.reference, revision, format: "json" }, documentHash, toolName, input.offset, input.documentHash);
		} catch (error) {
			return boundedReadError(error, "Plan-entry detail read failed.", "Plan-entry detail read failed. No part was returned. Restart without offset and documentHash.");
		}
	}

	server.registerTool(
		"instruction_retrieve",
		{
			description: "Retrieve the complete instructions for a skill or agent by key. Use this tool when a loader requires instruction_retrieve, such as key skill/start-work. Returns database Markdown with all required fragments included, in parts within 65536 UTF-8 JSON bytes. The first text block is JSON metadata; the second is Markdown. Call again with the same key, documentHash, and nextOffset as offset until nextOffset is null. Copy the returned offset; do not calculate it. Read all parts before use. On failure, stop; on a changed document, discard all parts and restart with key only.",
			inputSchema: {
				key: z.string().min(1),
				offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
				documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
			}
		},
		async ({ key, offset, documentHash }) => formatInstructionResponse(await (await openStore()).retrieveInstruction({ key, version: getInstructionVersion() }), offset, documentHash)
	);

	server.registerTool(
		"instruction_inspect",
		{
			description: "Inspect instruction sources without saving changes. Set request.action to compare, dependencies, or preview. Compare returns complete JSON in parts within 65536 UTF-8 JSON bytes: the first text block is metadata with format json; the second is a JSON text part. Copy nextOffset into request.offset with the same key and documentHash until null, join text parts without separators, then parse JSON. The hash binds the owner, scope, release, and selected source snapshots; changed sources require restart without offset and documentHash. Dependencies returns bounded dependencies, affectedInstructions, and modifiedFragments sections in section/key order. Copy nextContinuation into request.continuation with the same key until null and join each section. Dependency pages are live reads, not snapshots; earlier keys are not revisited. Invalid continuation or oversized summaries returns an error without a page. Preview expands pending changes without activation. Use resource_list for catalog summaries, resource_history for revision summaries, resource_body for unexpanded Markdown, and instruction_retrieve for runtime instructions.",
			annotations: { readOnlyHint: true },
			inputSchema: { request: z.discriminatedUnion("action", [
				z.object({ action: z.literal("compare"), key: z.string().min(1), offset: resourceBodyPartSchema.offset, documentHash: resourceBodyPartSchema.documentHash }),
				z.object({ action: z.literal("dependencies"), key: z.string().min(1), continuation: collectionContinuationSchema }),
				z.object({ action: z.literal("preview"), key: z.string().min(1), changes: z.array(z.object({ key: z.string().min(1), body: z.string() })).min(1) })
			]) }
		},
		async ({ request }) => {
			if (request.action === "dependencies") {
				try {
					const scope = await resolveScope();
					const store = await options.openStore(scope);
					const version = getInstructionVersion();
					const { owner } = await store.inspectInstructionResetAll({ version });
					const requestHash = createHash("sha256").update(JSON.stringify({ tool: "instruction_inspect", action: request.action, key: request.key, tenantId: store.tenantId, scope, owner, version, order: "section-key-asc" })).digest("hex");
					const after = readPageContinuation(request.continuation, requestHash, entityListSecret, "instruction_inspect");
					const inspection = await store.inspectInstructionDependencies({ key: request.key, version });
					const items = [
						...inspection.dependencies.map((item) => ({ key: JSON.stringify(["dependencies", item.key]), section: "dependencies", value: item })),
						...inspection.affectedInstructions.map((key) => ({ key: JSON.stringify(["affectedInstructions", key]), section: "affectedInstructions", value: key })),
						...inspection.modifiedFragments.map((key) => ({ key: JSON.stringify(["modifiedFragments", key]), section: "modifiedFragments", value: key }))
					];
					return formatKeyedCollectionPage(items, after, requestHash, entityListSecret, (page) => ({
						key: inspection.key, version, source: inspection.source,
						dependencies: page.filter((item) => item.section === "dependencies").map((item) => item.value),
						affectedInstructions: page.filter((item) => item.section === "affectedInstructions").map((item) => item.value),
						modifiedFragments: page.filter((item) => item.section === "modifiedFragments").map((item) => item.value)
					}), "agent-issues instruction dependencies <key> --json", "Instruction dependency");
				} catch (error) {
					return boundedReadError(error, "Instruction dependency read failed.", "Instruction dependency read failed. No page was returned. Restart without continuation.");
				}
			}
			if (request.action === "compare") {
				try {
					const scope = await resolveScope();
					const store = await options.openStore(scope);
					const version = getInstructionVersion();
					const { owner } = await store.inspectInstructionResetAll({ version });
					const comparison = await store.compareInstructionSource({ key: request.key, version });
					const text = JSON.stringify(comparison);
					const documentHash = createHash("sha256").update(JSON.stringify({ tool: "instruction_inspect", action: request.action, key: request.key, tenantId: store.tenantId, scope, owner, version, text })).digest("hex");
					return formatMarkdownResponse(text, { key: request.key, version, format: "json" }, documentHash, "instruction_inspect", request.offset, request.documentHash);
				} catch (error) {
					return boundedReadError(error, "Instruction comparison read failed.", "Instruction comparison read failed. No part was returned. Restart without offset and documentHash.");
				}
			}
			const store = await openStore();
			const version = getInstructionVersion();
			switch (request.action) {
				case "preview": return toolResult(await store.previewInstruction({ key: request.key, changes: request.changes, version }));
			}
		}
	);

	server.registerTool(
		"instruction_update",
		{
			description: "Update personal instruction sources. Set request.action to save, commit, restore, create_fragment, or remove_fragment. Save, restore, and removal require expected revisions. Commit validates all changes and saves all or none. Validate fragment dependencies before activation on the next retrieval. Keep official defaults unchanged.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: { request: z.discriminatedUnion("action", [
				z.object({ action: z.literal("save"), key: z.string().min(1), body: z.string(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
				z.object({ action: z.literal("commit"), changes: z.array(z.discriminatedUnion("operation", [
					z.object({ operation: z.literal("save"), key: z.string().min(1), body: z.string(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
					z.object({ operation: z.literal("remove"), key: z.string().min(1), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
				])).min(1) }),
				z.object({ action: z.literal("restore"), key: z.string().min(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
				z.object({ action: z.literal("create_fragment"), key: z.string().min(1), body: z.string() }),
				z.object({ action: z.literal("remove_fragment"), key: z.string().min(1), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
			]) }
		},
		async ({ request }) => {
			try {
				const store = await openStore();
				const version = getInstructionVersion();
				switch (request.action) {
					case "save": return toolResult(await store.saveInstructionSource({ key: request.key, body: request.body, expectedRevision: request.expectedRevision, version }));
					case "commit": return toolResult(await store.commitInstructionChanges({ changes: request.changes, version }));
					case "restore": return toolResult(await store.restoreInstructionRevision({ key: request.key, revision: request.revision, expectedRevision: request.expectedRevision, version }));
					case "create_fragment": return toolResult(await store.createInstructionFragment({ key: request.key, body: request.body, version }));
					case "remove_fragment": return toolResult(await store.removeInstructionFragment({ key: request.key, expectedRevision: request.expectedRevision, version }));
				}
			} catch (error) {
				if (!(error instanceof InstructionWriteError) && !(error instanceof InstructionFragmentError)) throw error;
				return { ...toolResult({ error: error.message, reason: error.reason, currentSource: error.currentSource,
					...(error instanceof InstructionFragmentError ? { affectedReferences: error.affectedReferences } : {}) }), isError: true };
			}
		}
	);

	server.registerTool(
		"instruction_reset",
		{
			description: "Reset personal instruction sources to release defaults. Set request.scope to one or all and request.phase to inspect or apply. Inspect returns impact and a confirmation token without saving. Review the impact before apply. Apply requires that token and expected revisions. Scope one retains fragment overrides. Scope all clears owner overrides and personal fragments together. Retain official defaults and other owners.",
			annotations: { readOnlyHint: false, destructiveHint: true },
			inputSchema: { request: z.union([
				z.object({ scope: z.literal("one"), phase: z.literal("inspect"), key: z.string().min(1) }),
				z.object({ scope: z.literal("all"), phase: z.literal("inspect") }),
				z.object({ scope: z.literal("one"), phase: z.literal("apply"), key: z.string().min(1), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), confirmationToken: z.string().uuid() }),
				z.object({ scope: z.literal("all"), phase: z.literal("apply"), expectedRevisions: z.array(z.object({ key: z.string().min(1), sourceType: z.enum(["override", "personal"]), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })), confirmationToken: z.string().uuid() })
			]) }
		},
		async ({ request }) => {
			try {
				const store = await openStore();
				const version = getInstructionVersion();
				if (request.scope === "one") {
					const impact = await store.inspectInstructionReset({ key: request.key, version });
					if (request.phase === "inspect") {
						const confirmation = confirmationTokens.issue("instruction_reset", { tenantId: store.tenantId, key: request.key, expectedRevision: impact.currentSource.source.revision, impact });
						return toolResult({ ...impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
					}
					if (impact.currentSource.source.revision !== request.expectedRevision) throw new InstructionWriteError("revision-conflict", impact.currentSource, `Instruction revision conflict: ${JSON.stringify(impact.currentSource)}`);
					confirmationTokens.consume(request.confirmationToken, "instruction_reset", { tenantId: store.tenantId, key: request.key, expectedRevision: request.expectedRevision, impact });
					return toolResult(await store.resetInstructionSource({ key: request.key, expectedRevision: request.expectedRevision, version }));
				}
				const impact = await store.inspectInstructionResetAll({ version });
				if (request.phase === "inspect") {
					const confirmation = confirmationTokens.issue("instruction_reset_all", { impact });
					return toolResult({ ...impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
				}
				confirmationTokens.consume(request.confirmationToken, "instruction_reset_all", { impact });
				return toolResult(await store.resetInstructionAll({ expectedRevisions: request.expectedRevisions, version }));
			} catch (error) {
				if (error instanceof InstructionResetAllError) return { ...toolResult({ error: error.message, reason: error.reason, currentInspection: error.currentInspection }), isError: true };
				if (!(error instanceof InstructionWriteError)) throw error;
				return { ...toolResult({ error: error.message, reason: error.reason, currentSource: error.currentSource }), isError: true };
			}
		}
	);

	registerAppResource(
		server,
		"Plan Preview",
		PLAN_PREVIEW_RESOURCE_URI,
		{},
		async () => ({
			contents: [{ uri: PLAN_PREVIEW_RESOURCE_URI, mimeType: PLAN_PREVIEW_RESOURCE_MIME_TYPE, text: PLAN_PREVIEW_RESOURCE_HTML }]
		})
	);
	registerAppResource(
		server,
		"Issue Preview",
		ISSUE_PREVIEW_RESOURCE_URI,
		{},
		async () => ({
			contents: [{ uri: ISSUE_PREVIEW_RESOURCE_URI, mimeType: ISSUE_PREVIEW_RESOURCE_MIME_TYPE, text: ISSUE_PREVIEW_RESOURCE_HTML }]
		})
	);

	server.registerTool(
		"project_identity",
		{
			description: "Get the resolved project identity for this MCP server.",
			inputSchema: {}
		},
		async () => {
			const scope = await resolveScope();
			return toolResult({ projectIdentity: scope.projectIdentity ?? null, workspaceRoot: scope.workspaceRoot ?? null });
		}
	);

	server.registerTool(
		"resource_create",
		{
			description: "Create an entity, issue comment, or Plan entry, or create or update tracker context text. Set request.resource to select the resource and provide its typed fields.",
			inputSchema: { request: resourceCreateSchema }
		},
		async ({ request }) => {
			switch (request.resource) {
				case "entity": {
					const { resource: _resource, ...input } = request;
					return toolResult({ entity: await (await openStore()).createEntity(input) });
				}
				case "comment": {
					const store = await openStore();
					const referencedIssueIds = request.referencedIssueIds === undefined ? undefined : await resolveEntityIds(store, request.referencedIssueIds);
					const comment = await store.createIssueComment({ issueId: request.issueId, body: request.body, referencedIssueIds });
					return toolResult({ comment });
				}
				case "planEntry": {
					const store = await openStore();
					const { resource: _resource, ...input } = request;
					const referencedEntityIds = input.referencedEntityIds === undefined ? undefined : await resolveEntityIds(store, input.referencedEntityIds);
					const supersededEntryIds = input.supersededEntryIds === undefined ? undefined : await resolvePlanEntryIds(store, input.supersededEntryIds);
					const entry = await store.createPlanEntry({ ...input, referencedEntityIds, supersededEntryIds });
					return toolResult({ entry });
				}
				case "context": {
					const { resource: _resource, ...input } = request;
					return toolResult(await (await openStore()).upsertContext(input));
				}
			}
		}
	);

	server.registerTool(
		"resource_edit",
		{
			description: "Edit an entity, issue comment, or Plan entry. Set request.resource to select the resource and provide its typed fields.",
			inputSchema: { request: resourceEditSchema }
		},
		async ({ request }) => {
			switch (request.resource) {
				case "entity": {
					const { resource: _resource, ...input } = request;
					return toolResult({ entity: await (await openStore()).updateEntity(input) });
				}
				case "comment": {
					const store = await openStore();
					const referencedIssueIds = request.referencedIssueIds === undefined ? undefined : await resolveEntityIds(store, request.referencedIssueIds);
					const { resource: _resource, ...input } = request;
					return toolResult({ comment: await store.updateIssueComment({ ...input, referencedIssueIds }) });
				}
				case "planEntry": {
					const { resource: _resource, ...input } = request;
					return toolResult({ entry: await (await openStore()).updatePlanEntry(input) });
				}
			}
		}
	);

	server.registerTool(
		"entity_archive",
		{
			description: "Archive a tracker entity.",
			inputSchema: { entityId: z.string().min(1) }
		},
		async ({ entityId }) => toolResult(await (await openStore()).archiveEntity({ entityId }))
	);

	server.registerTool(
		"resource_delete",
		{
			description: "Delete an entity, tenant, issue comment, Plan entry, or context term. Set request.resource to select the resource and request.action to inspect or delete.",
			inputSchema: { request: resourceDeleteSchema }
		},
		async ({ request }) => {
			switch (request.resource) {
				case "entity": {
					if (request.action === "inspect") {
						const impact = await (await openStore()).getEntityDetails(request.entityId);
						const confirmation = confirmationTokens.issue("entity_delete", { entityId: request.entityId });
						return toolResult({ impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
					}

					confirmationTokens.consume(request.confirmationToken, "entity_delete", { entityId: request.entityId });
					return toolResult(await (await openStore()).deleteEntity({ entityId: request.entityId }));
				}
				case "tenant": {
					if (request.action === "inspect") {
						const impact = (await (await openStore()).listTenants()).find((tenant) => tenant.id === request.tenantId);
						if (!impact) throw new Error(`Tenant not found: ${request.tenantId}`);

						const confirmation = confirmationTokens.issue("tenant_delete", { tenantId: request.tenantId });
						return toolResult({ impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt });
					}

					confirmationTokens.consume(request.confirmationToken, "tenant_delete", { tenantId: request.tenantId });
					return toolResult(await (await openStore()).deleteTenant(request.tenantId));
				}
				case "comment": {
					const store = await openStore();
					const { resource: _resource, action: _action, ...input } = request;
					return toolResult({ comment: await store.deleteIssueComment(input) });
				}
				case "planEntry": {
					const { resource: _resource, action: _action, ...input } = request;
					return toolResult({ entry: await (await openStore()).deletePlanEntry(input) });
				}
				case "contextTerm": {
					const { resource: _resource, action: _action, ...input } = request;
					return toolResult(await (await openStore()).forgetContextTerm(input));
				}
			}
		}
	);

	server.registerTool(
		"entity_move",
		{
			description: "Move a tracker entity to a new parent.",
			inputSchema: { entityId: z.string().min(1), newParentId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).moveEntity(input))
	);

	server.registerTool(
		"entity_status",
		{
			description: "Update a tracker entity status.",
			inputSchema: { entityId: z.string().min(1), status: z.string().min(1) }
		},
		async (input) => {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const { entity } = await store.getEntityDetails(input.entityId);
			const workspaceObservation = entity.kind === "issue" && entity.status !== "done" && input.status === "done" && scope.workspaceRoot
				? await resolveWorkspaceObservation(scope.workspaceRoot, await store.getProspectorSettings())
				: undefined;
			return toolResult(await store.updateEntityStatus({ ...input, workspaceObservation }));
		}
	);

	async function readEntityList({ kind, statuses, parentId, limit, continuation }: Extract<ResourceListRequest, { resource: "entity" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const requestHash = createHash("sha256").update(JSON.stringify({
				tool: "resource_list", resource: "entity", operation: "list",
				tenantId: store.tenantId, projectIdentity: scope.projectIdentity ?? null,
				workspaceRoot: scope.workspaceRoot ?? null, kind, statuses: [...new Set(statuses ?? [])].sort(),
				parentId: parentId ?? null, limit: limit ?? null, order: "id-asc"
			})).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret);
			const result = await store.queryEntities({ kind, statuses, parentId });
			return formatEntityListPage(result.entities, after, requestHash, entityListSecret, limit);
		} catch (error) {
			return boundedReadError(error, "Entity list failed.", "Entity list failed. Error details exceed the response budget. No page was returned. Check the request and restart without continuation.");
		}
	}

	async function readInstructionCatalog(request: Extract<ResourceListRequest, { resource: "instructionSource" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const version = getInstructionVersion();
			const { owner } = await store.inspectInstructionResetAll({ version });
			const requestHash = createHash("sha256").update(JSON.stringify({ tool: "resource_list", resource: request.resource, tenantId: store.tenantId, scope, owner, version, order: "key-asc" })).digest("hex");
			const after = readPageContinuation(request.continuation, requestHash, entityListSecret, "resource_list");
			const catalog = await store.listInstructionSources({ version });
			return formatKeyedCollectionPage(catalog.items.map(({ body: _body, ...item }) => ({
				key: item.key,
				value: { ...item, reads: {
					body: { tool: "resource_body", arguments: { request: { resource: "instructionSource", key: item.key, ...(item.source.type === "default" ? {} : { revision: item.source.revision }) } } },
					details: { command: "agent-issues", arguments: ["instruction", "read", item.key, "--json"] }
				} }
			})), after, requestHash, entityListSecret, (items) => ({ version, items: items.map((item) => item.value) }), "agent-issues instruction list --json", "Instruction");
		} catch (error) {
			return boundedReadError(error, "Instruction catalog read failed.", "Instruction catalog read failed. No page was returned. Restart without continuation.");
		}
	}

	server.registerTool(
		"resource_list",
		{
			description: "List resources without changes. Set request.resource to entity (required kind; optional statuses, parentId, limit), orphanEntity (optional kind), planEntry (required planId), context (view list or directory), comment (required issueId), instructionSource, or tenant. Keep each request unchanged during traversal. Paged routes return nextContinuation; copy it into request.continuation until null. Instruction catalog summaries use ascending item-key order and exclude Markdown bodies; use returned resource_body or CLI detail references for complete source. Comments retain newest-page ordering: copy nextBefore into request.before and prepend older pages; all cannot disable paging. Summary pages fit 65536 UTF-8 JSON bytes. Pages are live reads, not snapshots. Tokens are bound to the resource, operation, owner, release where applicable, scope, filters, order, and server process. Invalid continuation or oversized metadata returns an error without a page. Use returned read references for complete details.",
			annotations: { readOnlyHint: true },
			inputSchema: { request: resourceListSchema }
		},
		async ({ request }) => {
			switch (request.resource) {
				case "entity": return readEntityList(request);
				case "orphanEntity": return readOrphanList(request);
				case "planEntry": return readPlanEntryList(request);
				case "context": return readContextPage(request.view === "directory" ? "context_directory" : "context_list", { continuation: request.continuation });
				case "comment": return readCommentList(request);
				case "instructionSource": return readInstructionCatalog(request);
				case "tenant": return readTenantList(request);
			}
		}
	);

	server.registerTool(
		"resource_body",
		{
			description: "Read complete current or historical resource text in parts within 65536 UTF-8 JSON bytes. Set request.resource to entity, planEntry, context, contextTerm, comment, or instructionSource and supply its identifiers. Instruction source is unexpanded Markdown; use instruction_retrieve for runtime instructions. The first text block is metadata; the second is Markdown. Copy nextOffset into request.offset with the same resource, revision, and documentHash until null. Read all parts before use. On a changed document, discard all parts and restart without offset and documentHash.",
			annotations: { readOnlyHint: true },
			inputSchema: { request: resourceBodySchema }
		},
		async ({ request }) => {
			try {
				const scope = await resolveScope();
				const store = await options.openStore(scope);
				let body: string;
				let reference: string;
				let revision: number;
				let resourceScope: Record<string, unknown> = {};
				switch (request.resource) {
					case "entity": {
						const { entity } = await store.getEntityDetails(request.entityId);
						const selected = request.revision === undefined ? entity : await store.materializeEntityRevision({ entityId: entity.id, revision: request.revision });
						body = selected.body;
						reference = entity.reference;
						revision = request.revision ?? entity.revision;
						break;
					}
					case "comment": {
						const history = await store.listIssueCommentHistory({ commentId: request.commentId });
						revision = request.revision ?? Math.max(...history.map((entry) => entry.targetRevision));
						const selected = history.find((entry) => entry.targetRevision === revision);
						if (!selected) throw new Error("Issue comment or revision not found.");
						body = selected.body;
						reference = encodeCanonicalReference("issueComment", selected.commentId);
						break;
					}
					case "planEntry": {
						const entry = await store.getPlanEntry({ entryId: request.entryId });
						revision = request.revision ?? entry.revision;
						const selected = request.revision === undefined ? entry : (await store.listPlanEntryHistory({ entryId: entry.id })).find((item) => item.targetRevision === revision);
						if (!selected) throw new Error(`Plan-entry revision ${revision} is unavailable.`);
						if (typeof selected.body !== "string") throw new Error("Plan-entry body is unavailable.");
						body = selected.body;
						reference = entry.reference;
						break;
					}
					case "context": {
						const { context } = await store.getContextDetails({ scopeRef: request.scopeRef });
						const selected = request.revision === undefined ? context : await store.materializeContextRevision({ scopeRef: request.scopeRef, revision: request.revision });
						body = selected.summary;
						reference = context.reference ?? context.key;
						revision = request.revision ?? context.revision;
						resourceScope = { contextKey: context.key };
						break;
					}
					case "contextTerm": {
						const details = await store.getContextDetails({ scopeRef: request.scopeRef });
						if (request.revision === undefined) {
							const term = details.terms.find((item) => item.term === request.term);
							if (!term) throw new Error("Context term not found.");
							body = term.definition;
							reference = term.reference;
							revision = term.revision;
						} else {
							const selected = await store.materializeContextTermRevision({ scopeRef: request.scopeRef, term: request.term, revision: request.revision });
							body = selected.definition;
							reference = encodeCanonicalReference("contextTerm", selected.id);
							revision = request.revision;
						}
						resourceScope = { contextKey: details.context.key, term: request.term };
						break;
					}
					case "instructionSource": {
						const version = getInstructionVersion();
						const selected = request.revision === undefined
							? await store.readInstructionSource({ key: request.key, version })
							: await store.readInstructionRevision({ key: request.key, version, revision: request.revision });
						const { owner } = await store.inspectInstructionResetAll({ version });
						body = selected.body;
						reference = selected.key;
						revision = selected.source.revision;
						resourceScope = { owner, version, source: selected.source };
						break;
					}
				}
				const identity = { resource: request.resource, reference, revision, tenantId: store.tenantId, scope, ...resourceScope };
				const hash = createHash("sha256").update(JSON.stringify({ ...identity, body })).digest("hex");
				return formatMarkdownResponse(body, identity, hash, "resource_body", request.offset, request.documentHash);
			} catch (error) {
				return boundedReadError(error, "Resource body read failed.", "Resource body read failed. No body was returned. Check the resource and revision, then restart without offset and documentHash.");
			}
		}
	);

	async function readInstructionHistory(request: Extract<ResourceHistoryRequest, { resource: "instructionSource"; action: "list" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const version = getInstructionVersion();
			const { owner } = await store.inspectInstructionResetAll({ version });
			const requestHash = createHash("sha256").update(JSON.stringify({ tool: "resource_history", resource: request.resource, action: request.action, key: request.key, tenantId: store.tenantId, scope, owner, version, order: "revision-asc" })).digest("hex");
			const after = readPageContinuation(request.continuation, requestHash, entityListSecret, "resource_history");
			const history = await store.listInstructionHistory({ key: request.key, version });
			return formatKeyedCollectionPage(history.revisions.map(({ body: _body, ...entry }) => ({
				key: String(entry.source.revision).padStart(16, "0"),
				value: { ...entry, reads: { body: { tool: "resource_body", arguments: { request: { resource: "instructionSource", key: entry.key, revision: entry.source.revision } } } } }
			})), after, requestHash, entityListSecret, (items) => ({ key: history.key, version, revisions: items.map((item) => item.value) }), "agent-issues instruction history <key> --json", "Instruction history");
		} catch (error) {
			return boundedReadError(error, "Instruction history read failed.", "Instruction history read failed. No page was returned. Restart without continuation.");
		}
	}

	server.registerTool(
		"resource_history",
		{
			description: "Read resource revision metadata without historical text. Use action list for comment, planEntry, or instructionSource histories; use action revision for entity, context, contextTerm, or instructionSource with a positive revision. Follow returned resource_body or complete CLI detail references for selected text. History pages fit within 65536 UTF-8 JSON bytes: copy nextContinuation into request.continuation with the same request until null. Instruction revisions use ascending source-revision order and exclude Markdown bodies. Continuation is bound to the resource, action, identity, owner and release where applicable, tenant, workspace/project, order, and server process. Histories are live reads, not snapshots; later revisions can appear and headRevision can change. Invalid continuation or oversized summaries returns an error without a page. Unsupported combinations fail before storage opens. Restores and writes use separate tools.",
			annotations: { readOnlyHint: true },
			inputSchema: { request: resourceHistorySchema }
		},
		async ({ request }) => {
			if (request.resource === "comment") return readCommentHistory(request);
			if (request.resource === "planEntry") return readPlanEntryHistory(request);
			if (request.resource === "instructionSource" && request.action === "list") return readInstructionHistory(request);
			const store = await openStore();
			switch (request.resource) {
				case "entity": {
					const { entity } = await store.getEntityDetails(request.entityId);
					const selected = await store.materializeEntityRevision({ entityId: request.entityId, revision: request.revision });
					const { body: _body, ...metadata } = selected;
					const { action: _action, ...bodyRequest } = request;
					return toolResult({ ...metadata, reference: entity.reference, reads: { body: { tool: "resource_body", arguments: { request: { ...bodyRequest, entityId: entity.reference } } } } });
				}
				case "context": {
					const { context } = await store.getContextDetails({ scopeRef: request.scopeRef });
					const selected = await store.materializeContextRevision({ scopeRef: request.scopeRef, revision: request.revision });
					const { summary: _summary, ...metadata } = selected;
					const { action: _action, ...bodyRequest } = request;
					return toolResult({ ...metadata, reference: context.reference, reads: { body: { tool: "resource_body", arguments: { request: bodyRequest } } } });
				}
				case "contextTerm": {
					const selected = await store.materializeContextTermRevision({ scopeRef: request.scopeRef, term: request.term, revision: request.revision });
					const { definition: _definition, ...metadata } = selected;
					const { action: _action, ...bodyRequest } = request;
					return toolResult({ ...metadata, reference: encodeCanonicalReference("contextTerm", selected.id), reads: { body: { tool: "resource_body", arguments: { request: bodyRequest } } } });
				}
				case "instructionSource": {
					const version = getInstructionVersion();
					const selected = await store.readInstructionRevision({ key: request.key, revision: request.revision, version });
					const { body: _body, ...metadata } = selected;
					const { action: _action, ...bodyRequest } = request;
					return toolResult({ ...metadata, reads: { body: { tool: "resource_body", arguments: { request: bodyRequest } } } });
				}
			}
		}
	);

	server.registerTool(
		"resource_show",
		{
			description: "Read resource metadata without authored bodies. Set request.resource to entity with reference, planEntry with entryId, context with optional scopeRef, contextTerm with term and optional scopeRef, or instructionSource with key. Plan-entry view summary is the default; view details returns complete metadata, including link and supersession collections, in bounded JSON parts. Details accepts optional revision, offset, and documentHash inside request. Join second text blocks without separators, then parse JSON. Copy nextOffset into request.offset with the same entry, revision, view, and hash until null. Parts fit 65536 UTF-8 JSON bytes. Invalid continuation or changed documents returns an error without partial data; discard parts and restart. Bodies use resource_body. For issueBreakdown use action show with draftId or latest with targetId. Follow returned read references. Use initiative_bundle explicitly for an initiative graph and instruction_retrieve for runtime instructions.",
			annotations: { readOnlyHint: true },
			inputSchema: { request: z.discriminatedUnion("resource", [
				z.object({ resource: z.literal("entity"), reference: z.string().min(1) }).strict(),
				z.discriminatedUnion("view", [
					z.object({ resource: z.literal("planEntry"), view: z.literal("summary").optional(), entryId: z.string().min(1) }).strict(),
					z.object({ resource: z.literal("planEntry"), view: z.literal("details"), entryId: z.string().min(1), ...resourceBodyPartSchema }).strict()
				]),
				z.object({ resource: z.literal("instructionSource"), key: z.string().min(1) }).strict(),
				z.object({ resource: z.literal("context"), scopeRef: z.string().min(1).optional() }).strict(),
				z.object({ resource: z.literal("contextTerm"), scopeRef: z.string().min(1).optional(), term: z.string().min(1) }).strict(),
				z.discriminatedUnion("action", [
					z.object({ resource: z.literal("issueBreakdown"), action: z.literal("show"), draftId: z.string().min(1) }).strict(),
					z.object({ resource: z.literal("issueBreakdown"), action: z.literal("latest"), targetId: z.string().min(1) }).strict()
				])
			]) }
		},
		async ({ request }) => {
			if (request.resource === "planEntry" && request.view === "details") return readPlanEntryPart(request);
			try {
				const store = await openStore();
				if (request.resource === "issueBreakdown") {
					const selected = request.action === "show"
						? await store.getIssueBreakdownDraft({ draftId: request.draftId })
						: await store.getLatestIssueBreakdownDraft({ targetId: (await store.getEntityDetails(request.targetId)).entity.id });
					const { issues: _issues, ...draft } = selected;
					return toolResult({ draft, reads: { details: { command: "agent-issues", arguments: ["issue-breakdown", "show", draft.id, "--json"] } } });
				}
				if (request.resource === "instructionSource") {
					const version = getInstructionVersion();
					const { body: _body, ...source } = await store.readInstructionSource({ key: request.key, version });
					return toolResult({ ...source, reads: {
						body: { tool: "resource_body", arguments: { request: { resource: "instructionSource", key: source.key, ...(source.source.type === "default" ? {} : { revision: source.source.revision }) } } },
						details: { command: "agent-issues", arguments: ["instruction", "read", source.key, "--json"] }
					} });
				}
				if (request.resource === "planEntry") {
					const { body: _body, ...entry } = await store.getPlanEntry({ entryId: request.entryId });
					return toolResult({ entry, reads: {
						body: { tool: "resource_body", arguments: { request: { resource: "planEntry", entryId: entry.reference, revision: entry.revision } } },
						details: planEntryDetailRead(entry.reference, entry.revision)
					} });
				}
				if (request.resource === "context" || request.resource === "contextTerm") {
					const details = await store.getContextDetails({ scopeRef: request.scopeRef });
					const detailRead = { command: "agent-issues", arguments: ["context", "show", ...(request.scopeRef ? [request.scopeRef] : []), "--json"] };
					const terms = details.terms.map(({ definition: _definition, ...term }) => ({
						...term,
						reads: { body: { tool: "resource_body", arguments: { request: { resource: "contextTerm", scopeRef: request.scopeRef, term: term.term, revision: term.revision } } }, details: detailRead }
					}));
					if (request.resource === "contextTerm") {
						const term = terms.find((item) => item.term === request.term);
						if (!term) throw new Error("Context term not found.");
						return toolResult({ term, reads: term.reads });
					}
					const { summary: _summary, ...context } = details.context;
					return toolResult({ context, terms, reads: { body: { tool: "resource_body", arguments: { request: { resource: "context", scopeRef: request.scopeRef, ...(context.revision > 0 ? { revision: context.revision } : {}) } } }, details: detailRead } });
				}
				const reference = request.reference;
				const details = await store.getEntityDetails(reference);
				const { body, bodySource, ...entity } = details.entity;
				const reads = {
					body: { tool: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference } } },
					relations: { tool: "relation_query", arguments: { entityId: entity.reference } },
					details: { command: "agent-issues", arguments: ["show", entity.reference, "--json"] }
				};
				const result = toolResult({ entity, reads });
				if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 65536) return result;
				return {
					...toolResult({ error: "Entity metadata exceeds the 65536-byte response budget. No metadata was returned. Use the complete CLI detail read.", reference: entity.reference, reads }),
					isError: true
				};
			} catch (error) {
				return boundedReadError(error, "Resource metadata read failed.", "Resource metadata read failed. Error details exceed the response budget. No metadata was returned. Check the resource identifiers or use the complete CLI detail read.");
			}
		}
	);

	registerAppTool(
		server,
		"plan_preview",
		{
			description: "Get a Proposed Plan for review.",
			inputSchema: { planId: z.string().min(1) },
			_meta: { ui: { resourceUri: PLAN_PREVIEW_RESOURCE_URI } }
		},
		async ({ planId }) => {
			const store = await openStore();
			const details = await store.getEntityDetails(planId);
			if (details.entity.kind !== "plan") {
				throw new Error(`Plan preview requires a Plan: ${planId}`);
			}
			const proposedPlan = projectProposedPlan(details.entity, await store.listPlanEntries({ planId: details.entity.id }));
			const plan = { ...proposedPlan, status: details.entity.status, revision: details.entity.revision };
			return textToolResult(formatPlanPreview(plan), { plan });
		}
	);

	server.registerTool(
		"issue_breakdown_create",
		{
			description: "Create an issue-breakdown draft without creating issue records.",
			inputSchema: {
				targetId: z.string().min(1),
				issues: z.array(issueBreakdownIssueSchema).min(1)
			}
		},
		async (input) => {
			const store = await openStore();
			const target = await store.getEntityDetails(input.targetId);
			const draft = await store.createIssueBreakdownDraft({
				targetId: target.entity.id,
				issues: input.issues
			});
			return toolResult({ draft });
		}
	);

	registerAppTool(
		server,
		"issue_breakdown_preview",
		{
			description: "Get a proposed issue breakdown for review.",
			inputSchema: { draftId: z.string().min(1) },
			_meta: { ui: { resourceUri: ISSUE_PREVIEW_RESOURCE_URI } }
		},
		async ({ draftId }) => {
			const draft = await (await openStore()).getIssueBreakdownDraft({ draftId });
			return textToolResult(formatIssueBreakdownPreview(draft), { draft });
		}
	);

	server.registerTool(
		"issue_breakdown_approve",
		{
			description: "Approve the exact proposed issue breakdown and create its issue graph.",
			inputSchema: { draftId: z.string().min(1), snapshotDigest: z.string().length(64).regex(/^[a-f0-9]+$/) }
		},
		async (input) => toolResult(await (await openStore()).approveIssueBreakdownDraft(input))
	);

	server.registerTool(
		"plan_confirm",
		{
			description: "Confirm the exact Proposed Plan snapshot as ready.",
			inputSchema: { planId: z.string().min(1), snapshotDigest: z.string().length(64).regex(/^[a-f0-9]+$/) }
		},
		async (input) => toolResult(await (await openStore()).confirmPlan(input))
	);

	async function readContextPage(tool: "context_list" | "context_directory" | "context_search", input: { query?: string; view?: "all" | "global" | "initiatives"; continuation?: string }) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const query = input.query?.trim() ?? "";
			const view = input.view ?? "all";
			const requestHash = createHash("sha256").update(JSON.stringify({
				operation: tool === "context_search" ? { tool } : { tool: "resource_list", resource: "context", view: tool === "context_list" ? "list" : "directory" }, tenantId: store.tenantId, scope, query, view, order: "section-key-asc"
			})).digest("hex");
			const after = readPageContinuation(input.continuation, requestHash, entityListSecret, tool);
			if (tool === "context_list") {
				const { contexts } = await store.listContexts();
				return formatKeyedCollectionPage(contexts.map((item) => ({
					key: item.context.key,
					value: contextPageSummary(item)
				})), after, requestHash, entityListSecret, (items) => ({ contexts: items.map((item) => item.value) }), "agent-issues context list --json");
			}
			const directory = tool === "context_directory" ? await store.getContextDirectory() : await store.queryContextDirectory({ query, view });
			return formatContextDirectoryPage(directory, after, requestHash, entityListSecret);
		} catch (error) {
			return boundedReadError(error, "Context collection read failed.", "Context collection read failed. No page was returned. Check the request and restart without continuation.");
		}
	}

	server.registerTool(
		"context_search",
		{
			description: "Search context summary sections within 65536 UTF-8 JSON bytes. Copy nextContinuation with the same query and view until null and join all sections. Order is the JSON tuple of section and immutable context key or normalized term, with term spelling as a tie-breaker. Definitions and bodies use returned resource_body references. Continuation is bound to the operation, tenant, workspace/project, trimmed query, view, order, and server process. Pages are live reads: earlier keys are not revisited and later matches use current data. Invalid continuation or oversized summaries return an error with no page.",
			inputSchema: {
				query: z.string().min(1).optional(),
				view: z.enum(["all", "global", "initiatives"]).optional(),
				continuation: z.string().min(1).max(2048).optional()
			}
		},
		async (input) => readContextPage("context_search", input)
	);

	server.registerTool(
		"context_conflicts",
		{
			description: "Find conflicting tracker context terms.",
			inputSchema: {
				query: z.string().min(1).optional(),
				view: z.enum(["all", "initiatives"]).optional()
			}
		},
		async ({ query, view }) => toolResult(await (await openStore()).queryContextDirectory({ conflictsOnly: true, query, view }))
	);

	server.registerTool(
		"context_term_define",
		{
			description: "Create or edit a tracker context term.",
			inputSchema: {
				scopeRef: z.string().min(1).optional(),
				term: z.string().min(1),
				definition: z.string().min(1),
				avoid: z.array(z.string().min(1)).optional(),
				expectedRevision: z.number().int().positive().optional(),
				expectedContentHash: z.string().min(1).optional()
			}
		},
		async (input) => toolResult(await (await openStore()).defineContextTerm(input))
	);

	async function readCommentList({ issueId, before, all }: Extract<ResourceListRequest, { resource: "comment" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const { entity } = await store.getEntityDetails(issueId);
			const requestHash = createHash("sha256").update(JSON.stringify({
				tool: "resource_list", resource: "comment", operation: "list", all: all ?? false, tenantId: store.tenantId, projectIdentity: scope.projectIdentity ?? null,
				workspaceRoot: scope.workspaceRoot ?? null, issueId: entity.id, order: "createdAt-reference-before"
			})).digest("hex");
			const cursor = readPageContinuation(before, requestHash, entityListSecret, "comment_list");
			return formatCommentListPage(await store.listIssueComments({ issueId: entity.id, before: cursor }), requestHash, entityListSecret);
		} catch (error) {
			return boundedReadError(error, "Comment list failed.", "Comment list failed. No page was returned. Check the issue and restart without before.");
		}
	}

	async function readCommentHistory({ commentId, continuation }: Extract<ResourceHistoryRequest, { resource: "comment" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const history = await store.listIssueCommentHistory({ commentId });
			const requestHash = createHash("sha256").update(JSON.stringify({
				tool: "resource_history", resource: "comment", action: "list", tenantId: store.tenantId, projectIdentity: scope.projectIdentity ?? null,
				workspaceRoot: scope.workspaceRoot ?? null, commentId: history[0]?.commentId ?? commentId, order: "revision-asc"
			})).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret, "resource_history");
			return formatCommentHistoryPage(history, after, requestHash, entityListSecret);
		} catch (error) {
			return boundedReadError(error, "Comment history failed.", "Comment history failed. No page was returned. Check the comment and restart without continuation.");
		}
	}

	async function readPlanEntryList({ planId, continuation }: Extract<ResourceListRequest, { resource: "planEntry" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const plan = await store.getEntityDetails(planId);
			const requestHash = createHash("sha256").update(JSON.stringify({ tool: "resource_list", resource: "planEntry", operation: "list", scope, tenantId: store.tenantId, planId: plan.entity.id, order: "id-asc" })).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret, "plan_entry_list");
			const entries = (await store.listPlanEntries({ planId: plan.entity.id })).map(({ body: _body, ...entry }) => ({
				...entry, reads: {
					body: { tool: "resource_body", arguments: { request: { resource: "planEntry", entryId: entry.reference, revision: entry.revision } } },
					details: planEntryDetailRead(entry.reference, entry.revision)
				}
			}));
			return formatSummaryListPage(entries, "entries", after, requestHash, entityListSecret,
				(entry) => `Plan-entry summary exceeds the 65536-byte response budget. No page was returned. Use resource_show with resource planEntry, view details, entryId ${entry.reference}, and revision ${entry.revision}, or agent-issues plan-entry list ${plan.entity.reference} --json.`);
		} catch (error) {
			return boundedReadError(error, "Plan-entry list failed.", "Plan-entry list failed. No page was returned. Check the Plan and restart without continuation.");
		}
	}

	async function readPlanEntryHistory({ entryId, continuation }: Extract<ResourceHistoryRequest, { resource: "planEntry" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const entry = await store.getPlanEntry({ entryId });
			const requestHash = createHash("sha256").update(JSON.stringify({ tool: "resource_history", resource: "planEntry", action: "list", scope, tenantId: store.tenantId, entryId: entry.id, order: "revision-asc" })).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret, "resource_history");
			const history = (await store.listPlanEntryHistory({ entryId: entry.id })).map(({ body: _body, ...revision }) => ({
				...revision, reads: {
					body: { tool: "resource_body", arguments: { request: { resource: "planEntry", entryId: entry.reference, revision: revision.targetRevision } } },
					details: planEntryDetailRead(entry.reference, revision.targetRevision)
				}
			}));
			return formatRevisionHistoryPage(history, after, requestHash, entityListSecret,
				`Plan-entry revision metadata exceeds the 65536-byte response budget. No page was returned. Use resource_show with resource planEntry, view details, and entryId ${entry.reference}, or agent-issues plan-entry history ${entry.reference} --json.`);
		} catch (error) {
			return boundedReadError(error, "Plan-entry history failed.", "Plan-entry history failed. No page was returned. Check the entry and restart without continuation.");
		}
	}

	server.registerTool(
		"plan_entry_entity_link",
		{
			description: "Link a Plan entry to an entity.",
			inputSchema: { entryId: z.string().min(1), targetId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).linkPlanEntryEntity(input))
	);

	server.registerTool(
		"plan_entry_entity_unlink",
		{
			description: "Remove a Plan entry entity link.",
			inputSchema: { entryId: z.string().min(1), targetId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).unlinkPlanEntryEntity(input))
	);

	async function readTenantList({ continuation }: Extract<ResourceListRequest, { resource: "tenant" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const requestHash = createHash("sha256").update(JSON.stringify({
				tool: "resource_list", resource: "tenant", operation: "list", tenantId: store.tenantId, projectIdentity: scope.projectIdentity ?? null,
				workspaceRoot: scope.workspaceRoot ?? null, order: "id-asc"
			})).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret, "tenant_list");
			return formatSummaryListPage(await store.listTenants(), "tenants", after, requestHash, entityListSecret,
				"Tenant summary exceeds the 65536-byte response budget. No page was returned. Use agent-issues tenant list --json for complete details.");
		} catch (error) {
			return boundedReadError(error, "Tenant list failed.", "Tenant list failed. Error details exceed the response budget. No page was returned. Check authorization and restart without continuation.");
		}
	}

	server.registerTool(
		"tenant_rename",
		{
			description: "Rename a tracker tenant.",
			inputSchema: { previousTenantId: z.string().min(1), newTenantId: z.string().min(1) }
		},
		async ({ previousTenantId, newTenantId }) => {
			const result = await (await openStore()).renameTenant(previousTenantId, newTenantId);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_restore_inspect",
		{
			description: "Inspect an entity revision restore and get a confirmation token.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive() }
		},
		async ({ entityId, revision }) => {
			const impact = await (await openStore()).materializeEntityRevision({ entityId, revision });
			const confirmation = confirmationTokens.issue("entity_restore", { entityId, revision });
			const result = { impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"entity_restore",
		{
			description: "Restore an entity revision after inspection confirmation.",
			inputSchema: { entityId: z.string().min(1), revision: z.number().int().positive(), confirmationToken: z.string().uuid() }
		},
		async ({ entityId, revision, confirmationToken }) => {
			confirmationTokens.consume(confirmationToken, "entity_restore", { entityId, revision });
			const store = await openStore();
			const target = await store.materializeEntityRevision({ entityId, revision });
			const head = await store.materializeEntityRevision({ entityId, revision: target.headRevision });
			const result = await store.restoreEntityRevision({
				entityId,
				revision,
				expectedRevision: head.headRevision,
				expectedContentHash: computeEntityContentHash(head.title, head.body)
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"body_backfill_inspect",
		{
			description: "Inspect body backfill impact and get a confirmation token.",
			inputSchema: { kinds: z.array(z.enum(BACKFILLABLE_BODY_KINDS)).optional(), force: z.boolean().optional() }
		},
		async ({ kinds, force }) => {
			const input = { kinds: kinds ?? [...BACKFILLABLE_BODY_KINDS], force: force ?? false };
			const impact = await backfillBodies(await openStore(), { ...input, dryRun: true });
			const confirmation = confirmationTokens.issue("body_backfill", input);
			const result = { impact, confirmationToken: confirmation.token, expiresAt: confirmation.expiresAt };
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"body_backfill",
		{
			description: "Backfill tracker bodies after inspection confirmation.",
			inputSchema: {
				kinds: z.array(z.enum(BACKFILLABLE_BODY_KINDS)).optional(),
				force: z.boolean().optional(),
				confirmationToken: z.string().uuid()
			}
		},
		async ({ kinds, force, confirmationToken }) => {
			const input = { kinds: kinds ?? [...BACKFILLABLE_BODY_KINDS], force: force ?? false };
			confirmationTokens.consume(confirmationToken, "body_backfill", input);
			const result = await backfillBodies(await openStore(), input);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result
			};
		}
	);

	server.registerTool(
		"relation_link",
		{
			description: "Link two tracker entities with a relation.",
			inputSchema: { fromId: z.string().min(1), relationType: z.string().min(1), toId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).linkEntities(input))
	);

	server.registerTool(
		"relation_unlink",
		{
			description: "Remove a relation between two tracker entities.",
			inputSchema: { fromId: z.string().min(1), relationType: z.string().min(1), toId: z.string().min(1) }
		},
		async (input) => toolResult(await (await openStore()).unlinkEntities(input))
	);

	server.registerTool(
		"relation_query",
		{
			description: "Read relation and linked Plan provenance summaries within 65536 serialized UTF-8 JSON bytes. Keys sort by JSON tuples of section, relation type, and immutable item ID. Plan provenance is independent of entity-relation filters. Copy nextContinuation into continuation with the same request until null; join all sections across pages. Continuation is bound to the entity, tenant, workspace/project, direction, type filters, and server process. Pages are live reads, not a snapshot: later keys use current metadata; removed links disappear; keys at or before the cursor are not revisited. Invalid continuation or oversized metadata returns a bounded error with no page. Bodies use separate detail reads.",
			inputSchema: {
				entityId: z.string().min(1),
				direction: z.enum(["incoming", "outgoing", "both"]).optional(),
				types: boundedRelationTypesSchema.optional(),
				continuation: z.string().min(1).max(2048).optional()
			}
		},
		async ({ entityId, direction, types, continuation }) => {
			try {
				const scope = await resolveScope();
				const store = await options.openStore(scope);
				const result = await store.queryEntityRelations({ entityId, direction, types: types as RelationType[] | undefined });
				const requestHash = createHash("sha256").update(JSON.stringify({
					operation: "relation_query", scope, tenantId: store.tenantId, entityId: result.entity.id,
					direction: direction ?? "both", types: types === undefined ? null : [...new Set(types)].sort(), order: "section-type-id-asc"
				})).digest("hex");
				const after = readPageContinuation(continuation, requestHash, entityListSecret, "relation_query");
				return formatRelationPage(result, after, requestHash, entityListSecret);
			} catch (error) {
				return boundedReadError(error, "Relation page read failed.", "Relation page read failed. Use resource_show with resource entity for related entity details.");
			}
		}
	);

	server.registerTool(
		"initiative_bundle",
		{
			description: "Explicitly read initiative summary sections within 65536 UTF-8 JSON bytes. Copy nextContinuation into continuation with the same initiative until null and join every section across pages. Keys sort by section and immutable IDs. Bodies use resource_body. Continuation is bound to the initiative, tenant, workspace/project, operation, order, and server process. Pages read current data, not a snapshot: earlier keys are not revisited and later keys use current records. Invalid continuation or oversized metadata returns an error with a complete CLI detail reference.",
			inputSchema: { initiativeId: z.string().min(1), continuation: z.string().min(1).max(2048).optional() }
		},
		async ({ initiativeId, continuation }) => {
			try {
				const scope = await resolveScope();
				const store = await options.openStore(scope);
				const bundle = await store.getInitiativeBundle(initiativeId);
				const requestHash = createHash("sha256").update(JSON.stringify({
					operation: "initiative_bundle", scope, tenantId: store.tenantId, initiativeId: bundle.initiative.id, order: "section-id-asc"
				})).digest("hex");
				const after = readPageContinuation(continuation, requestHash, entityListSecret, "initiative_bundle");
				const collections = {
					entities: bundle.entities.map(combinedEntitySummary), prds: bundle.prds.map(combinedEntitySummary),
					userStories: bundle.userStories.map(combinedEntitySummary), adrs: bundle.adrs.map(combinedEntitySummary),
					issues: bundle.issues.map(combinedEntitySummary),
					fixLinks: bundle.fixLinks.map(({ issue, userStory }) => ({ issue: combinedEntitySummary(issue), userStory: combinedEntitySummary(userStory) })),
					subIssueLinks: bundle.subIssueLinks.map(({ parent, issue }) => ({ parent: combinedEntitySummary(parent), issue: combinedEntitySummary(issue) })),
					blockerLinks: bundle.blockerLinks.map(({ source, target }) => ({ source: combinedEntitySummary(source), target: combinedEntitySummary(target) })),
					constrainsLinks: bundle.constrainsLinks.map(({ adr, issue }) => ({ adr: combinedEntitySummary(adr), issue: combinedEntitySummary(issue) })),
					versionCoverage: bundle.versionCoverage
				};
				return formatCombinedPage(bundle.initiative, collections, after, requestHash, entityListSecret, `agent-issues show ${bundle.initiative.reference} --json`);
			} catch (error) {
				return boundedReadError(error, "Initiative bundle failed.", "Initiative bundle failed. No page was returned. Use agent-issues show <initiative> --json for complete details.");
			}
		}
	);

	server.registerTool(
		"entity_next_work",
		{
			description: "Read next-in-line available issue candidates within 65536 UTF-8 JSON bytes. Resolves the scope to its initiative. Returns up to five candidates by default; limit accepts one to 20. Candidates sort by descending unfinishedUnblockCount, then ascending immutable issue ID. counts gives total available and blocked issues; hasMore indicates available issues outside the returned list. The skill selects the recommendation and reads finalist outcomes through resource_body only when needed. Do not fetch every available issue. No recommendation, blocked collection, dependency links, or continuation is returned. Availability and parent-child blocker rules are unchanged. Read again after work-state changes. Oversized responses return a bounded error with a complete CLI detail reference.",
			inputSchema: { scopeId: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }
		},
		async ({ scopeId, limit }) => {
			try {
				const scope = await resolveScope();
				const store = await options.openStore(scope);
				const initiative = await resolveContainingInitiative(store, scopeId);
				const [bundle, allIssues] = await Promise.all([store.getInitiativeBundle(initiative.id), store.queryEntities({ kind: "issue" })]);
				const work = deriveNextWork(bundle, allIssues.openBlockers ?? {});
				const candidates = work.available.slice().sort((first, second) => second.unblocks.length - first.unblocks.length
					|| (first.issue.id < second.issue.id ? -1 : first.issue.id > second.issue.id ? 1 : 0)).slice(0, limit);
				const response = toolResult({
					initiative: combinedEntitySummary(bundle.initiative),
					available: candidates.map((item) => ({ issue: combinedEntitySummary(item.issue), unfinishedUnblockCount: item.unblocks.length })),
					counts: { available: work.available.length, blocked: work.blocked.length },
					hasMore: work.available.length > candidates.length
				});
				if (Buffer.byteLength(JSON.stringify(response), "utf8") > 65536) {
					throw new Error(`Next-work candidates exceed the response budget. No candidates were returned. Use agent-issues next-work ${initiative.reference} --json for complete details.`);
				}
				return response;
			} catch (error) {
				return boundedReadError(error, "Next-work read failed.", "Next-work read failed. No candidates were returned. Use agent-issues next-work <initiative> --json for complete details.");
			}
		}
	);

	async function readOrphanList({ kind, continuation }: Extract<ResourceListRequest, { resource: "orphanEntity" }>) {
		try {
			const scope = await resolveScope();
			const store = await options.openStore(scope);
			const requestHash = createHash("sha256").update(JSON.stringify({
				tool: "resource_list", resource: "orphanEntity", operation: "list", tenantId: store.tenantId, projectIdentity: scope.projectIdentity ?? null,
				workspaceRoot: scope.workspaceRoot ?? null, kind: kind ?? null, order: "id-asc"
			})).digest("hex");
			const after = readPageContinuation(continuation, requestHash, entityListSecret, "entity_orphans");
			const summaries = (await store.listOrphans(kind)).map(({ body: _body, bodySource: _bodySource, ...summary }) => summary);
			return formatEntityListPage(summaries, after, requestHash, entityListSecret);
		} catch (error) {
			return boundedReadError(error, "Orphan list failed.", "Orphan list failed. Error details exceed the response budget. No page was returned. Check authorization and restart without continuation.");
		}
	}

	return server;
}

function combinedEntitySummary(entity: EntityRecord) {
	return { ...toEntitySummary(entity), reads: {
		body: { tool: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference } } },
		details: { command: "agent-issues", arguments: ["show", entity.reference, "--json"] }
	} };
}

function combinedItemKey(section: string, value: unknown): string {
	const record = value as Record<string, unknown>;
	if (typeof record.id === "string") return JSON.stringify([section, record.id]);
	if (section === "versionCoverage") return JSON.stringify([section, record.calculatedVersionState, record.calculatedVersion]);
	if (section === "available" || section === "blocked") return JSON.stringify([section, (record.issue as EntitySummary).id]);
	return JSON.stringify([section, ...Object.keys(record).sort().map((field) => {
		const endpoint = record[field];
		return typeof endpoint === "string" ? endpoint : (endpoint as EntitySummary).id;
	})]);
}

function formatCombinedPage(initiative: EntityRecord, collections: Record<string, unknown[]>, after: string | undefined, requestHash: string, secret: Buffer, details: string, metadata: Record<string, unknown> = {}) {
	const remaining = Object.entries(collections).flatMap(([section, values]) => values.map((value) => ({
		section, value, key: combinedItemKey(section, value)
	}))).filter((item) => after === undefined || item.key > after)
		.sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0);
	const responseAt = (count: number) => {
		let nextContinuation: string | null = null;
		if (count > 0 && count < remaining.length) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: remaining[count - 1].key })).toString("base64url");
			nextContinuation = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		const page = remaining.slice(0, count);
		return toolResult({ initiative: combinedEntitySummary(initiative), ...metadata, ...Object.fromEntries(Object.keys(collections).map((section) => [section,
			page.filter((item) => item.section === section).map((item) => item.value)])), nextContinuation });
	};
	if (Buffer.byteLength(JSON.stringify(responseAt(0)), "utf8") > 65536) throw new Error(`Initiative metadata exceeds the response budget. No page was returned. Use ${details}.`);
	return boundedCollectionPage(responseAt, remaining.length, `Combined summary exceeds the response budget. No page was returned. Use ${details}.`);
}

function readPageContinuation(continuation: string | undefined, requestHash: string, secret: Buffer, operation = "entity_list"): string | undefined {
	if (continuation === undefined) return undefined;
	try {
		const [payload, signature, extra] = continuation.split(".");
		if (!payload || !signature || extra !== undefined) throw new Error();
		const expected = createHmac("sha256", secret).update(payload).digest("base64url");
		if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
		const cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { requestHash?: unknown; after?: unknown };
		if (cursor.requestHash !== requestHash || typeof cursor.after !== "string") throw new Error();
		return cursor.after;
	} catch {
		throw new Error(`Invalid ${operation} continuation or changed request. Restart without continuation.`);
	}
}

function planEntryDetailRead(entryId: string, revision: number) {
	return { tool: "resource_show", arguments: { request: { resource: "planEntry", view: "details", entryId, revision } } };
}

function formatRelationPage(result: Awaited<ReturnType<StorageDriver["queryEntityRelations"]>>, after: string | undefined, requestHash: string, secret: Buffer) {
	const relations = (["incoming", "outgoing"] as const).flatMap((direction) => result[direction].map((edge) => ({
		direction, edge, key: JSON.stringify([direction, edge.relationType, edge.entity.id]), details: `resource_show with resource entity and reference ${edge.entity.reference}`
	})));
	const planEntries = result.planEntries.map((entry) => {
		const { body: _body, ...summary } = entry;
		return {
			direction: "planEntries" as const, key: JSON.stringify(["planEntries", "informs", entry.id]),
			edge: { ...summary, reads: {
				body: { tool: "resource_body", arguments: { request: { resource: "planEntry", entryId: entry.reference, revision: entry.revision } } },
				details: planEntryDetailRead(entry.reference, entry.revision)
			} },
			details: `resource_show with resource planEntry, view details, entryId ${entry.reference}, and revision ${entry.revision}`
		};
	});
	const remaining = [...relations, ...planEntries].filter((item) => after === undefined || item.key > after)
		.sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0);
	const entity = { id: result.entity.id, reference: result.entity.reference, kind: result.entity.kind, revision: result.entity.revision };
	const responseAt = (count: number) => {
		let nextContinuation: string | null = null;
		if (count > 0 && count < remaining.length) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: remaining[count - 1].key })).toString("base64url");
			nextContinuation = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		const page = remaining.slice(0, count);
		return toolResult({ entity,
			incoming: page.filter((item) => item.direction === "incoming").map((item) => item.edge),
			outgoing: page.filter((item) => item.direction === "outgoing").map((item) => item.edge),
			planEntries: page.filter((item) => item.direction === "planEntries").map((item) => item.edge),
			nextContinuation
		});
	};
	let response = responseAt(0);
	if (Buffer.byteLength(JSON.stringify(response), "utf8") > 65536) throw new Error("Relation identity exceeds the 65536-byte response budget. No page was returned.");
	for (let count = 1; count <= remaining.length; count++) {
		const candidate = responseAt(count);
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 65536) {
			if (count === 1) throw new Error(`Relation summary exceeds the 65536-byte response budget. No page was returned. Use ${remaining[0].details}.`);
			break;
		}
		response = candidate;
	}
	return response;
}

function formatEntityListPage(entities: EntitySummary[], after: string | undefined, requestHash: string, secret: Buffer, limit?: number) {
	const summaries = entities.map((entity) => ({
		...entity,
		reads: {
			body: { tool: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference } } },
			details: { command: "agent-issues", arguments: ["show", entity.reference, "--json"] }
		}
	}));
	return formatSummaryListPage(summaries, "entities", after, requestHash, secret,
		(summary) => `Entity summary exceeds the 65536-byte response budget. No page was returned. Use agent-issues show ${summary.reference} --json for complete details.`, limit);
}

function formatSummaryListPage<Summary extends { id: string }>(summaries: Summary[], collection: "tenants" | "entities" | "entries", after: string | undefined, requestHash: string, secret: Buffer, oversizedMessage: string | ((summary: Summary) => string), limit?: number) {
	const remaining = summaries.filter((summary) => after === undefined || summary.id > after)
		.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
	const responseAt = (count: number) => {
		let nextContinuation: string | null = null;
		if (count > 0 && count < remaining.length) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: remaining[count - 1].id })).toString("base64url");
			nextContinuation = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		return toolResult({ [collection]: remaining.slice(0, count), nextContinuation });
	};
	let response = responseAt(0);
	const itemLimit = Math.min(limit ?? remaining.length, remaining.length);
	for (let count = 1; count <= itemLimit; count++) {
		const candidate = responseAt(count);
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 65536) {
			if (count === 1) throw new Error(typeof oversizedMessage === "string" ? oversizedMessage : oversizedMessage(remaining[0]));
			break;
		}
		response = candidate;
	}
	return response;
}

function contextPageSummary(item: { context: ContextDetails["context"]; termCount: number }) {
	const scopeRef = item.context.scopeEntityId ?? undefined;
	return {
		context: toContextSummary(item.context), termCount: item.termCount,
		reads: {
			body: { tool: "resource_body", arguments: { request: { resource: "context", scopeRef, revision: item.context.revision || undefined } } },
			details: { command: "agent-issues", arguments: ["context", "show", ...(scopeRef ? [scopeRef] : []), "--json"] }
		}
	};
}

function formatContextDirectoryPage(directory: ContextDirectory | QueryContextDirectoryResult, after: string | undefined, requestHash: string, secret: Buffer) {
	const details = [...(directory.shared ? [directory.shared] : []), ...directory.initiatives];
	const contextsByKey = new Map(details.map((item) => [item.context.key, item]));
	const contextItems = details.map((item) => ({
		key: JSON.stringify([item === directory.shared ? "shared" : "initiatives", item.context.key]),
		section: item === directory.shared ? "shared" : "initiatives",
		value: contextPageSummary({ context: item.context, termCount: item.terms.length })
	}));
	const termItems = directory.terms.map(({ sources, ...term }) => ({
		key: JSON.stringify(["terms", term.term.toLowerCase(), term.term]),
		section: "terms",
		value: {
			...term,
			sources: sources.map(({ definition: _definition, ...source }) => {
				const selected = contextsByKey.get(source.contextKey)?.terms.find((item) => item.term.toLowerCase() === term.term.toLowerCase());
				return {
					...source,
					reads: { body: { tool: "resource_body", arguments: { request: { resource: "contextTerm", scopeRef: source.scopeEntityId ?? undefined, term: selected?.term ?? term.term, revision: selected?.revision } } } }
				};
			})
		}
	}));
	return formatKeyedCollectionPage<{ key: string; section: string; value: unknown }>([...contextItems, ...termItems], after, requestHash, secret, (items) => ({
		...("query" in directory ? { query: directory.query, view: directory.view, conflictsOnly: directory.conflictsOnly } : {}),
		shared: items.find((item) => item.section === "shared")?.value ?? null,
		initiatives: items.filter((item) => item.section === "initiatives").map((item) => item.value),
		terms: items.filter((item) => item.section === "terms").map((item) => item.value),
		duplicateTerms: items.filter((item) => item.section === "terms").map((item) => item.value as { term: string; hasDuplicates: boolean }).filter((item) => item.hasDuplicates).map((item) => item.term)
	}), "agent-issues context list --json, then agent-issues context show <scope> --json");
}

function formatKeyedCollectionPage<Item extends { key: string }>(items: Item[], after: string | undefined, requestHash: string, secret: Buffer, format: (items: Item[]) => Record<string, unknown>, details: string, label = "Context") {
	const remaining = items.filter((item) => after === undefined || item.key > after)
		.sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0);
	const responseAt = (count: number) => {
		let nextContinuation: string | null = null;
		if (count > 0 && count < remaining.length) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: remaining[count - 1].key })).toString("base64url");
			nextContinuation = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		return toolResult({ ...format(remaining.slice(0, count)), nextContinuation });
	};
	if (Buffer.byteLength(JSON.stringify(responseAt(0)), "utf8") > 65536) throw new Error(`${label} request metadata exceeds the 65536-byte response budget. No page was returned. Use ${details}.`);
	return boundedCollectionPage(responseAt, remaining.length, `${label} summary exceeds the 65536-byte response budget. No page was returned. Use ${details} for complete details.`);
}

function formatCommentListPage(page: Awaited<ReturnType<StorageDriver["listIssueComments"]>>, requestHash: string, secret: Buffer) {
	const summaries = page.comments.map(({ body: _body, ...comment }) => ({
		...comment, reads: { body: { tool: "resource_body", arguments: { request: { resource: "comment", commentId: comment.reference, revision: comment.revision } } } }
	}));
	const responseAt = (count: number) => {
		const comments = summaries.slice(summaries.length - count);
		const userIds = new Set(comments.flatMap((comment) => [comment.createdBy, comment.updatedBy]));
		const oldest = comments[0];
		const cursor = count < summaries.length && oldest
			? Buffer.from(JSON.stringify({ createdAt: oldest.createdAt, reference: oldest.reference })).toString("base64url")
			: page.nextBefore;
		let nextBefore: string | null = null;
		if (cursor) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: cursor })).toString("base64url");
			nextBefore = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		return toolResult({ comments, users: page.users.filter((user) => userIds.has(user.id)), total: page.total, nextBefore });
	};
	return boundedCollectionPage(responseAt, summaries.length, "Comment summary exceeds the 65536-byte response budget. No page was returned. Use agent-issues comment list <issue> --all --json for complete metadata.");
}

function formatCommentHistoryPage(history: Awaited<ReturnType<StorageDriver["listIssueCommentHistory"]>>, after: string | undefined, requestHash: string, secret: Buffer) {
	const summaries = history.map(({ body: _body, ...entry }) => ({
			...entry, reads: { body: { tool: "resource_body", arguments: { request: { resource: "comment", commentId: entry.commentId, revision: entry.targetRevision } } } }
		}));
	return formatRevisionHistoryPage(summaries, after, requestHash, secret, "Comment revision metadata exceeds the 65536-byte response budget. No page was returned. Use agent-issues comment history <comment> --json for complete metadata.");
}

function formatRevisionHistoryPage<Summary extends { targetRevision: number }>(summaries: Summary[], after: string | undefined, requestHash: string, secret: Buffer, oversizedMessage: string) {
	const remaining = summaries.filter((entry) => after === undefined || entry.targetRevision > Number(after))
		.sort((first, second) => first.targetRevision - second.targetRevision);
	const responseAt = (count: number) => {
		let nextContinuation: string | null = null;
		if (count > 0 && count < remaining.length) {
			const payload = Buffer.from(JSON.stringify({ requestHash, after: String(remaining[count - 1].targetRevision) })).toString("base64url");
			nextContinuation = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
		}
		return toolResult({ history: remaining.slice(0, count), nextContinuation });
	};
	return boundedCollectionPage(responseAt, remaining.length, oversizedMessage);
}

function boundedCollectionPage(responseAt: (count: number) => ReturnType<typeof toolResult>, itemCount: number, oversizedMessage: string) {
	let response = responseAt(0);
	for (let count = 1; count <= itemCount; count++) {
		const candidate = responseAt(count);
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 65536) {
			if (count === 1) throw new Error(oversizedMessage);
			break;
		}
		response = candidate;
	}
	return response;
}

function boundedReadError(error: unknown, message: string, oversizedMessage: string) {
	const result = { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : message }] };
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536) result.content[0].text = oversizedMessage;
	return result;
}

function toolResult(result: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		structuredContent: result as Record<string, unknown>
	};
}

function textToolResult(text: string, structuredContent: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
	return { content: [{ type: "text", text }], structuredContent };
}

function formatPlanPreview(plan: {
	title: string;
	goal: string;
	context: string;
	snapshotDigest: string;
	revision?: number;
	current: Array<{ title: string; entries: Array<{ body?: string }> }>;
}): string {
	const sections = [
		`# ${plan.title}`,
		plan.revision === undefined ? "" : `Revision ${plan.revision}`,
		`Snapshot digest: ${plan.snapshotDigest}`,
		`## Goal\n\n${plan.goal || "No Goal recorded."}`,
		`## Context\n\n${plan.context || "No Context recorded."}`,
		...plan.current.map((group) => `## ${group.title}\n\n${group.entries.map((entry) => entry.body || "").join("\n\n")}`)
	];
	return sections.filter((section) => section.length > 0).join("\n\n");
}

function formatIssueBreakdownPreview(draft: {
	targetReference: string;
	snapshotDigest: string;
	issues: Array<{
		title: string;
		outcome: string;
		scope: string[];
		workMode: string;
		acceptanceCriteria: string[];
		parentKey?: string;
		planEntryIds?: string[];
		relationReferences: Array<{ relationType: string; targetKey?: string; targetReference?: string }>;
	}>;
}): string {
	const issues = draft.issues.map((issue, index) => [
		`## ${index + 1}. ${issue.title}`,
		`Outcome: ${issue.outcome}`,
		`Scope:\n${issue.scope.map((item) => `- ${item}`).join("\n") || "- None"}`,
		`Work mode: ${issue.workMode}`,
		`Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- None"}`,
		`Parent: ${issue.parentKey ?? "None"}`,
		`Plan entries:\n${issue.planEntryIds?.map((entryId) => `- ${entryId}`).join("\n") || "- None"}`,
		`Relations:\n${issue.relationReferences.map((relation) => `- ${relation.relationType}: ${relation.targetKey ?? relation.targetReference ?? "None"}`).join("\n") || "- None"}`
	].join("\n\n"));
	return [`# Issue breakdown for ${draft.targetReference}`, `Snapshot digest: ${draft.snapshotDigest}`, ...issues].join("\n\n");
}

type NextWorkItem = {
	issue: EntityRecord;
	blockers: string[];
	unblocks: string[];
};

function deriveNextWork(
	bundle: { initiative: EntityRecord; issues: EntityRecord[]; subIssueLinks: Array<{ parent: EntityRecord; issue: EntityRecord }> },
	openBlockers: Record<string, string[]>
): { initiative: EntityRecord; available: NextWorkItem[]; blocked: NextWorkItem[] } {
	const unfinishedIssues = bundle.issues.filter((issue) => issue.status !== "done" && issue.status !== "deferred");
	const blockersByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set(openBlockers[issue.reference] ?? [])]));
	for (const { parent, issue } of bundle.subIssueLinks) {
		if (parent.status !== "done" && parent.status !== "deferred" && issue.status !== "done" && issue.status !== "deferred") {
			blockersByReference.get(parent.reference)?.add(issue.reference);
		}
	}

	const unblocksByReference = new Map(unfinishedIssues.map((issue) => [issue.reference, new Set<string>()]));
	for (const issue of unfinishedIssues) {
		for (const blocker of blockersByReference.get(issue.reference) ?? []) {
			unblocksByReference.get(blocker)?.add(issue.reference);
		}
	}

	const items = unfinishedIssues.map((issue) => ({
		issue,
		blockers: Array.from(blockersByReference.get(issue.reference) ?? []).sort(),
		unblocks: Array.from(unblocksByReference.get(issue.reference) ?? []).sort()
	}));
	return {
		initiative: bundle.initiative,
		available: items.filter((item) => item.blockers.length === 0),
		blocked: items.filter((item) => item.blockers.length > 0)
	};
}

async function resolveContainingInitiative(
	store: Pick<StorageDriver, "queryEntityRelations">,
	scopeId: string
): Promise<EntitySummary> {
	const structuralRelationTypes: RelationType[] = ["contains", "owns", "records", "tracks", "creates", "decomposes"];
	let details = await store.queryEntityRelations({ entityId: scopeId, direction: "incoming" as RelationDirection, types: structuralRelationTypes });
	const visited = new Set<string>();
	while (details.entity.kind !== "initiative") {
		if (visited.has(details.entity.id)) {
			throw new Error(`Structural parent cycle found while resolving initiative: ${scopeId}`);
		}
		visited.add(details.entity.id);
		const parent = details.incoming[0]?.entity;
		if (!parent) {
			throw new Error(`No initiative contains: ${scopeId}`);
		}
		details = await store.queryEntityRelations({ entityId: parent.id, direction: "incoming" as RelationDirection, types: structuralRelationTypes });
	}
	return details.entity;
}

async function resolveEntityIds(
	store: Pick<StorageDriver, "getEntityDetails">,
	references: string[]
): Promise<string[]> {
	return await Promise.all(references.map(async (reference) => (await store.getEntityDetails(reference)).entity.id));
}

async function resolvePlanEntryIds(
	store: Pick<StorageDriver, "getPlanEntry">,
	references: string[]
): Promise<string[]> {
	return await Promise.all(references.map(async (reference) => (await store.getPlanEntry({ entryId: reference })).id));
}


export function createLocalMcpServer(options: LocalDaemonStoreOptions): McpServer {
	return createMcpServer({
		fallbackWorkspaceRoot: options.workspaceRoot,
		projectIdentity: options.projectIdentity,
		openStore: (scope) => openLocalDaemonStore({
			...options,
			buildHash: options.buildHash ?? readBuildContentHash(),
			projectIdentity: scope?.projectIdentity ?? options.projectIdentity,
			workspaceRoot: scope?.workspaceRoot ?? options.workspaceRoot
		})
	});
}

export { runMcpStdioServer } from "./stdio.js";