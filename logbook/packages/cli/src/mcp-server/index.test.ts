import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalDaemonServer, openSqliteStore, type LocalDaemonServerHandle } from "@agent-issues/api-local";
import { createApiServer, createPgPool, installInstructionBundle, migratePgDatabase } from "@agent-issues/api-pg";
import { LocalAuthProvider, projectProposedPlan, resolveWellKnownLocalTenantId, type RunCredentialCommand } from "@agent-issues/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { auditMcpToolRegistrations } from "./mcp-tool-audit.js";
import { createLocalMcpServer, createMcpServer } from "./index.js";
import { runCli } from "../cli/index.js";
import { saveSavedLogin } from "../auth/auth-session.js";
import { openStorageDriver } from "../runtime/open-storage-driver.js";
import { startLiveSite } from "../site/server.js";
import packageJson from "../../package.json" with { type: "json" };

function fakeCredentialStore(): { platform: "darwin"; runCommand: RunCredentialCommand } {
	const store = new Map<string, string>();
	return {
		platform: "darwin",
		runCommand: async (command) => {
			const [action, , account, , service] = command.args;
			const key = `${service}:${account}`;
			if (action === "add-generic-password") {
				store.set(key, command.args[6]);
				return { stdout: "", exitCode: 0 };
			}
			if (action === "find-generic-password") {
				const value = store.get(key);
				return value === undefined ? { stdout: "", exitCode: 44 } : { stdout: `${value}\n`, exitCode: 0 };
			}
			const existed = store.delete(key);
			return { stdout: "", exitCode: existed ? 0 : 44 };
		}
	};
}

function planDetailArguments(tool: string, input: Record<string, unknown>) {
	if (tool === "resource_show") return { request: { resource: "planEntry", view: "details", ...input } };
	return tool === "resource_body" ? { request: { resource: "planEntry", ...input } } : input;
}

function collectionCall(resource: string, input: Record<string, unknown>) {
	if (resource === "planEntryHistory") return historyCall("planEntry", "list", input);
	if (resource === "contextDirectory") return { name: "resource_list", arguments: { request: { resource: "context", view: "directory", ...input } } };
	if (["entity", "orphanEntity", "planEntry", "context", "comment", "instructionSource", "tenant"].includes(resource)) {
		return { name: "resource_list", arguments: { request: { resource, ...input } } };
	}
	return { name: resource, arguments: input };
}

function historyCall(resource: string, action: "list" | "revision", input: Record<string, unknown>) {
	return { name: "resource_history", arguments: { request: { resource, action, ...input } } };
}

async function readInstructionSource(client: Client, key: string) {
	const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "instructionSource", key } } });
	if (result.isError) return result;
	const { reads, ...source } = result.structuredContent as Record<string, unknown> & { reads: { body: { tool: string; arguments: { request: Record<string, unknown> } } } };
	let offset: number | null = null;
	let documentHash: string | undefined;
	let body = "";
	do {
		const part = await client.callTool({ name: reads.body.tool, arguments: { request: { ...reads.body.arguments.request, ...(offset === null ? {} : { offset, documentHash }) } } });
		if (part.isError) return part;
		const content = part.content as Array<{ type: "text"; text: string }>;
		const metadata = JSON.parse(content[0].text) as { nextOffset: number | null; documentHash: string };
		body += content[1].text;
		offset = metadata.nextOffset;
		documentHash = metadata.documentHash;
	} while (offset !== null);
	return { ...result, structuredContent: { ...source, body } };
}

async function readInstructionComparison(client: Client, key: string) {
	let offset: number | null = 0;
	let documentHash: string | undefined;
	let text = "";
	do {
		const result = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "compare", key, ...(offset ? { offset, documentHash } : {}) } } });
		if (result.isError) return result;
		const content = result.content as Array<{ text: string }>;
		const metadata = JSON.parse(content[0].text) as { nextOffset: number | null; documentHash: string };
		text += content[1].text;
		offset = metadata.nextOffset;
		documentHash = metadata.documentHash;
	} while (offset !== null);
	return { structuredContent: JSON.parse(text) as Record<string, unknown>, isError: false };
}

describe("agent-issues MCP server", () => {
	const directories: string[] = [];

	it("validates resource_history variants before opening storage", async () => {
		const openStore = vi.fn(async () => { throw new Error("Storage must not be opened."); });
		const server = createMcpServer({ openStore });
		const client = new Client({ name: "history-validation-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const tools = (await client.listTools()).tools;
			expect(tools.find((tool) => tool.name === "resource_history")?.annotations?.readOnlyHint).toBe(true);
			for (const request of [
				{ resource: "unknown", action: "list" }, { resource: "comment", action: "list" },
				{ resource: "planEntry", action: "list" }, { resource: "entity", action: "list", entityId: "entity" },
				{ resource: "context", action: "list" }, { resource: "contextTerm", action: "list", term: "term" },
				{ resource: "entity", action: "revision", entityId: "entity" },
				{ resource: "context", action: "revision", revision: 0 },
				{ resource: "contextTerm", action: "revision", revision: 1 },
				{ resource: "instructionSource", action: "revision", key: "skill/prepare", revision: 1.5 },
				{ resource: "comment", action: "revision", commentId: "comment", revision: 1 },
				{ resource: "planEntry", action: "list", entryId: "entry", revision: 1 },
				{ resource: "instructionSource", action: "list" },
				{ resource: "entity", action: "revision", entityId: "entity", revision: Number.MAX_SAFE_INTEGER + 1 }
			]) {
				expect((await client.callTool({ name: "resource_history", arguments: { request } })).isError).toBe(true);
			}
			for (const name of ["comment_history", "plan_entry_history", "entity_history", "context_revision", "context_term_revision"]) {
				expect(tools.map((tool) => tool.name)).not.toContain(name);
			}
			for (const action of ["history", "revision"]) {
				expect((await client.callTool({ name: "instruction_inspect", arguments: { request: { action, key: "skill/prepare", revision: 1 } } })).isError).toBe(true);
			}
			expect(openStore).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const directory of directories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("validates resource_list variants before opening storage", async () => {
		const openStore = vi.fn(async () => { throw new Error("Storage must not be opened."); });
		const server = createMcpServer({ openStore });
		const client = new Client({ name: "collection-validation-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const tools = (await client.listTools()).tools;
			expect(tools.find((tool) => tool.name === "resource_list")?.annotations?.readOnlyHint).toBe(true);
			for (const request of [
				{ resource: "unknown" }, { resource: "entity" }, { resource: "planEntry" },
				{ resource: "comment" }, { resource: "entity", view: "orphans", parentId: "parent" },
				{ resource: "context", view: "unknown" }, { resource: "instructionSource", action: "compare", key: "skill/prepare" },
				{ resource: "tenant", kind: "issue" }
			]) {
				expect((await client.callTool({ name: "resource_list", arguments: { request } })).isError).toBe(true);
			}
			expect(openStore).not.toHaveBeenCalled();
			for (const name of ["entity_list", "entity_orphans", "plan_entry_list", "context_list", "context_directory", "comment_list", "tenant_list"]) {
				expect(tools.map((tool) => tool.name)).not.toContain(name);
			}
			expect((await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "list" } } })).isError).toBe(true);
			expect(openStore).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("validates resource_show variants before opening storage", async () => {
		const openStore = vi.fn(async () => { throw new Error("Storage must not be opened."); });
		const server = createMcpServer({ openStore });
		const client = new Client({ name: "resource-validation-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const tools = (await client.listTools()).tools;
			expect(tools.find((tool) => tool.name === "resource_show")?.annotations?.readOnlyHint).toBe(true);
			for (const request of [
				{ resource: "entity" }, { resource: "planEntry" }, { resource: "contextTerm" },
				{ resource: "instructionSource" }, { resource: "issueBreakdown", action: "show" },
				{ resource: "issueBreakdown", action: "latest" }, { resource: "issueBreakdown", action: "approve", draftId: "draft" },
				{ resource: "comment", commentId: "comment" }, { resource: "context", reference: "entity" },
				{ resource: "entity", reference: "entity", revision: 1 },
				{ resource: "planEntry", entryId: "entry", revision: 1 },
				{ resource: "planEntry", view: "summary", entryId: "entry", offset: 0 },
				{ resource: "planEntry", view: "unknown", entryId: "entry" },
				{ resource: "planEntry", view: "details", entryId: "entry", revision: 0 },
				{ resource: "planEntry", view: "details", entryId: "entry", offset: -1 },
				{ resource: "planEntry", view: "details", entryId: "entry", offset: Number.MAX_SAFE_INTEGER + 1 },
				{ resource: "planEntry", view: "details", entryId: "entry", documentHash: "invalid" },
				{ resource: "entity", view: "details", reference: "entity" }
			]) {
				expect((await client.callTool({ name: "resource_show", arguments: { request } })).isError).toBe(true);
			}
			expect(openStore).not.toHaveBeenCalled();
			for (const name of ["entity_show", "context_show", "issue_breakdown_show", "issue_breakdown_latest", "plan_entry_read"]) {
				expect(tools.map((tool) => tool.name)).not.toContain(name);
			}
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("reads current Plan-entry metadata and follows its body reference", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entry-show-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "resources.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Entry scope" });
		const plan = await store.createEntity({ kind: "plan", title: "Entry Plan", parentId: initiative.id });
		const original = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Original decision" });
		const entry = await store.updatePlanEntry({ entryId: original.reference, body: "Current decision", expectedRevision: original.revision, expectedContentHash: original.contentHash });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "entry-show-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "planEntry", entryId: entry.reference } } });
			expect(result).toMatchObject({ structuredContent: { entry: { reference: entry.reference, revision: 2, role: "decision" }, reads: { body: { tool: "resource_body" }, details: { tool: "resource_show", arguments: { request: { resource: "planEntry", view: "details", entryId: entry.reference, revision: 2 } } } } } });
			expect(JSON.stringify(result)).not.toContain("Current decision");
			const metadata = result.structuredContent as { reads: { body: { tool: string; arguments: Record<string, unknown> }; details: { tool: string; arguments: Record<string, unknown> } } };
			const body = await client.callTool({ name: metadata.reads.body.tool, arguments: metadata.reads.body.arguments });
			expect(body.content).toEqual(expect.arrayContaining([{ type: "text", text: "Current decision" }]));
			const details = await client.callTool({ name: metadata.reads.details.tool, arguments: metadata.reads.details.arguments });
			expect(details.isError).not.toBe(true);
			expect(JSON.parse((details.content as Array<{ text: string }>)[1].text)).toMatchObject({ reference: entry.reference, revision: 2, role: "decision" });
			expect((await client.callTool({ name: "resource_show", arguments: { request: { resource: "planEntry", entryId: "PLAN_ENTRY_MISSING" } } })).isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads instruction-source metadata and unexpanded owner source through resource_show", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-source-show-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "resources.db"));
		const key = "skill/prepare";
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key, kind: "skill", body: "Default source" },
			{ key: "skill/unchanged", kind: "skill", body: "Unchanged source" },
			{ key: "fragment/rules", kind: "fragment", body: "Expanded rules" }
		] });
		const saved = await store.saveInstructionSource({ key, version: packageJson.version, body: "<!-- include:fragment/rules -->", expectedRevision: 1 });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "source-show-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "instructionSource", key } } });
			expect(result).toMatchObject({ structuredContent: { key, source: saved.source, reads: { body: { tool: "resource_body" } } } });
			expect(JSON.stringify(result)).not.toContain("<!-- include:");
			const metadata = result.structuredContent as { reads: { body: { tool: string; arguments: Record<string, unknown> } } };
			const body = await client.callTool({ name: metadata.reads.body.tool, arguments: metadata.reads.body.arguments });
			expect(body.content).toEqual(expect.arrayContaining([{ type: "text", text: saved.body }]));
			expect((await client.callTool({ name: "resource_show", arguments: { request: { resource: "instructionSource", key: "skill/missing" } } })).isError).toBe(true);
			expect((await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "read", key } } })).isError).toBe(true);
			expect(await client.callTool(historyCall("instructionSource", "list", { key: "skill/unchanged" }))).toMatchObject({ structuredContent: { key: "skill/unchanged", revisions: [] } });
			expect((await client.callTool(historyCall("instructionSource", "revision", { key, revision: 99 }))).isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("keeps resource_history reads within the selected tenant", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-history-owner-"));
		directories.push(directory);
		const dbPath = path.join(directory, "resources.db");
		const { store } = await openSqliteStore(dbPath, { tenant: "history-owner" });
		const { store: otherStore } = await openSqliteStore(dbPath, { tenant: "history-other" });
		const initiative = await store.createEntity({ kind: "initiative", title: "Private history" });
		const plan = await store.createEntity({ kind: "plan", title: "Private Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Private decision" });
		const issue = await store.createEntity({ kind: "issue", title: "Private issue", body: "Private body" });
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Private comment" });
		await store.upsertContext({ scopeRef: initiative.reference, title: "Private context", summary: "Private summary" });
		await store.defineContextTerm({ scopeRef: initiative.reference, term: "private", definition: "Private definition" });
		let activeStore = store;
		const server = createMcpServer({ openStore: async () => activeStore });
		const client = new Client({ name: "history-owner-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const request of [
				historyCall("entity", "revision", { entityId: issue.reference, revision: 1 }),
				historyCall("planEntry", "list", { entryId: entry.reference }),
				historyCall("comment", "list", { commentId: comment.reference }),
				historyCall("context", "revision", { scopeRef: initiative.reference, revision: 1 }),
				historyCall("contextTerm", "revision", { scopeRef: initiative.reference, term: "private", revision: 1 })
			]) {
				activeStore = store;
				expect((await client.callTool(request)).isError).not.toBe(true);
				activeStore = otherStore;
				const denied = await client.callTool(request);
				if (request.arguments.request.resource === "comment") {
					expect(denied).toMatchObject({ structuredContent: { history: [], nextContinuation: null } });
				} else expect(denied.isError).toBe(true);
				expect(JSON.stringify(denied)).not.toMatch(/Private (body|decision|comment|summary|definition)/);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
			await otherStore.close();
		}
	});

	it("locates issue-breakdown metadata by draft ID and latest target without changing approval", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-draft-show-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "resources.db"));
		const target = await store.createEntity({ kind: "initiative", title: "Draft scope" });
		const draft = await store.createIssueBreakdownDraft({ targetId: target.id, issues: [{
			key: "work", title: "Proposed work", outcome: "Large authored outcome", scope: ["Scope"],
			workMode: "AFK", acceptanceCriteria: ["Result"], relationReferences: []
		}] });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "draft-show-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const request of [
				{ resource: "issueBreakdown", action: "show", draftId: draft.id },
				{ resource: "issueBreakdown", action: "latest", targetId: target.reference }
			]) {
				const result = await client.callTool({ name: "resource_show", arguments: { request } });
				expect(result).toMatchObject({ structuredContent: { draft: { id: draft.id, snapshotDigest: draft.snapshotDigest, status: draft.status }, reads: { details: { command: "agent-issues", arguments: ["issue-breakdown", "show", draft.id, "--json"] } } } });
				expect(JSON.stringify(result)).not.toContain("Large authored outcome");
			}
			expect(await store.getIssueBreakdownDraft({ draftId: draft.id })).toEqual(draft);
			expect((await store.queryEntities({ kind: "issue" })).entities).toEqual([]);
			const emptyTarget = await store.createEntity({ kind: "initiative", title: "No draft" });
			expect((await client.callTool({ name: "resource_show", arguments: { request: { resource: "issueBreakdown", action: "latest", targetId: emptyTarget.reference } } })).isError).toBe(true);
			expect((await client.callTool({ name: "resource_show", arguments: { request: { resource: "issueBreakdown", action: "show", draftId: randomUUID() } } })).isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads every instruction catalog item through bounded pages", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-catalog-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		await store.importInstructionBundle({ version: packageJson.version, items: Array.from({ length: 320 }, (_, index) => ({
			key: `fragment/item-${String(index).padStart(3, "0")}`, kind: "fragment" as const, body: "Large source\n".repeat(1000)
		})) });
		const expected = await store.listInstructionSources({ version: packageJson.version });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-catalog-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null | undefined;
			const keys: string[] = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(collectionCall("instructionSource", continuation ? { continuation } : {}));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { items: Array<{ key: string; body?: string }>; nextContinuation: string | null };
				for (const item of page.items) {
					expect(item.body).toBeUndefined();
					keys.push(item.key);
				}
				continuation = page.nextContinuation;
				expect(++pageCount).toBeLessThan(50);
			} while (continuation !== null);
			expect(pageCount).toBeGreaterThan(1);
			expect(keys).toEqual(expected.items.map((item) => item.key).sort());
			const first = await client.callTool(collectionCall("instructionSource", {}));
			const firstPage = first.structuredContent as { nextContinuation: string; items: Array<{ key: string }> };
			await store.createInstructionFragment({ version: packageJson.version, key: "fragment/a-before", body: "Before the cursor" });
			await store.createInstructionFragment({ version: packageJson.version, key: "fragment/z-after", body: "After the cursor" });
			continuation = firstPage.nextContinuation;
			const laterKeys: string[] = [];
			do {
				const result = await client.callTool(collectionCall("instructionSource", { continuation }));
				const page = result.structuredContent as { items: Array<{ key: string }>; nextContinuation: string | null };
				laterKeys.push(...page.items.map((item) => item.key));
				continuation = page.nextContinuation;
			} while (continuation !== null);
			expect(laterKeys).toContain("fragment/z-after");
			expect(laterKeys).not.toContain("fragment/a-before");
			expect(laterKeys).not.toContain(firstPage.items[0].key);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads complete instruction history through bounded summaries and body parts", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-history-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const key = "skill/history";
		await store.importInstructionBundle({ version: packageJson.version, items: [{ key, kind: "skill", body: "Default" }, { key: "skill/empty", kind: "skill", body: "Empty history" }] });
		for (let index = 0; index < 192; index++) {
			const current = await store.readInstructionSource({ key, version: packageJson.version });
			await store.saveInstructionSource({ key, version: packageJson.version, expectedRevision: current.source.revision, body: `Revision ${index}\n${"Long source\n".repeat(1000)}` });
		}
		const expected = await store.listInstructionHistory({ key, version: packageJson.version });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-history-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null | undefined;
			const revisions: number[] = [];
			let pages = 0;
			do {
				const result = await client.callTool(historyCall("instructionSource", "list", { key, ...(continuation ? { continuation } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { revisions: Array<{ body?: string; source: { revision: number }; reads: { body: { tool: string; arguments: Record<string, unknown> } } }>; nextContinuation: string | null };
				for (const entry of page.revisions) {
					expect(entry.body).toBeUndefined();
					revisions.push(entry.source.revision);
				}
				if (pages === 0) {
					const read = page.revisions[0].reads.body;
					const body = await client.callTool({ name: read.tool, arguments: read.arguments });
					expect(body.isError).not.toBe(true);
					expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(65536);
				}
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(50);
			} while (continuation !== null);
			expect(pages).toBeGreaterThan(1);
			expect(revisions).toEqual(expected.revisions.map((entry) => entry.source.revision).sort((first, second) => first - second));
			expect((await client.callTool(historyCall("instructionSource", "list", { key: "skill/empty" }))).structuredContent).toEqual({ key: "skill/empty", version: packageJson.version, revisions: [], nextContinuation: null });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads complete instruction dependency sections through bounded pages", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-dependencies-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const fragments = Array.from({ length: 640 }, (_, index) => ({ key: `fragment/dependency-${String(index).padStart(3, "0")}`, kind: "fragment" as const, body: "Rules" }));
		const key = fragments[0].key;
		await store.importInstructionBundle({ version: packageJson.version, items: [
			...fragments.map((item, index) => index === 0 ? { ...item, body: fragments.slice(1).map((target) => `<!-- include:${target.key} -->`).join("\n") } : item),
			{ key: "skill/empty", kind: "skill", body: "No dependencies" },
			...Array.from({ length: 320 }, (_, index) => ({ key: `skill/dependent-${String(index).padStart(3, "0")}`, kind: "skill" as const, body: `<!-- include:${key} -->` }))
		] });
		await store.saveInstructionSource({ key: fragments[1].key, version: packageJson.version, body: "Modified rules", expectedRevision: 1 });
		const expected = await store.inspectInstructionDependencies({ key, version: packageJson.version });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-dependencies-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null | undefined;
			const dependencies: typeof expected.dependencies = [];
			const affectedInstructions: string[] = [];
			const modifiedFragments: string[] = [];
			let pages = 0;
			do {
				const result = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "dependencies", key, ...(continuation ? { continuation } : {}) } } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as typeof expected & { nextContinuation: string | null };
				dependencies.push(...page.dependencies);
				affectedInstructions.push(...page.affectedInstructions);
				modifiedFragments.push(...page.modifiedFragments);
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(80);
			} while (continuation !== null);
			expect(pages).toBeGreaterThan(1);
			expect(dependencies).toEqual(expected.dependencies.sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0));
			expect(affectedInstructions).toEqual(expected.affectedInstructions.sort());
			expect(modifiedFragments).toEqual(expected.modifiedFragments.sort());
			const empty = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "dependencies", key: "skill/empty" } } });
			expect(empty.structuredContent).toMatchObject({ dependencies: [], affectedInstructions: [], modifiedFragments: [], nextContinuation: null });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads complete instruction comparisons in snapshot-bound JSON parts", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-comparison-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const key = "skill/comparison";
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key, kind: "skill", body: "Official default\n".repeat(2000) },
			{ key: "skill/other", kind: "skill", body: "Other" }
		] });
		await store.saveInstructionSource({ key, version: packageJson.version, body: "Personal \u{1F680}\"\\\n".repeat(2000), expectedRevision: 1 });
		const expected = await store.compareInstructionSource({ key, version: packageJson.version });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-comparison-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let reconstructed = "";
			let parts = 0;
			do {
				const result = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "compare", key, ...(offset ? { offset, documentHash } : {}) } } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const content = result.content as Array<{ type: "text"; text: string }>;
				expect(content).toHaveLength(2);
				const metadata = JSON.parse(content[0].text) as { nextOffset: number | null; documentHash: string; format: string };
				expect(metadata.format).toBe("json");
				documentHash ??= metadata.documentHash;
				expect(metadata.documentHash).toBe(documentHash);
				reconstructed += content[1].text;
				offset = metadata.nextOffset;
				expect(++parts).toBeLessThan(100);
			} while (offset !== null);
			expect(parts).toBeGreaterThan(1);
			expect(JSON.parse(reconstructed)).toEqual(expected);
			for (const invalid of [{ offset: 1 }, { offset: 1, documentHash: "0".repeat(64) }, { offset: Number.MAX_SAFE_INTEGER, documentHash }, { key: "skill/other", offset: 1, documentHash }]) {
				const result = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "compare", key, ...invalid } } });
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(result.content).toHaveLength(1);
			}
			await store.saveInstructionSource({ key, version: packageJson.version, body: "Changed", expectedRevision: expected.currentSource.source.revision });
			const changed = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "compare", key, offset: 1, documentHash } } });
			expect(changed.isError).toBe(true);
			expect(changed.content).toHaveLength(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["catalog", "history", "dependencies"] as const)("rejects invalid and cross-scope instruction continuations (%s)", async (operation) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-cursors-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const { store } = await openSqliteStore(dbPath, { tenant: "instruction-owner" });
		const { store: otherStore } = await openSqliteStore(dbPath, { tenant: "instruction-other" });
		const key = "skill/cursors";
		const fragments = Array.from({ length: 320 }, (_, index) => ({ key: `fragment/cursor-${String(index).padStart(3, "0")}`, kind: "fragment" as const, body: "Rules" }));
		const body = fragments.map((item) => `<!-- include:${item.key} -->`).join("\n");
		await store.importInstructionBundle({ version: packageJson.version, items: [...fragments, { key, kind: "skill", body }] });
		for (let index = 0; index < 160; index++) {
			const source = await store.readInstructionSource({ key, version: packageJson.version });
			await store.saveInstructionSource({ key, version: packageJson.version, body: `${body}\n${index}`, expectedRevision: source.source.revision });
		}
		let activeStore = store;
		const server = createMcpServer({ openStore: async () => activeStore });
		const client = new Client({ name: "instruction-cursors-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const call = (continuation?: string, selectedKey = key) => operation === "catalog"
			? collectionCall("instructionSource", continuation ? { continuation } : {})
			: operation === "history" ? historyCall("instructionSource", "list", { key: selectedKey, ...(continuation ? { continuation } : {}) })
				: { name: "instruction_inspect", arguments: { request: { action: "dependencies", key: selectedKey, ...(continuation ? { continuation } : {}) } } };
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool(call());
			const continuation = (first.structuredContent as { nextContinuation: string }).nextContinuation;
			expect(continuation).toEqual(expect.any(String));
			for (const request of [call("invalid"), call(`${continuation}tampered`), operation === "catalog" ? historyCall("instructionSource", "list", { key, continuation }) : call(continuation, fragments[0].key)]) {
				const result = await client.callTool(request);
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			activeStore = otherStore;
			expect((await client.callTool(call(continuation))).isError).toBe(true);
			activeStore = store;
			expect((await client.callTool(call(continuation))).isError).not.toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
			await otherStore.close();
		}
	});

	it.each(["catalog", "history", "dependencies"] as const)("returns a bounded error for an oversized instruction summary (%s)", async (operation) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-oversized-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const key = `fragment/${"large-key".repeat(12000)}`;
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key, kind: "fragment", body: "Rules" },
			{ key: "skill/root", kind: "skill", body: `<!-- include:${key} -->` }
		] });
		await store.saveInstructionSource({ key, version: packageJson.version, body: "Saved rules", expectedRevision: 1 });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-oversized-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = operation === "catalog" ? collectionCall("instructionSource", {})
				: operation === "history" ? historyCall("instructionSource", "list", { key })
					: { name: "instruction_inspect", arguments: { request: { action: "dependencies", key: "skill/root" } } };
			const result = await client.callTool(request);
			expect(result.isError).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			expect(result.structuredContent).toBeUndefined();
			expect(JSON.stringify(result.content)).toContain("65536-byte response budget");
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads every Plan entry through bounded summary pages", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-pages-"));
		directories.push(directory);
		const dbPath = path.join(directory, "plans.db");
		const { store } = await openSqliteStore(dbPath);
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan paging" });
		const plan = await store.createEntity({ kind: "plan", title: "Paged Plan", parentId: initiative.id });
		const issue = await store.createEntity({ kind: "issue", title: "Linked work" });
		for (let index = 0; index < 144; index++) {
			await store.createPlanEntry({ planId: plan.id, role: "decision", body: `Decision ${index}\n${"Large body\n".repeat(1000)}`, referencedEntityIds: [issue.id] });
		}
		const expected = (await store.listPlanEntries({ planId: plan.id })).sort((first, second) => first.id < second.id ? -1 : 1);
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({ dbPath, homeDirectory: directory, credentialStoreOptions });
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const client = new Client({ name: "plan-pages-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null | undefined;
			const references: string[] = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(collectionCall("planEntry", { planId: plan.reference, ...(continuation ? { continuation } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { entries: Array<{ reference: string; body?: string; role: string; referencedEntityIds: string[]; revision: number; reads: { body: { tool: string; arguments: unknown } } }>; nextContinuation: string | null };
				for (const entry of page.entries) {
					expect(entry).toMatchObject({ role: "decision", referencedEntityIds: [issue.id], revision: 1, reads: { body: { tool: "resource_body" } } });
					expect(entry.body).toBeUndefined();
					references.push(entry.reference);
				}
				continuation = page.nextContinuation;
				expect(++pageCount).toBeLessThan(30);
			} while (continuation !== null);
			expect(pageCount).toBeGreaterThan(1);
			expect(references).toEqual(expected.map((entry) => entry.reference));
			const emptyInitiative = await store.createEntity({ kind: "initiative", title: "Empty Plan scope" });
			const emptyPlan = await store.createEntity({ kind: "plan", title: "Empty Plan", parentId: emptyInitiative.id });
			expect((await client.callTool(collectionCall("planEntry", { planId: emptyPlan.id }))).structuredContent).toEqual({ entries: [], nextContinuation: null });
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
			await store.close();
		}
	});

	it("reads every Plan-entry revision through bounded history pages", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-history-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "plans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "History paging" });
		const plan = await store.createEntity({ kind: "plan", title: "History Plan", parentId: initiative.id });
		let entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Original body\n".repeat(10) });
		for (let revision = 2; revision <= 128; revision++) {
			entry = await store.updatePlanEntry({ entryId: entry.id, body: `Revision ${revision}\n${"History body\n".repeat(10)}`, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		}
		await store.deletePlanEntry({ entryId: entry.id, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "plan-history-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null | undefined;
			const revisions: number[] = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(historyCall("planEntry", "list", { entryId: entry.reference, ...(continuation ? { continuation } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { history: Array<{ targetRevision: number; headRevision: number; body?: string; tombstone: boolean; reads: { body: { tool: string; arguments: unknown } } }>; nextContinuation: string | null };
				for (const revision of page.history) {
					expect(revision).toMatchObject({ headRevision: 129, reads: { body: { tool: "resource_body", arguments: { request: { resource: "planEntry", ...{ entryId: entry.reference, revision: revision.targetRevision } } } } } });
					expect(revision.body).toBeUndefined();
					revisions.push(revision.targetRevision);
				}
				continuation = page.nextContinuation;
				expect(++pageCount).toBeLessThan(30);
			} while (continuation !== null);
			expect(pageCount).toBeGreaterThan(1);
			expect(revisions).toEqual(Array.from({ length: 129 }, (_, index) => index + 1));
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([false, true])("reads complete bounded Plan-entry body and metadata parts (historical %s)", async (historical) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-parts-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "plans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Entry parts" });
		const plan = await store.createEntity({ kind: "plan", title: "Parts Plan", parentId: initiative.id });
		const linked = await store.createEntity({ kind: "issue", title: "Linked work" });
		const body = "\u{1F680}\u00e9\u4e2d\n\"\\\t\u0000".repeat(3000);
		const entry = await store.createPlanEntry({ planId: plan.id, role: "scope", scopeDirection: "included", body, referencedEntityIds: [linked.id] });
		if (historical) await store.updatePlanEntry({ entryId: entry.id, body: "New source", expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "plan-parts-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const tool of ["resource_body", "resource_show"]) {
				let offset: number | null = 0;
				let documentHash: string | undefined;
				let reconstructed = "";
				let partCount = 0;
				do {
					const result = await client.callTool(collectionCall(tool, planDetailArguments(tool, { entryId: entry.reference, ...(historical ? { revision: 1 } : {}), ...(offset ? { offset, documentHash } : {}) })));
					expect(result.isError).not.toBe(true);
					expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
					expect(result.structuredContent).toBeUndefined();
					const content = result.content as Array<{ text: string }>;
					const metadata = JSON.parse(content[0].text) as { reference: string; revision: number; documentHash: string; offset: number; nextOffset: number | null };
					documentHash ??= metadata.documentHash;
					expect(metadata).toMatchObject({ reference: entry.reference, revision: 1, documentHash, offset: reconstructed.length });
					expect(content[1].text).not.toMatch(/[\uD800-\uDBFF]$/);
					reconstructed += content[1].text;
					offset = metadata.nextOffset;
					expect(++partCount).toBeLessThan(100);
				} while (offset !== null);
				if (tool === "resource_body") {
					expect(reconstructed).toBe(body);
					expect(partCount).toBeGreaterThan(1);
				} else {
					expect(JSON.parse(reconstructed)).toMatchObject({ role: "scope", scopeDirection: "included", referencedEntityIds: [linked.id], tombstone: false });
					expect(JSON.parse(reconstructed).body).toBeUndefined();
				}
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["planEntry", "planEntryHistory"])("binds %s continuation to its request and preserves live traversal", async (tool) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-continuation-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "plans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Continuation" });
		const plan = await store.createEntity({ kind: "plan", title: "Continuation Plan", parentId: initiative.id });
		let entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Revision 1" });
		const otherEntry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Other entry" });
		for (let index = 2; index <= 100; index++) {
			if (tool === "planEntry") await store.createPlanEntry({ planId: plan.id, role: "decision", body: `Entry ${index}` });
			else entry = await store.updatePlanEntry({ entryId: entry.id, body: `Revision ${index}`, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		}
		const options = { projectIdentity: "plan-scope-a", openStore: async () => store };
		const server = createMcpServer(options);
		const client = new Client({ name: "plan-continuation-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = tool === "planEntry" ? { planId: plan.reference } : { entryId: entry.reference };
			const first = (await client.callTool(collectionCall(tool, request))).structuredContent as { entries?: Array<{ id: string; reference: string }>; history?: Array<{ targetRevision: number }>; nextContinuation: string };
			expect(first.nextContinuation).toEqual(expect.any(String));
			for (const invalid of ["invalid", `${first.nextContinuation}x`]) {
				const result = await client.callTool(collectionCall(tool, { ...request, continuation: invalid }));
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			const otherInitiative = await store.createEntity({ kind: "initiative", title: "Other continuation" });
			const otherPlan = await store.createEntity({ kind: "plan", title: "Other Plan", parentId: otherInitiative.id });
			const otherRequest = tool === "planEntry" ? { planId: otherPlan.reference } : { entryId: otherEntry.reference };
			expect((await client.callTool(collectionCall(tool, { ...otherRequest, continuation: first.nextContinuation }))).isError).toBe(true);
			options.projectIdentity = "plan-scope-b";
			expect((await client.callTool(collectionCall(tool, { ...request, continuation: first.nextContinuation }))).isError).toBe(true);
			options.projectIdentity = "plan-scope-a";
			if (tool === "planEntry") await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Inserted during traversal" });
			else await store.updatePlanEntry({ entryId: entry.id, body: "Appended revision", expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
			const values: Array<string | number> = [];
			let continuation: string | null = first.nextContinuation;
			do {
				const result = await client.callTool(collectionCall(tool, { ...request, continuation }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as typeof first;
				values.push(...(tool === "planEntry" ? page.entries!.map((item) => item.id) : page.history!.map((item) => item.targetRevision)));
				continuation = page.nextContinuation;
				expect(values.length).toBeLessThan(130);
			} while (continuation !== null);
			const expected = tool === "planEntry"
				? (await store.listPlanEntries({ planId: plan.id })).map((item) => item.id).filter((id) => id > first.entries!.at(-1)!.id).sort()
				: (await store.listPlanEntryHistory({ entryId: entry.id })).map((item) => item.targetRevision).filter((revision) => revision > first.history!.at(-1)!.targetRevision).sort((firstRevision, secondRevision) => firstRevision - secondRevision);
			expect(values).toEqual(expected);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads oversized Plan-entry link metadata in complete parts after a bounded page error", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-links-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "plans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Large links" });
		const plan = await store.createEntity({ kind: "plan", title: "Links Plan", parentId: initiative.id });
		const linkedIds: string[] = [];
		for (let index = 0; index < 2000; index++) linkedIds.push((await store.createEntity({ kind: "issue", title: `Linked ${index}` })).id);
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "All linked work", referencedEntityIds: linkedIds });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "plan-links-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const [name, request] of [["planEntry", { planId: plan.id }], ["planEntryHistory", { entryId: entry.id }]] as const) {
				const result = await client.callTool(collectionCall(name, request));
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(result.structuredContent).toBeUndefined();
				expect(JSON.stringify(result.content)).toContain("resource_show");
			}
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let reconstructed = "";
			let partCount = 0;
			do {
				const result = await client.callTool({ name: "resource_show", arguments: planDetailArguments("resource_show", { entryId: entry.reference, revision: 1, ...(offset ? { offset, documentHash } : {}) }) });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const content = result.content as Array<{ text: string }>;
				const metadata = JSON.parse(content[0].text) as { documentHash: string; nextOffset: number | null };
				documentHash ??= metadata.documentHash;
				reconstructed += content[1].text;
				offset = metadata.nextOffset;
				expect(++partCount).toBeLessThan(10);
			} while (offset !== null);
			expect(partCount).toBeGreaterThan(1);
			expect(JSON.parse(reconstructed).referencedEntityIds).toEqual(linkedIds);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["resource_body", "resource_show"])("rejects invalid and changed %s documents without partial output", async (tool) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-plan-part-errors-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "plans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Part errors" });
		const plan = await store.createEntity({ kind: "plan", title: "Errors Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "\u{1F680}Original source\n".repeat(1000) });
		const other = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Other source" });
		const options = { projectIdentity: "plan-parts-a", openStore: async () => store };
		const server = createMcpServer(options);
		const client = new Client({ name: "plan-part-errors-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool(collectionCall(tool, planDetailArguments(tool, { entryId: entry.reference })));
			const metadata = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { documentHash: string; nextOffset: number | null };
			const invalidInputs = [
				{ entryId: entry.reference, offset: 1 },
				{ entryId: entry.reference, offset: Number.MAX_SAFE_INTEGER, documentHash: metadata.documentHash },
				{ entryId: other.reference, documentHash: metadata.documentHash },
				{ entryId: entry.reference, revision: 999 },
				{ entryId: entry.reference, offset: 1, documentHash: "0".repeat(64) }
			];
			if (tool === "resource_body") invalidInputs.push({ entryId: entry.reference, offset: 1, documentHash: metadata.documentHash });
			for (const input of invalidInputs) {
				const failure = await client.callTool(collectionCall(tool, planDetailArguments(tool, input)));
				expect(failure.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(65536);
				expect(failure.structuredContent).toBeUndefined();
				expect(failure.content).toHaveLength(1);
			}
			options.projectIdentity = "plan-parts-b";
			const crossScope = await client.callTool(collectionCall(tool, planDetailArguments(tool, { entryId: entry.reference, documentHash: metadata.documentHash })));
			expect(crossScope.isError).toBe(true);
			expect(crossScope.content).toHaveLength(1);
			expect(crossScope.structuredContent).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(crossScope), "utf8")).toBeLessThanOrEqual(65536);
			options.projectIdentity = "plan-parts-a";
			const otherTool = tool === "resource_body" ? "resource_show" : "resource_body";
			const crossTool = await client.callTool(collectionCall(otherTool, planDetailArguments(otherTool, { entryId: entry.reference, documentHash: metadata.documentHash })));
			expect(crossTool.isError).toBe(true);
			expect(crossTool.content).toHaveLength(1);
			expect(crossTool.structuredContent).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(crossTool), "utf8")).toBeLessThanOrEqual(65536);
			await store.updatePlanEntry({ entryId: entry.id, body: "Changed source", expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
			const changed = await client.callTool(collectionCall(tool, planDetailArguments(tool, { entryId: entry.reference, documentHash: metadata.documentHash })));
			expect(changed.isError).toBe(true);
			expect(changed.structuredContent).toBeUndefined();
			expect(changed.content).toHaveLength(1);
			expect((await client.callTool(collectionCall(tool, planDetailArguments(tool, { entryId: entry.reference })))).isError).not.toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([packageJson.version, `${packageJson.version}-dev.${"a".repeat(64)}`])("uses the same instruction bundle through CLI, MCP, and site (%s)", async (version) => {
		vi.stubGlobal("__AGENT_ISSUES_INSTRUCTION_VERSION__", version);
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const body = "# Prepare\n\nComplete database instructions.\n";
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version, items: [
				{ key: "skill/prepare", kind: "skill", body: "# Prepare\n\n<!-- include:fragment/rules -->\n" },
				{ key: "fragment/rules", kind: "fragment", body: "Complete <!-- include:fragment/end -->" },
				{ key: "fragment/end", kind: "fragment", body: "database instructions." }
			] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-test", version: "1.0.0" });
		let site: Awaited<ReturnType<typeof startLiveSite>> | undefined;
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
			expect(result.isError).not.toBe(true);
			expect(result.content).toEqual([
				{ type: "text", text: expect.any(String) },
				{ type: "text", text: body }
			]);
			expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
				version, documentHash: expect.stringMatching(/^[a-f0-9]{64}$/), offset: 0, nextOffset: null
			});
			expect(result.structuredContent).toBeUndefined();
			const stdout = new PassThrough();
			let output = "";
			stdout.on("data", (chunk) => { output += chunk.toString(); });
			expect(await runCli(["instruction", "retrieve", "skill/prepare", "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(0);
			expect(JSON.parse(output)).toMatchObject({
				body, version, source: { type: "default", revision: 1 },
				fragments: [
					{ key: "fragment/rules", source: { type: "default", revision: 1 } },
					{ key: "fragment/end", source: { type: "default", revision: 1 } }
				]
			});
			output = "";
			expect(await runCli(["instruction", "retrieve", "skill/prepare", "--db", dbPath], { cwd: directory, stdout })).toBe(0);
			expect(output).toBe(body);
			output = "";
			await expect(runCli(["instruction", "retrieve", "skill/missing", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			const missing = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/missing" } });
			expect(missing.isError).toBe(true);
			expect(missing.structuredContent).toBeUndefined();
			site = await startLiveSite({ dbPath, port: 0, currentWorkingDirectory: directory, credentialStoreOptions });
			await new Promise<void>((resolve) => site!.server.once("listening", resolve));
			const address = site.server.address();
			if (!address || typeof address === "string") throw new Error("Expected site address.");
			const source = await fetch(`http://127.0.0.1:${address.port}/api/instructions/source?key=skill%2Fprepare`);
			expect(source.status).toBe(200);
			expect(await source.json()).toMatchObject({ version, key: "skill/prepare", body: "# Prepare\n\n<!-- include:fragment/rules -->\n" });
		} finally {
			site?.close();
			await client.close();
			await server.close();
			await daemon.close();
		}
	});

	it.each([
		["empty", "", true],
		["large Markdown in one call", "# Instructions\n\nRead the complete document.\n".repeat(900), true],
		["larger Markdown", "# Instructions\n\nRead the complete document.\n".repeat(3_600), false],
		["escaped Unicode", "\u{1F680}\u00e9\u4e2d\n\"\\\t\u0000".repeat(12_000), false]
	] as const)("reads complete bounded instruction parts (%s)", async (_name, body, singlePart) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-parts-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
			{ key: "fragment/rules", kind: "fragment", body: "<!-- include:fragment/end -->" },
			{ key: "fragment/end", kind: "fragment", body }
		] });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-parts-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let reconstructed = "";
			let partCount = 0;
			do {
				const argumentsValue = { key: "skill/prepare", ...(offset ? { offset, documentHash } : {}) };
				const result = await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);
				const content = result.content as Array<{ type: string; text: string }>;
				expect(content).toHaveLength(2);
				const metadata = JSON.parse(content[0].text) as { version: string; documentHash: string; offset: number; nextOffset: number | null };
				documentHash ??= metadata.documentHash;
				expect(metadata).toMatchObject({ version: packageJson.version, documentHash, offset: reconstructed.length });
				if (metadata.nextOffset !== null) {
					expect(metadata.nextOffset).toBe(reconstructed.length + content[1].text.length);
					expect(content[1].text.length).toBeGreaterThan(0);
					expect(content[1].text).not.toMatch(/[\uD800-\uDBFF]$/);
				}
				if (offset) expect(await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue })).toEqual(result);
				reconstructed += content[1].text;
				offset = metadata.nextOffset;
				expect(++partCount).toBeLessThan(100);
			} while (offset !== null);
			expect(reconstructed).toBe(body);
			if (singlePart) expect(partCount).toBe(1);
			else expect(partCount).toBeGreaterThan(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([
		["empty", "", undefined],
		["escaped Unicode", "\u{1F680}\u00e9\u4e2d\n\"\\\t\u0000".repeat(3_000), undefined],
		["historical", "# Earlier body\n".repeat(2_000), 1]
	] as const)("reads complete bounded entity body parts (%s)", async (_name, body, revision) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-parts-"));
		directories.push(directory);
		const dbPath = path.join(directory, "entities.db");
		const { store } = await openSqliteStore(dbPath);
		const entity = await store.createEntity({ kind: "issue", title: "Body parts", body });
		if (revision !== undefined) await store.updateEntity({ entityId: entity.id, body: "Current body", expectedRevision: entity.revision, expectedContentHash: entity.contentHash });
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({ dbPath, homeDirectory: directory, credentialStoreOptions });
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const client = new Client({ name: "entity-parts-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let reconstructed = "";
			let partCount = 0;
			do {
				const result = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity",
					entityId: entity.reference, ...(revision ? { revision } : {}), ...(offset ? { offset, documentHash } : {})
				} } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(result.structuredContent).toBeUndefined();
				const content = result.content as Array<{ text: string }>;
				expect(content).toHaveLength(2);
				const metadata = JSON.parse(content[0].text) as { documentHash: string; offset: number; nextOffset: number | null };
				documentHash ??= metadata.documentHash;
				expect(metadata).toMatchObject({ reference: entity.reference, revision: entity.revision, documentHash, offset: reconstructed.length });
				if (metadata.nextOffset !== null) {
					expect(metadata.nextOffset).toBe(reconstructed.length + content[1].text.length);
					expect(content[1].text.length).toBeGreaterThan(0);
					expect(content[1].text).not.toMatch(/[\uD800-\uDBFF]$/);
				}
				reconstructed += content[1].text;
				offset = metadata.nextOffset;
				expect(++partCount).toBeLessThan(100);
			} while (offset !== null);
			expect(reconstructed).toBe(body);
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
			await store.close();
		}
	});

	it("rejects invalid entity body continuations without partial Markdown", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-offsets-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "entities.db"));
		const body = "\u{1F680}" + "Read the body.\n".repeat(16_000);
		const entity = await store.createEntity({ kind: "issue", title: "First", body });
		const other = await store.createEntity({ kind: "issue", title: "Other", body });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "entity-offsets-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference } } });
			const { nextOffset: offset, documentHash } = JSON.parse((first.content as Array<{ text: string }>)[0].text) as { nextOffset: number; documentHash: string };
			for (const argumentsValue of [
				{ entityId: entity.reference, offset },
				{ entityId: entity.reference, offset: 1, documentHash },
				{ entityId: entity.reference, offset: body.length, documentHash },
				{ entityId: entity.reference, offset, documentHash: "0".repeat(64) },
				{ entityId: other.reference, offset, documentHash },
				{ entityId: entity.reference, offset: -1, documentHash },
				{ entityId: entity.reference, offset: 1.5, documentHash },
				{ entityId: entity.reference, offset: Number.MAX_SAFE_INTEGER + 1, documentHash },
				{ entityId: entity.reference, revision: 99 },
				{ entityId: "missing-entity" },
				{ entityId: "missing-".repeat(3_000) }
			]) {
				const result = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity", ...argumentsValue } } });
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(result.structuredContent).toBeUndefined();
				expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
			}
			await store.updateEntity({ entityId: entity.id, body, expectedRevision: entity.revision, expectedContentHash: entity.contentHash });
			for (const revision of [undefined, 2]) {
				const changed = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference, offset, documentHash, ...(revision ? { revision } : {}) } } });
				expect(changed.isError).toBe(true);
				expect(changed.content).toEqual([{ type: "text", text: expect.stringContaining("Discard all parts and restart") }]);
			}
			const historical = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference, revision: 1, offset, documentHash } } });
			expect(historical.isError).not.toBe(true);
			const restarted = await client.callTool({ name: "resource_body", arguments: { request: { resource: "entity", entityId: entity.reference } } });
			expect(restarted.isError).not.toBe(true);
			const metadata = JSON.parse((restarted.content as Array<{ text: string }>)[0].text);
			expect(metadata.revision).toBe(2);
			expect(metadata.documentHash).not.toBe(documentHash);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["context", "contextTerm", "instructionSource"] as const)("reads complete scoped resource text and revisions (%s)", async (resource) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-resource-body-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "resources.db"));
		const body = "<!-- include:fragment/rules -->\n\u{1F680}\u00e9\u4e2d\"\\\t\u0000\n".repeat(1500) + "End";
		const initialRevision = resource === "instructionSource" ? 2 : 1;
		let request: Record<string, unknown>;
		let update: (body: string) => Promise<unknown>;
		if (resource === "context") {
			await store.upsertContext({ title: "Resource", summary: body });
			request = { resource };
			update = async (summary) => {
				const { context } = await store.getContextDetails();
				return store.upsertContext({ title: context.title, summary, expectedRevision: context.revision, expectedContentHash: context.contentHash });
			};
		} else if (resource === "contextTerm") {
			await store.defineContextTerm({ term: "Resource", definition: body });
			request = { resource, term: "Resource" };
			update = async (definition) => {
				const term = (await store.getContextDetails()).terms[0];
				return store.defineContextTerm({ term: term.term, definition, expectedRevision: term.revision, expectedContentHash: term.contentHash });
			};
		} else {
			await store.importInstructionBundle({ version: packageJson.version, items: [
				{ key: "skill/resource", kind: "skill", body }, { key: "fragment/rules", kind: "fragment", body: "Expanded fragment" }
			] });
			request = { resource, key: "skill/resource" };
			update = async (body) => {
				const source = await store.readInstructionSource({ key: "skill/resource", version: packageJson.version });
				return store.saveInstructionSource({ key: "skill/resource", version: packageJson.version, body, expectedRevision: source.source.revision });
			};
			await update(body);
		}
		const options = { projectIdentity: "resource-scope", openStore: async () => store };
		const server = createMcpServer(options);
		const client = new Client({ name: "resource-body-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const read = async (selected: Record<string, unknown>) => {
				let offset: number | null = 0;
				let documentHash: string | undefined;
				let text = "";
				do {
					const result = await client.callTool({ name: "resource_body", arguments: { request: { ...selected, ...(offset ? { offset, documentHash } : {}) } } });
					expect(result.isError).not.toBe(true);
					expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
					expect(result.structuredContent).toBeUndefined();
					const content = result.content as Array<{ text: string }>;
					const metadata = JSON.parse(content[0].text);
					expect(metadata).toMatchObject({ resource, revision: selected.revision ?? initialRevision, tenantId: store.tenantId, offset: text.length });
					if (resource === "instructionSource") expect(metadata.owner).toEqual({ type: "local" });
					documentHash ??= metadata.documentHash;
					expect(metadata.documentHash).toBe(documentHash);
					text += content[1].text;
					offset = metadata.nextOffset;
					if (offset !== null) expect(offset).toBe(text.length);
					expect(text.length).toBeLessThanOrEqual(body.length);
				} while (offset !== null);
				return { text, documentHash };
			};
			const original = await read(request);
			expect(original.text).toBe(body);
			const other = await store.createEntity({ kind: "issue", title: "Other resource kind", body });
			for (const invalid of [
				{ ...request, revision: 999 }, { ...request, offset: 1 },
				{ ...request, offset: body.length, documentHash: original.documentHash },
				{ ...request, documentHash: "0".repeat(64) },
				{ resource: "entity", entityId: other.reference, documentHash: original.documentHash }
			]) {
				const result = await client.callTool({ name: "resource_body", arguments: { request: invalid } });
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(result.content).toHaveLength(1);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			options.projectIdentity = "another-workspace";
			expect((await client.callTool({ name: "resource_body", arguments: { request: { ...request, documentHash: original.documentHash } } })).isError).toBe(true);
			options.projectIdentity = "resource-scope";
			await update("Changed");
			expect((await client.callTool({ name: "resource_body", arguments: { request: { ...request, documentHash: original.documentHash } } })).isError).toBe(true);
			expect((await read({ ...request, revision: initialRevision })).text).toBe(body);
			if (resource === "instructionSource") {
				await update("");
				expect((await read({ ...request, revision: initialRevision + 2 })).text).toBe("");
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("rejects invalid offsets, missing hashes, wrong keys, and changed snapshots without partial Markdown", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-offsets-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const source = "<!-- include:fragment/rules -->";
		const rules = "\u{1F680}" + "Read these instructions.\n".repeat(9_000);
		await store.importInstructionBundle({ version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill", body: source },
			{ key: "skill/other", kind: "skill", body: source },
			{ key: "fragment/rules", kind: "fragment", body: rules }
		] });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "instruction-offsets-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
			const { nextOffset, documentHash } = JSON.parse((first.content as Array<{ text: string }>)[0].text) as { nextOffset: number; documentHash: string };
			expect(nextOffset).toEqual(expect.any(Number));
			for (const argumentsValue of [
				{ key: "skill/prepare", offset: nextOffset },
				{ key: "skill/prepare", offset: 1, documentHash },
				{ key: "skill/prepare", offset: rules.length, documentHash },
				{ key: "skill/prepare", offset: nextOffset, documentHash: "0".repeat(64) },
				{ key: "skill/other", offset: nextOffset, documentHash }
			]) {
				const result = await client.callTool({ name: "instruction_retrieve", arguments: argumentsValue });
				expect(result.isError).toBe(true);
				expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("restart instruction_retrieve without offset and documentHash") }]);
			}
			for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				const invalid = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare", offset, documentHash } });
				expect(invalid.isError).toBe(true);
				expect(invalid.content).toEqual([{ type: "text", text: expect.stringContaining("Input validation error") }]);
			}
			for (const [key, body] of [["skill/prepare", source], ["fragment/rules", rules]]) {
				const before = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
				const { nextOffset: offset, documentHash: beforeHash } = JSON.parse((before.content as Array<{ text: string }>)[0].text) as { nextOffset: number; documentHash: string };
				await store.saveInstructionSource({ version: packageJson.version, key, body, expectedRevision: 1 });
				const changed = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare", offset, documentHash: beforeHash } });
				expect(changed.isError).toBe(true);
				expect(changed.content).toEqual([{ type: "text", text: expect.stringContaining("Discard all parts and restart") }]);
				const restarted = await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } });
				expect(restarted.isError).not.toBe(true);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("validates resource body variants before opening storage", async () => {
		const openStore = vi.fn(async () => { throw new Error("Storage must not open."); });
		const server = createMcpServer({ openStore });
		const client = new Client({ name: "resource-schema-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const { tools } = await client.listTools();
			expect(tools.find((tool) => tool.name === "resource_body")?.annotations?.readOnlyHint).toBe(true);
			for (const name of ["entity_body_read", "comment_body_read", "plan_entry_body_read"]) expect(tools.some((tool) => tool.name === name)).toBe(false);
			for (const request of [
				{ resource: "tenant", revision: 1 }, { resource: "entity", commentId: "wrong" },
				{ resource: "context", revision: 0 }, { resource: "contextTerm", term: "" },
				{ resource: "instructionSource", key: "skill/example", version: "unsupported" },
				{ resource: "comment", commentId: "example", revision: 1.5 }
			]) {
				const result = await client.callTool({ name: "resource_body", arguments: { request } });
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			expect(openStore).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});

	it.for(["local", "cloud"])("previews, commits, and compares instructions through site, CLI, and MCP (%s)", async (backend, { skip }) => {
		if (backend === "cloud" && (!process.env.AGENT_ISSUES_TEST_PG_URL || !process.env.AGENT_ISSUES_TEST_PG_APP_URL)) skip();
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-batch-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = { ...fakeCredentialStore(), homeDirectory: directory };
		const previousBundle = { version: `reset-all-previous-${randomUUID()}`, items: [{ key: "fragment/same-key", kind: "fragment" as const, body: "Previous default" }] };
		const bundle = { version: packageJson.version, items: [
			{ key: "skill/prepare", kind: "skill" as const, body: "Prepare" },
			{ key: "fragment/rules", kind: "fragment" as const, body: "Rules" }
		] };
		const adminPool = backend === "cloud" ? createPgPool({ connectionString: process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues" }) : undefined;
		const appPool = backend === "cloud" ? createPgPool({ connectionString: process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues" }) : undefined;
		const tenantId = `batch-interface-${randomUUID()}`;
		let cloud: ReturnType<typeof createApiServer> | undefined;
		let installedBundle = false;
		if (adminPool && appPool) {
			await migratePgDatabase(adminPool);
			installedBundle = !(await adminPool.query("SELECT 1 FROM instruction_bundles WHERE version = $1", [bundle.version])).rows.length;
			await installInstructionBundle(adminPool, bundle);
			const authProvider = new LocalAuthProvider({ secret: "test-only-instruction-batch-secret" });
			cloud = createApiServer({ pool: appPool, authProvider, port: 0, authMetadata: { provider: "entra", tenantId, clientId: "test-client" } });
			await new Promise<void>((resolve) => cloud!.server.once("listening", resolve));
			const address = cloud.server.address();
			if (!address || typeof address === "string") throw new Error("Cloud test server has no TCP address.");
			await saveSavedLogin({ name: "test-cloud", kind: "remote", serviceUrl: `http://127.0.0.1:${address.port}`, tenantId, userId: "alice",
				accessToken: await authProvider.issueToken({ tenantId, userId: "alice" }), expiresAt: "2099-01-01T00:00:00.000Z" }, credentialStoreOptions);
		}
		const daemon = backend === "local" ? createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: bundle
		}) : undefined;
		if (daemon) await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = backend === "cloud" ? createMcpServer({
			fallbackWorkspaceRoot: directory,
			openStore: async (scope) => (await openStorageDriver({ authSessionOptions: credentialStoreOptions,
				databaseOptions: { currentWorkingDirectory: directory, projectIdentity: scope?.projectIdentity } })).store
		}) : createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "batch-test", version: "1.0.0" });
		const inputPath = path.join(directory, "changes.json");
		let site: Awaited<ReturnType<typeof startLiveSite>> | undefined;
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function commit(input: object, exitCode = 0) {
			writeFileSync(inputPath, JSON.stringify(input));
			output = "";
			expect(await runCli(["instruction", "commit", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(exitCode);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/personal", body: "Personal" } } });
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key: "skill/prepare", body: "<!-- include:fragment/personal -->", expectedRevision: 1 } } });
			const beforePreview = (await client.callTool(collectionCall("instructionSource", {}))).structuredContent;
			site = await startLiveSite({ dbPath, port: 0, currentWorkingDirectory: directory, credentialStoreOptions });
			await new Promise<void>((resolve) => site!.server.once("listening", resolve));
			const siteAddress = site.server.address();
			if (!siteAddress || typeof siteAddress === "string") throw new Error("Site test server has no TCP address.");
			const previewUrl = `http://127.0.0.1:${siteAddress.port}/api/instructions/preview`;
			for (const changes of [
				[{ key: "skill/prepare", body: "Pending <!-- include:fragment/rules --> Again <!-- include:fragment/rules -->" }],
				[{ key: "skill/prepare", body: "Pending <!-- include:fragment/rules --> Again <!-- include:fragment/rules -->" }, { key: "fragment/rules", body: "New <!-- include:fragment/personal -->" }]
			]) {
				const preview = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "preview", key: "skill/prepare", changes } } });
				expect(preview.isError).not.toBe(true);
				expect(preview.structuredContent).toMatchObject({ pending: true, version: packageJson.version,
					pendingKeys: changes.map((change) => change.key).sort(),
					body: changes.length === 1 ? "Pending Rules Again Rules" : "Pending New Personal Again New Personal" });
				writeFileSync(inputPath, JSON.stringify({ changes }));
				output = "";
				expect(await runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
				expect(JSON.parse(output)).toEqual(preview.structuredContent);
				const response = await fetch(previewUrl, { method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ key: "skill/prepare", changes, version: "ignored-client-version" }) });
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual(preview.structuredContent);
				output = "";
				expect(await runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
				expect(output).toBe(`Pending\n\n${(preview.structuredContent as { body: string }).body}`);
			}
			const invalidPreview = { changes: [{ key: "skill/prepare", body: "Partial <!-- include:fragment/missing -->" }] };
			const failedPreview = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "preview", key: "skill/prepare", ...invalidPreview } } });
			expect(failedPreview.isError).toBe(true);
			expect(failedPreview.structuredContent).toBeUndefined();
			writeFileSync(inputPath, JSON.stringify(invalidPreview));
			output = "";
			await expect(runCli(["instruction", "preview", "skill/prepare", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("fragment not found");
			expect(output).toBe("");
			const failedSitePreview = await fetch(previewUrl, { method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: "skill/prepare", ...invalidPreview }) });
			expect(failedSitePreview.status).toBe(500);
			expect(await failedSitePreview.text()).toContain("fragment not found");
			expect((await fetch(previewUrl)).status).toBe(405);
			expect((await fetch(previewUrl, { method: "POST", body: "invalid-json" })).status).toBe(400);
			expect((await client.callTool(collectionCall("instructionSource", {}))).structuredContent).toEqual(beforePreview);
			const input = { changes: [
				{ operation: "remove", key: "fragment/personal", expectedRevision: 1 },
				{ operation: "save", key: "skill/prepare", body: "<!-- include:fragment/rules -->", expectedRevision: 2 }
			] };
			const saved = await commit(input);
			expect(saved).toMatchObject({ version: packageJson.version, changes: [
				{ operation: "remove", source: { key: "fragment/personal", source: { revision: 2 } } },
				{ operation: "save", source: { key: "skill/prepare", source: { revision: 3 } } }
			] });
			const staleInput = { changes: [
				{ operation: "save", key: "fragment/rules", body: "Changed", expectedRevision: 1 },
				{ operation: "save", key: "skill/prepare", body: "Stale", expectedRevision: 2 }
			] };
			const stale = await client.callTool({ name: "instruction_update", arguments: { request: { action: "commit", ...staleInput } } });
			expect(stale.isError).toBe(true);
			expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: { key: "skill/prepare", source: { revision: 3 } } });
			expect(await commit(staleInput, 1)).toEqual(stale.structuredContent);
			const invalidInput = { changes: [
				{ operation: "save", key: "skill/prepare", body: "New", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "<!-- include:fragment/missing -->", expectedRevision: 1 }
			] };
			const invalid = await client.callTool({ name: "instruction_update", arguments: { request: { action: "commit", ...invalidInput } } });
			expect(invalid.isError).toBe(true);
			expect(await commit(invalidInput, 1)).toEqual(invalid.structuredContent);
			const changesUrl = `http://127.0.0.1:${siteAddress.port}/api/instructions/changes`;
			const frontmatterInput = { changes: [
				{ operation: "save", key: "skill/prepare", body: "---\nname: changed\n---\nNew", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "Changed rules", expectedRevision: 1 }
			] };
			for (const changes of [staleInput, invalidInput, frontmatterInput]) {
				const response = await fetch(changesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) });
				expect(response.status).toBe(400);
				if (changes === frontmatterInput) expect(await response.text()).toContain("frontmatter is read-only");
			}
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } })).content).toContainEqual({ type: "text", text: "Rules" });
			const siteCommit = await fetch(changesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "ignored-client-version", changes: [
				{ operation: "save", key: "skill/prepare", body: "New <!-- include:fragment/rules -->", expectedRevision: 3 },
				{ operation: "save", key: "fragment/rules", body: "rules", expectedRevision: 1 }
			] }) });
			expect(siteCommit.status).toBe(200);
			expect(await siteCommit.json()).toMatchObject({ version: packageJson.version, changes: [
				{ source: { source: { revision: 4 } } }, { source: { source: { revision: 2 } } }
			] });
			expect((await fetch(changesUrl)).status).toBe(405);
			expect((await fetch(changesUrl, { method: "POST", body: "invalid-json" })).status).toBe(400);
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } })).content).toContainEqual({ type: "text", text: "New rules" });
			async function historyCli(args: string[], exitCode = 0) {
				output = "";
				expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).toBe(exitCode);
				return JSON.parse(output);
			}
			const key = "skill/prepare";
			const history = await client.callTool(historyCall("instructionSource", "list", { key }));
			expect(history.isError).not.toBe(true);
			expect(history.structuredContent).toMatchObject({ version: packageJson.version, key, revisions: [
				{ source: { revision: 2 } }, { source: { revision: 3 } }, { source: { revision: 4 } }
			] });
			const cliHistory = await historyCli(["history", key]) as { revisions: Array<{ body: string; source: { revision: number } }> };
			const historyPage = history.structuredContent as { revisions: Array<{ reads: unknown }> };
			expect(historyPage.revisions.map(({ reads: _reads, ...entry }) => entry)).toEqual(cliHistory.revisions.map(({ body: _body, ...entry }) => entry).sort((first, second) => first.source.revision - second.source.revision));
			const revision = await client.callTool(historyCall("instructionSource", "revision", { key, revision: 3 }));
			const { reads: revisionReads, ...revisionMetadata } = revision.structuredContent as Record<string, unknown> & { reads: { body: { tool: string; arguments: Record<string, unknown> } } };
			const historicalBody = await client.callTool({ name: revisionReads.body.tool, arguments: revisionReads.body.arguments });
			const historicalText = (historicalBody.content as Array<{ text: string }>)[1].text;
			expect(await historyCli(["revision", key, "--revision", "3"])).toEqual({ ...revisionMetadata, body: historicalText });
			output = "";
			expect(await runCli(["instruction", "revision", key, "--revision", "3", "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(output).toBe("<!-- include:fragment/rules -->");
			const restored = await client.callTool({ name: "instruction_update", arguments: { request: { action: "restore", key, revision: 3, expectedRevision: 4 } } });
			expect(restored.isError).not.toBe(true);
			expect(await historyCli(["read", key])).toEqual(restored.structuredContent);
			const cliRestored = await historyCli(["restore", key, "--revision", "4", "--expected-revision", "5"]);
			expect((await readInstructionSource(client, key)).structuredContent).toEqual(cliRestored);
			for (const [revisionNumber, expectedRevision, reason] of [[3, 5, "revision-conflict"], [2, 6, "invalid-source"]] as const) {
				const failed = await client.callTool({ name: "instruction_update", arguments: { request: { action: "restore", key, revision: revisionNumber, expectedRevision } } });
				expect(failed.isError).toBe(true);
				expect(failed.structuredContent).toMatchObject({ reason, currentSource: cliRestored });
				expect(await historyCli(["restore", key, "--revision", String(revisionNumber), "--expected-revision", String(expectedRevision)], 1)).toEqual(failed.structuredContent);
			}
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key } })).content).toContainEqual({ type: "text", text: "New rules" });
			const beforeComparison = await historyCli(["history", key]);
			const compared = await readInstructionComparison(client, key);
			expect(compared.isError).not.toBe(true);
			expect(compared.structuredContent).toMatchObject({
				key, version: packageJson.version, currentSource: cliRestored, different: true,
				defaultSource: { version: packageJson.version, body: "Prepare", source: { type: "default", revision: 1 } }
			});
			expect(await historyCli(["compare", key])).toEqual(compared.structuredContent);
			output = "";
			expect(await runCli(["instruction", "compare", key, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(JSON.parse(output)).toEqual(compared.structuredContent);
			const missingComparison = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "compare", key: "skill/missing" } } });
			expect(missingComparison.isError).toBe(true);
			expect(missingComparison.structuredContent).toBeUndefined();
			output = "";
			await expect(runCli(["instruction", "compare", "skill/missing", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			expect(await historyCli(["read", key])).toEqual(cliRestored);
			expect(await historyCli(["history", key])).toEqual(beforeComparison);
			const dependencies = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "dependencies", key, version: "ignored-client-version" } } });
			expect(dependencies.isError).not.toBe(true);
			expect(dependencies.structuredContent).toMatchObject({
				key, version: packageJson.version, source: cliRestored.source,
				dependencies: [{ key: "fragment/rules", direct: true, source: { type: "override", revision: 2 } }],
				affectedInstructions: [], modifiedFragments: ["fragment/rules"]
			});
			const { nextContinuation: _dependencyContinuation, ...dependencyResult } = dependencies.structuredContent as Record<string, unknown>;
			expect(await historyCli(["dependencies", key])).toEqual(dependencyResult);
			output = "";
			expect(await runCli(["instruction", "dependencies", key, "--db", dbPath], { cwd: directory, stdout, credentialStoreOptions })).toBe(0);
			expect(JSON.parse(output)).toEqual(dependencyResult);
			const fragmentImpact = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "dependencies", key: "fragment/rules" } } });
			expect(fragmentImpact.structuredContent).toMatchObject({ dependencies: [], affectedInstructions: [key], modifiedFragments: ["fragment/rules"] });
			const missingDependencies = await client.callTool({ name: "instruction_inspect", arguments: { request: { action: "dependencies", key: "skill/missing" } } });
			expect(missingDependencies.isError).toBe(true);
			expect(missingDependencies.structuredContent).toBeUndefined();
			output = "";
			await expect(runCli(["instruction", "dependencies", "skill/missing", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("Instruction not found");
			expect(output).toBe("");
			expect(await historyCli(["history", key])).toEqual(beforeComparison);
			const inspected = await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "one", phase: "inspect", key } } });
			expect(inspected.isError).not.toBe(true);
			const { confirmationToken, expiresAt, ...impact } = inspected.structuredContent as Record<string, unknown>;
			expect(impact).toMatchObject({ currentSource: cliRestored, proposedSource: { body: "Prepare" }, affectedInstructions: [key], modifiedFragments: [] });
			expect(await historyCli(["reset-inspect", key])).toEqual(impact);
			output = "";
			await expect(runCli(["instruction", "reset", key, "--expected-revision", "6", "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("--yes");
			expect(output).toBe("");
			const reset = await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "one", phase: "apply", key, expectedRevision: 6, confirmationToken } } });
			expect(reset.isError).not.toBe(true);
			expect(reset.structuredContent).toMatchObject({ body: "Prepare", source: { type: "default", revision: 7 } });
			expect(await historyCli(["read", "fragment/rules"])).toMatchObject({ body: "rules", source: { type: "override", revision: 2 } });
			expect(await historyCli(["reset", key, "--expected-revision", "6", "--yes"], 1)).toMatchObject({ reason: "revision-conflict", currentSource: reset.structuredContent });
			const replay = await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "one", phase: "apply", key, expectedRevision: 6, confirmationToken } } });
			expect(replay.isError).toBe(true);
			const cliReset = await historyCli(["reset", key, "--expected-revision", "7", "--yes"]);
			expect(cliReset).toMatchObject({ body: "Prepare", source: { type: "default", revision: 8 } });
			expect((await readInstructionSource(client, key)).structuredContent).toEqual(cliReset);
			if (adminPool) {
				await installInstructionBundle(adminPool, previousBundle);
				const opened = await openStorageDriver({ authSessionOptions: credentialStoreOptions, databaseOptions: { currentWorkingDirectory: directory } });
				try { await opened.store.saveInstructionSource({ version: previousBundle.version, key: "fragment/same-key", body: "Hidden override", expectedRevision: 1 }); }
				finally { await opened.store.close(); }
			} else {
				const opened = await openSqliteStore(dbPath, { projectIdentity: "reset-all-fixture" });
				try {
					await opened.store.importInstructionBundle(previousBundle);
					await opened.store.saveInstructionSource({ version: previousBundle.version, key: "fragment/same-key", body: "Hidden override", expectedRevision: 1 });
				} finally { await opened.store.close(); }
			}
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/same-key", body: "Same-key personal fragment" } } });
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/reset-all", body: "Personal" } } });
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key, body: "<!-- include:fragment/reset-all -->", expectedRevision: 8 } } });
			const allInspection = await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "inspect" } } });
			expect(allInspection.isError).not.toBe(true);
			const { confirmationToken: allToken, expiresAt: allExpiry, ...allImpact } = allInspection.structuredContent as Record<string, unknown>;
			expect(allImpact).toMatchObject({ version: packageJson.version, overrides: [
				{ currentSource: { key: "fragment/rules" } }, { currentSource: { key: "fragment/same-key" }, proposedSource: null }, { currentSource: { key } }
			], personalFragments: [{ key: "fragment/reset-all" }, { key: "fragment/same-key" }], affectedInstructions: [key] });
			expect(await historyCli(["reset-all-inspect"])).toEqual(allImpact);
			const resetAllUrl = previewUrl.replace("/preview", "/reset-all");
			const siteInspection = await fetch(`${resetAllUrl}/inspect`);
			expect(siteInspection.status).toBe(200);
			const { confirmationToken: siteToken, expiresAt: siteExpiry, ...siteImpact } = await siteInspection.json();
			expect(siteImpact).toEqual(allImpact);
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: allImpact.expectedRevisions }));
			output = "";
			await expect(runCli(["instruction", "reset-all", "--input-file", inputPath, "--db", dbPath, "--json"], { cwd: directory, stdout, credentialStoreOptions })).rejects.toThrow("--yes");
			expect(output).toBe("");
			const unconfirmedSite = await fetch(resetAllUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevisions: allImpact.expectedRevisions }) });
			expect(unconfirmedSite.status).toBe(400);
			const resetAll = await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "apply", expectedRevisions: allImpact.expectedRevisions, confirmationToken: allToken } } });
			expect(resetAll.isError).not.toBe(true);
			expect(resetAll.structuredContent).toEqual(allImpact);
			expect(await historyCli(["read", key])).toMatchObject({ body: "Prepare", source: { type: "default", revision: 10 } });
			expect(await historyCli(["read", "fragment/rules"])).toMatchObject({ body: "Rules", source: { type: "default", revision: 3 } });
			expect((await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "apply", expectedRevisions: allImpact.expectedRevisions, confirmationToken: allToken } } })).isError).toBe(true);
			const emptyImpact = await historyCli(["reset-all-inspect"]);
			expect(emptyImpact).toMatchObject({ overrides: [], personalFragments: [], expectedRevisions: [] });
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: [] }));
			expect(await historyCli(["reset-all", "--input-file", inputPath, "--yes"])).toEqual(emptyImpact);
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/site-reset", body: "Site" } } });
			const freshSiteInspection = await (await fetch(`${resetAllUrl}/inspect`)).json();
			const siteReset = await fetch(resetAllUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevisions: freshSiteInspection.expectedRevisions, confirmationToken: freshSiteInspection.confirmationToken }) });
			expect(siteReset.status).toBe(200);
			expect(await historyCli(["reset-all-inspect"])).toEqual(emptyImpact);
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/confirmation", body: "Private" } } });
			const staleInspection = (await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "inspect" } } })).structuredContent as Record<string, unknown>;
			await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key: "fragment/confirmation", body: "Changed", expectedRevision: 1 } } });
			writeFileSync(inputPath, JSON.stringify({ expectedRevisions: staleInspection.expectedRevisions }));
			expect(await historyCli(["reset-all", "--input-file", inputPath, "--yes"], 1)).toMatchObject({ reason: "revision-conflict", currentInspection: { personalFragments: [{ body: "Changed" }] } });
			expect((await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "apply", expectedRevisions: staleInspection.expectedRevisions, confirmationToken: staleInspection.confirmationToken } } })).isError).toBe(true);
			if (cloud) {
				const address = cloud.server.address();
				if (!address || typeof address === "string") throw new Error("Cloud test server has no TCP address.");
				const serviceUrl = `http://127.0.0.1:${address.port}`;
				const authProvider = new LocalAuthProvider({ secret: "test-only-instruction-batch-secret" });
				async function switchOwner(userId: string) {
					await saveSavedLogin({ name: "test-cloud", kind: "remote", serviceUrl, tenantId, userId,
						accessToken: await authProvider.issueToken({ tenantId, userId }), expiresAt: "2099-01-01T00:00:00.000Z" }, credentialStoreOptions);
				}
				const ownerInspection = (await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "inspect" } } })).structuredContent as Record<string, unknown>;
				await switchOwner("bob");
				await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key: "fragment/confirmation", body: "Private" } } });
				await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key: "fragment/confirmation", body: "Changed", expectedRevision: 1 } } });
				expect((await client.callTool({ name: "instruction_reset", arguments: { request: { scope: "all", phase: "apply", expectedRevisions: ownerInspection.expectedRevisions, confirmationToken: ownerInspection.confirmationToken } } })).isError).toBe(true);
				expect(await historyCli(["read", "fragment/confirmation"])).toMatchObject({ body: "Changed", source: { revision: 2 } });
				await switchOwner("alice");
			}
		} finally {
			await client.close();
			await server.close();
			if (site) {
				const closed = new Promise<void>((resolve) => site!.server.once("close", resolve));
				site.close();
				await closed;
			}
			await daemon?.close();
			if (cloud) await new Promise<void>((resolve, reject) => cloud!.server.close((error) => error ? reject(error) : resolve()));
			if (adminPool) {
				await adminPool.query("DELETE FROM instruction_history WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_personal_fragments WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_overrides WHERE tenant_id = $1", [tenantId]);
				await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [previousBundle.version]);
				await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [previousBundle.version]);
				if (installedBundle) {
					await adminPool.query("DELETE FROM instruction_defaults WHERE version = $1", [bundle.version]);
					await adminPool.query("DELETE FROM instruction_bundles WHERE version = $1", [bundle.version]);
				}
				await adminPool.end();
			}
			await appPool?.end();
		}
	});

	it("creates and removes the same personal fragments through CLI and MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-fragment-interfaces-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version: packageJson.version, items: [{ key: "skill/prepare", kind: "skill", body: "Prepare" }] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "fragment-test", version: "1.0.0" });
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function cli(args: string[], exitCode = 0) {
			output = "";
			expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(exitCode);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const key = "fragment/personal";
			const created = await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key, body: "Personal" } } });
			expect(created.isError).not.toBe(true);
			expect(await cli(["read", key])).toEqual(created.structuredContent);
			const duplicate = await client.callTool({ name: "instruction_update", arguments: { request: { action: "create_fragment", key, body: "Duplicate" } } });
			expect(duplicate.isError).toBe(true);
			expect(duplicate.structuredContent).toMatchObject({ reason: "already-exists", currentSource: created.structuredContent });
			const bodyPath = path.join(directory, "body.md");
			writeFileSync(bodyPath, "<!-- include:fragment/personal -->");
			await cli(["save", "skill/prepare", "--body-file", bodyPath, "--expected-revision", "1"]);
			const blocked = await client.callTool({ name: "instruction_update", arguments: { request: { action: "remove_fragment", key, expectedRevision: 1 } } });
			expect(blocked.isError).toBe(true);
			expect(blocked.structuredContent).toMatchObject({ reason: "referenced", affectedReferences: ["skill/prepare"] });
			expect(await cli(["fragment", "remove", key, "--expected-revision", "1"], 1)).toEqual(blocked.structuredContent);
			output = "";
			await expect(runCli(["instruction", "fragment", "remove", key, "--expected-revision", "1", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("skill/prepare");
			expect(output).toBe("");
			writeFileSync(bodyPath, "Prepare");
			await cli(["save", "skill/prepare", "--body-file", bodyPath, "--expected-revision", "2"]);
			writeFileSync(bodyPath, "Newer");
			const saved = await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "1"]);
			const stale = await client.callTool({ name: "instruction_update", arguments: { request: { action: "remove_fragment", key, expectedRevision: 1 } } });
			expect(stale.isError).toBe(true);
			expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: saved });
			expect(await cli(["fragment", "remove", key, "--expected-revision", "1"], 1)).toEqual(stale.structuredContent);
			expect(await cli(["fragment", "remove", key, "--expected-revision", "2"])).toMatchObject({ key, source: { revision: 3 } });
			const recreated = await cli(["fragment", "create", key, "--body-file", bodyPath]);
			expect((await readInstructionSource(client, key)).structuredContent).toEqual(recreated);
			const removed = await client.callTool({ name: "instruction_update", arguments: { request: { action: "remove_fragment", key, expectedRevision: 4 } } });
			expect(removed.isError).not.toBe(true);
			expect((await readInstructionSource(client, key)).isError).toBe(true);
			expect(await cli(["list"])).toMatchObject({ items: [{ key: "skill/prepare" }] });
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
		}
	});

	it("registers a tool for every included tracker data command", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = await client.listTools();

		expect(auditMcpToolRegistrations(tools.tools.map((tool) => tool.name))).toEqual({ missing: [] });
		expect(tools.tools.map((tool) => tool.name).filter((name) => name.startsWith("instruction_")).sort()).toEqual([
			"instruction_inspect", "instruction_reset", "instruction_retrieve", "instruction_update"
		]);
		const retrievalDescription = tools.tools.find((tool) => tool.name === "instruction_retrieve")?.description;
		expect(retrievalDescription).toContain("Retrieve the complete instructions for a skill or agent by key");
		expect(retrievalDescription).toContain("loader requires instruction_retrieve");
		expect(retrievalDescription).toContain("skill/start-work");
		expect(retrievalDescription).toContain("all required fragments included");
		expect(retrievalDescription).toContain("nextOffset is null");
		expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
			"issue_breakdown_create",
			"resource_show",
			"issue_breakdown_preview",
			"issue_breakdown_approve"
		]));

		await client.close();
		await server.close();
		await store.close();
	});

	it("validates instruction management requests before opening storage", async () => {
		const openStore = vi.fn(async () => { throw new Error("Storage must not open for invalid requests."); });
		const server = createMcpServer({ openStore });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-validation-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const request of [
				{ action: "read" }, { action: "compare" }, { action: "dependencies" }, { action: "history" },
				{ action: "revision", key: "skill/prepare", revision: 0 },
				{ action: "preview", key: "skill/prepare", changes: [] }, { action: "unknown" }
			]) {
				expect((await client.callTool({ name: "instruction_inspect", arguments: { request } })).isError).toBe(true);
			}
			for (const request of [
				{ action: "save", key: "skill/prepare", body: "Changed" },
				{ action: "commit", changes: [{ operation: "save", key: "skill/prepare", expectedRevision: 1 }] },
				{ action: "restore", key: "skill/prepare", revision: 1 },
				{ action: "create_fragment", key: "fragment/personal" },
				{ action: "remove_fragment", key: "fragment/personal", expectedRevision: 1.5 }, { action: "unknown" }
			]) {
				expect((await client.callTool({ name: "instruction_update", arguments: { request } })).isError).toBe(true);
			}
			for (const request of [
				{ scope: "one", phase: "inspect" }, { scope: "unknown", phase: "inspect" },
				{ scope: "one", phase: "apply", key: "skill/prepare", expectedRevision: 1 },
				{ scope: "all", phase: "apply", expectedRevisions: [] },
				{ scope: "all", phase: "apply", confirmationToken: randomUUID() },
				{ scope: "all", phase: "unknown" }
			]) {
				expect((await client.callTool({ name: "instruction_reset", arguments: { request } })).isError).toBe(true);
			}
			expect(openStore).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("rejects instruction reset tokens for a different scope or an expired inspection", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-reset-tokens-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "instructions.db"));
		const key = "skill/prepare";
		await store.importInstructionBundle({ version: packageJson.version, items: [{ key, kind: "skill", body: "Prepare" }] });
		await store.saveInstructionSource({ key, body: "Personal", expectedRevision: 1, version: packageJson.version });
		let now = 0;
		const server = createMcpServer({ openStore: async () => store, now: () => now });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-reset-token-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const scope of ["one", "all"] as const) {
				const inspected = await client.callTool({ name: "instruction_reset", arguments: { request: { scope, phase: "inspect", key } } });
				expect(inspected.isError).not.toBe(true);
				const { confirmationToken } = inspected.structuredContent as { confirmationToken: string };
				const request = scope === "one"
					? { scope: "all", phase: "apply", expectedRevisions: [{ key, sourceType: "override", expectedRevision: 2 }], confirmationToken }
					: { scope: "one", phase: "apply", key, expectedRevision: 2, confirmationToken };
				const rejected = await client.callTool({ name: "instruction_reset", arguments: { request } });
				expect(rejected.isError).toBe(true);
				expect(JSON.stringify(rejected.content)).toContain("Confirmation token does not authorize this request");
			}
			for (const scope of ["one", "all"] as const) {
				const inspected = await client.callTool({ name: "instruction_reset", arguments: { request: { scope, phase: "inspect", key } } });
				const { confirmationToken } = inspected.structuredContent as { confirmationToken: string };
				now += 5 * 60 * 1000;
				const request = scope === "one"
					? { scope, phase: "apply", key, expectedRevision: 2, confirmationToken }
					: { scope, phase: "apply", expectedRevisions: [{ key, sourceType: "override", expectedRevision: 2 }], confirmationToken };
				const rejected = await client.callTool({ name: "instruction_reset", arguments: { request } });
				expect(rejected.isError).toBe(true);
				expect(JSON.stringify(rejected.content)).toContain("Confirmation token has expired");
			}
			expect((await readInstructionSource(client, key)).structuredContent).toMatchObject({ body: "Personal", source: { revision: 2 } });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reads and saves the same instruction source through CLI and MCP with revision errors", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-instruction-management-"));
		directories.push(directory);
		const dbPath = path.join(directory, "instructions.db");
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({
			dbPath, homeDirectory: directory, credentialStoreOptions,
			instructionBundle: { version: packageJson.version, items: [
				{ key: "agent/agent-issues", kind: "agent", body: "Agent" },
				{ key: "skill/prepare", kind: "skill", body: "<!-- include:fragment/rules -->" },
				{ key: "fragment/rules", kind: "fragment", body: "Rules" }
			] }
		});
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "instruction-management-test", version: "1.0.0" });
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => { output += chunk.toString(); });
		async function cli(args: string[]) {
			output = "";
			expect(await runCli(["instruction", ...args, "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(0);
			return JSON.parse(output);
		}
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const listed = await client.callTool(collectionCall("instructionSource", {}));
			expect(listed.isError).not.toBe(true);
			const cliCatalog = await cli(["list"]) as { items: Array<{ body: string }> };
			const catalogPage = listed.structuredContent as { items: Array<{ reads: unknown }> };
			expect(catalogPage.items.map(({ reads: _reads, ...item }) => item)).toEqual(cliCatalog.items.map(({ body: _body, ...item }) => item));
			for (const key of ["agent/agent-issues", "skill/prepare", "fragment/rules"]) {
				const read = await readInstructionSource(client, key);
				expect(await cli(["read", key])).toEqual(read.structuredContent);
				const saved = await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key, body: "From MCP", expectedRevision: 1 } } });
				expect(saved.isError).not.toBe(true);
				expect(await cli(["read", key])).toEqual(saved.structuredContent);
				const bodyPath = path.join(directory, "body.md");
				writeFileSync(bodyPath, "From CLI\n");
				const cliSaved = await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "2"]);
				const current = await readInstructionSource(client, key);
				expect(current.structuredContent).toEqual(cliSaved);
				const stale = await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key, body: "Stale", expectedRevision: 2 } } });
				expect(stale.isError).toBe(true);
				expect(JSON.stringify(stale.content)).toContain("revision conflict");
				expect(stale.structuredContent).toMatchObject({ reason: "revision-conflict", currentSource: cliSaved });
				output = "";
				expect(await runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "2", "--db", dbPath, "--json"], { cwd: directory, stdout })).toBe(1);
				expect(JSON.parse(output)).toMatchObject({ reason: "revision-conflict", currentSource: cliSaved });
				output = "";
				await expect(runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "2", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow("revision conflict");
				expect(output).toBe("");
				const invalid = await client.callTool({ name: "instruction_update", arguments: { request: { action: "save", key, body: "<!-- include:fragment/missing -->", expectedRevision: 3 } } });
				expect(invalid.isError).toBe(true);
				expect(invalid.structuredContent).toMatchObject({ reason: "invalid-source", currentSource: cliSaved });
				expect((await readInstructionSource(client, key)).structuredContent).toEqual(cliSaved);
				writeFileSync(bodyPath, "<!-- include:fragment/missing -->");
				output = "";
				await expect(runCli(["instruction", "save", key, "--body-file", bodyPath, "--expected-revision", "3", "--db", dbPath], { cwd: directory, stdout })).rejects.toThrow(/fragment not found[\s\S]*revision 3/);
				expect(output).toBe("");
				writeFileSync(bodyPath, "");
				expect(await cli(["save", key, "--body-file", bodyPath, "--expected-revision", "3"])).toMatchObject({ body: "", source: { revision: 4 } });
				expect((await readInstructionSource(client, key)).structuredContent).toMatchObject({ body: "", source: { revision: 4 } });
			}
			const committed = await client.callTool({ name: "instruction_update", arguments: { request: { action: "commit", changes: [
				{ operation: "save", key: "skill/prepare", body: "Prepare <!-- include:fragment/rules -->", expectedRevision: 4 },
				{ operation: "save", key: "fragment/rules", body: "Atomic rules", expectedRevision: 4 }
			] } } });
			expect(committed.isError).not.toBe(true);
			expect(committed.structuredContent).toMatchObject({ changes: [
				{ operation: "save", source: { key: "skill/prepare", source: { revision: 5 } } },
				{ operation: "save", source: { key: "fragment/rules", source: { revision: 5 } } }
			] });
			expect((await client.callTool({ name: "instruction_retrieve", arguments: { key: "skill/prepare" } })).content).toContainEqual({ type: "text", text: "Prepare Atomic rules" });
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
		}
	});

	it("ships a self-contained Issue Preview resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.readResource({ uri: "ui://agent-issues/issue-preview.html" });
		const content = result.contents[0];
		const html = content && "text" in content ? content.text : "";
		expect(html).toContain("<issue-preview-app>");
		expect(html).toContain("<script type=\"module\">");
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toMatch(/<(?:img|link|script)[^>]+https?:\/\//i);

		await client.close();
		await server.close();
		await store.close();
	});

	it("serves the Plan Preview MCP App resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const resources = await client.listResources();
		const resource = resources.resources.find(({ uri }) => uri === "ui://agent-issues/plan-preview.html");
		expect(resource).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
		const tools = await client.listTools();
		const previewTool = tools.tools.find(({ name }) => name === "plan_preview");
		expect(previewTool?._meta).toMatchObject({ ui: { resourceUri: "ui://agent-issues/plan-preview.html" } });
		const confirmationTool = tools.tools.find(({ name }) => name === "plan_confirm");
		expect(confirmationTool?._meta).toBeUndefined();

		const result = await client.readResource({ uri: "ui://agent-issues/plan-preview.html" });
		expect(result.contents).toEqual([
			expect.objectContaining({ mimeType: "text/html;profile=mcp-app", text: expect.stringContaining("<plan-preview-app") })
		]);

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates an Issue Preview draft through the MCP server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({
			name: "issue_breakdown_create",
			arguments: {
				targetId: initiative.reference,
				issues: [{
					key: "child",
					title: "Test Issue Preview draft validation",
					outcome: "The preview can show hierarchy and a dependency.",
					scope: ["Create a child test issue in the draft."],
					workMode: "HITL",
					acceptanceCriteria: ["Issue Preview shows the parent and blocking relation."],
					parentKey: "parent",
					planEntryIds: ["PLAN_ENTRY_123"],
					relationReferences: [{ relationType: "blocks", targetKey: "parent" }]
				}, {
					key: "parent",
					title: "Test Issue Preview draft foundation",
					outcome: "The preview can show a parent test issue.",
					scope: ["Create a test-only draft record."],
					workMode: "AFK",
					acceptanceCriteria: ["Issue Preview shows this issue before creation."],
					relationReferences: []
				}]
			}
		});

		expect(result.structuredContent).toMatchObject({
			draft: expect.objectContaining({
				targetReference: initiative.reference,
				snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				issues: [
					expect.objectContaining({ key: "child", parentKey: "parent", planEntryIds: ["PLAN_ENTRY_123"] }),
					expect.objectContaining({ key: "parent" })
				]
			})
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("serves the Issue Preview MCP App resource and draft snapshot", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const draft = await store.createIssueBreakdownDraft({
			targetId: initiative.id,
			issues: [{
				key: "draft-storage",
				title: "Add draft storage",
				outcome: "Store the proposed graph.",
				scope: ["Add the draft store."],
				workMode: "AFK",
				acceptanceCriteria: ["A draft is retrievable."],
				parentKey: "issue-preview",
				planEntryIds: ["PLAN_ENTRY_123"],
				relationReferences: [{ relationType: "blocks", targetKey: "issue-preview" }]
			}]
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const resources = await client.listResources();
		expect(resources.resources).toEqual(expect.arrayContaining([
			expect.objectContaining({ uri: "ui://agent-issues/issue-preview.html", mimeType: "text/html;profile=mcp-app" })
		]));
		const tools = await client.listTools();
		expect(tools.tools.find(({ name }) => name === "issue_breakdown_preview")?._meta).toMatchObject({
			ui: { resourceUri: "ui://agent-issues/issue-preview.html" }
		});
		const result = await client.callTool({ name: "issue_breakdown_preview", arguments: { draftId: draft.id } });

		expect(result).toMatchObject({
			structuredContent: {
				draft: expect.objectContaining({
					id: draft.id,
					targetReference: initiative.reference,
					snapshotDigest: draft.snapshotDigest,
					issues: [expect.objectContaining({ key: "draft-storage", title: "Add draft storage" })]
				})
			}
		});
		const text = Array.isArray(result.content)
			? result.content.find((item): item is { type: "text"; text: string } =>
				typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
			)?.text ?? ""
			: "";
		expect(text).toContain(initiative.reference);
		expect(text).toContain(draft.snapshotDigest);
		expect(text).toContain("Add draft storage");
		expect(text).toContain("Store the proposed graph.");
		expect(text).toContain("Add the draft store.");
		expect(text).toContain("AFK");
		expect(text).toContain("A draft is retrievable.");
		expect(text).toContain("issue-preview");
		expect(text).toContain("Plan entries");
		expect(text).toContain("PLAN_ENTRY_123");
		expect(text).toContain("blocks");

		await client.close();
		await server.close();
		await store.close();
	});

	it("approves an Issue Preview draft through the MCP server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Issue Preview target" });
		const plan = await store.createEntity({ kind: "plan", title: "Approval Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Read without changing approval." });
		await store.confirmPlan({ planId: plan.id, snapshotDigest: projectProposedPlan((await store.getEntityDetails(plan.id)).entity, [await store.getPlanEntry({ entryId: entry.id })]).snapshotDigest });
		const draft = await store.createIssueBreakdownDraft({
			targetId: initiative.id,
			issues: [{
				key: "approval",
				title: "Approve the draft",
				outcome: "The server creates the issue.",
				scope: ["Create the approved issue."],
				workMode: "AFK",
				acceptanceCriteria: ["Approval returns its reference."],
				planEntryIds: [entry.id],
				relationReferences: []
			}]
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

			for (const [name, request] of [["planEntry", { planId: plan.id }], ["planEntryHistory", { entryId: entry.id }], ["resource_show", { entryId: entry.id }]] as const) {
			expect((await client.callTool(collectionCall(name, planDetailArguments(name, request)))).isError).not.toBe(true);
		}
		const result = await client.callTool({
			name: "issue_breakdown_approve",
			arguments: { draftId: draft.id, snapshotDigest: draft.snapshotDigest }
		});

		expect(result.structuredContent).toMatchObject({
			status: "approved",
			targetReference: initiative.reference,
			createdIssueReferences: [expect.any(String)]
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("ships a self-contained Plan Preview resource", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.readResource({ uri: "ui://agent-issues/plan-preview.html" });
		const content = result.contents[0];
		const html = content && "text" in content ? content.text : "";
		expect(html).toContain("<plan-preview-app>");
		expect(html).toContain("<script type=\"module\">");
		expect(html).not.toMatch(/<script[^>]+src=/i);
		expect(html).not.toMatch(/<(?:img|link|script)[^>]+https?:\/\//i);

		await client.close();
		await server.close();
		await store.close();
	});

	it("publishes Plan Preview in the CLI package files", () => {
		const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { files: string[] };
		expect(packageJson.files).toContain("dist");
		const previewScript = readFileSync(fileURLToPath(new URL("../../dist/plan-preview.js", import.meta.url)), "utf8");
		expect(previewScript).toContain("plan-preview-app");
		expect(previewScript).toContain("Plan ready");
	});

	it("reports the resolved project identity", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store, projectIdentity: "shared-product" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "project_identity", arguments: {} });

		expect(result).toMatchObject({ structuredContent: { projectIdentity: "shared-product" } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("reports a null project identity when no identity is configured", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "project_identity", arguments: {} });

		expect(result).toMatchObject({ structuredContent: { projectIdentity: null } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("resolves project identity from the client chat folder", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const chatFolder = path.join(directory, "chat-folder");
		mkdirSync(path.join(chatFolder, ".git"), { recursive: true });
		writeFileSync(
			path.join(chatFolder, ".git", "config"),
			`[remote "origin"]\n\turl = https://github.com/arcmantle/agent-issues.git\n`
		);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		let seenScope: { projectIdentity?: string; workspaceRoot?: string } | undefined;
		const server = createMcpServer({
			fallbackWorkspaceRoot: path.join(directory, "wrong-home"),
			openStore: async (scope) => {
				seenScope = scope;
				return store;
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" }, { capabilities: { roots: {} } });
		client.setRequestHandler(ListRootsRequestSchema, async () => ({
			roots: [{ uri: pathToFileURL(chatFolder).href }]
		}));

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const identity = await client.callTool({ name: "project_identity", arguments: {} });
		await client.callTool({ name: "resource_create", arguments: { request: { resource: "entity", kind: "issue", title: "Scoped to chat folder" } } });

		expect(identity).toMatchObject({ structuredContent: { projectIdentity: "agent-issues", workspaceRoot: chatFolder } });
		expect(seenScope).toEqual({ projectIdentity: "agent-issues", workspaceRoot: chatFolder });

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates an entity through resource_create", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "resource_create", arguments: { request: { resource: "entity", kind: "issue", title: "Create through MCP", body: "Authored body" } } });

		expect(result).toMatchObject({ structuredContent: { entity: { kind: "issue", title: "Create through MCP" } } });
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");

		await client.close();
		await server.close();
		await store.close();
	});

	it("rejects invalid resource_create requests", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const invalidRequests = [
			{ resource: "entity", kind: "unsupported-kind", title: "Invalid entity" },
			{ resource: "comment", issueId: "missing-issue", body: "" },
			{ resource: "planEntry", planId: "missing-plan", role: "unsupported-role", body: "Invalid Plan entry" }
		];
		for (const request of invalidRequests) {
			const result = await client.callTool({ name: "resource_create", arguments: { request } });
			expect(result.isError).toBe(true);
		}

		await client.close();
		await server.close();
		await store.close();
	});

	it("edits an entity through resource_edit with its expected revision", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const entity = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({
			name: "resource_edit",
			arguments: {
				request: {
					resource: "entity",
					entityId: entity.reference,
					title: "Edited title",
					expectedRevision: entity.revision,
					expectedContentHash: entity.contentHash
				}
			}
		});

		expect(result).toMatchObject({ structuredContent: { entity: { reference: entity.reference, title: "Edited title", revision: 2 } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("discovers the entity and graph command tools", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = await client.listTools();

		expect(tools.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"resource_create",
				"resource_edit",
				"entity_archive",
				"resource_delete",
						"resource_history",
				"resource_list",
				"entity_move",
				"entity_restore",
				"resource_show",
				"entity_status",
				"relation_link",
				"relation_unlink",
				"relation_query",
				"initiative_bundle",
				"entity_next_work",
				"resource_body"
			])
		);
		const toolNames = tools.tools.map((tool) => tool.name);
		for (const name of [
			"entity_create", "comment_create", "plan_entry_create", "entity_edit", "comment_edit", "plan_entry_edit", "context_set",
			"entity_delete_inspect", "entity_delete", "tenant_delete_inspect", "tenant_delete",
			"comment_delete", "plan_entry_delete", "context_term_forget"
		]) {
			expect(toolNames).not.toContain(name);
		}

		await client.close();
		await server.close();
		await store.close();
	});

	it.each([120, 0])("reads complete byte-bounded initiative sections (%i issues)", async (issueCount) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-combined-pages-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "combined.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Combined reads", body: "Full source.\n".repeat(2_000) });
		const expected: string[] = [];
		for (let index = 0; index < issueCount; index++) {
			const issue = await store.createEntity({ kind: "issue", title: `Work ${index}`, body: "Full source.\n".repeat(2_000), parentId: initiative.id });
			expected.push(issue.id);
		}
		if (issueCount > 0) {
			const prd = await store.createEntity({ kind: "prd", title: "Shared outcomes", parentId: initiative.id, body: "Full source.\n".repeat(2_000) });
			const story = await store.createEntity({ kind: "userStory", title: "Read complete work", parentId: prd.id, body: "Full source.\n".repeat(2_000) });
			const adr = await store.createEntity({ kind: "adr", title: "Read constraints", parentId: initiative.id, body: "Full source.\n".repeat(2_000) });
			await store.createEntity({ kind: "plan", title: "Read Plan", parentId: initiative.id, body: "Full source.\n".repeat(2_000) });
			await store.linkEntities({ fromId: expected[0], relationType: "fixes", toId: story.id });
			await store.linkEntities({ fromId: expected[0], relationType: "decomposes", toId: expected[1] });
			await store.linkEntities({ fromId: expected[0], relationType: "blocks", toId: expected[2] });
			await store.linkEntities({ fromId: adr.id, relationType: "constrains", toId: expected[0] });
		}
		const expectedBundle = await store.getInitiativeBundle(initiative.id);
		const sections: Record<string, unknown[]> = {};
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "combined-pages-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const actual: string[] = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(collectionCall("initiative_bundle", {
					initiativeId: initiative.reference,
					...(continuation === null ? {} : { continuation })
				}));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { issues: Array<{ id: string; body?: string }>; nextContinuation: string | null };
				for (const [section, items] of Object.entries(result.structuredContent!)) {
					if (Array.isArray(items)) (sections[section] ??= []).push(...items);
				}
				expect(JSON.stringify(result.structuredContent)).not.toContain("Full source.");
				for (const issue of page.issues) {
					expect(issue).not.toHaveProperty("body");
					actual.push(issue.id);
				}
				continuation = page.nextContinuation;
				expect(continuation === null || typeof continuation === "string").toBe(true);
				expect(++pageCount).toBeLessThan(100);
			} while (continuation !== null);
			expect(actual.slice().sort()).toEqual(expected.sort());
			const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => ["body", "bodySource", "reads"].includes(key) ? undefined : item));
			for (const [section, items] of Object.entries(expectedBundle)) {
				if (!Array.isArray(items)) continue;
				expect(sections[section]).toHaveLength(items.length);
				expect(normalize(sections[section])).toEqual(expect.arrayContaining(normalize(items)));
			}
			if (issueCount > 0) expect(pageCount).toBeGreaterThan(1);
			else expect(pageCount).toBe(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("binds initiative continuation and reads changed later records", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-combined-continuation-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "combined.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Continuation" });
		const issues: Array<Awaited<ReturnType<typeof store.createEntity>>> = [];
		for (let index = 0; index < 16; index++) issues.push(await store.createEntity({ kind: "issue", title: `Work ${index} ${"summary ".repeat(300)}`, parentId: initiative.id }));
		issues.sort((first, second) => first.id < second.id ? -1 : 1);
		const other = await store.createEntity({ kind: "initiative", title: "Other scope" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "combined-continuation-test", version: "1.0.0" });
		const request = { initiativeId: initiative.reference };
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = (await client.callTool(collectionCall("initiative_bundle", request))).structuredContent as { nextContinuation: string };
			expect(first.nextContinuation).toEqual(expect.any(String));
			for (const continuation of ["invalid", `${first.nextContinuation}x`]) {
				const result = await client.callTool(collectionCall("initiative_bundle", { ...request, continuation }));
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			expect((await client.callTool(collectionCall("initiative_bundle", { initiativeId: other.reference, continuation: first.nextContinuation }))).isError).toBe(true);
			expect((await client.callTool({ name: "relation_query", arguments: { entityId: initiative.reference, continuation: first.nextContinuation } })).isError).toBe(true);
			const last = issues.at(-1)!;
			await store.updateEntity({ entityId: last.id, title: "Changed later record", expectedRevision: last.revision, expectedContentHash: last.contentHash });
			let continuation: string | null = first.nextContinuation;
			let changed = false;
			let pageCount = 0;
			while (continuation !== null) {
				const result = await client.callTool(collectionCall("initiative_bundle", { ...request, continuation }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { entities: Array<{ id: string; title: string }>; nextContinuation: string | null };
				changed ||= page.entities.some((record) => record.id === last.id && record.title === "Changed later record");
				continuation = page.nextContinuation;
				expect(++pageCount).toBeLessThan(100);
			}
			expect(changed).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([
		["initiative_bundle", "initiative"], ["entity_next_work", "initiative"], ["entity_next_work", "candidate"]
	] as const)("rejects oversized %s %s metadata without partial data", async (tool, oversized) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-combined-oversized-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "combined.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: oversized === "initiative" ? "title ".repeat(16_000) : "Candidate budget" });
		if (oversized === "candidate") await store.createEntity({ kind: "issue", title: "title ".repeat(16_000), parentId: initiative.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "combined-oversized-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool(collectionCall(tool, tool === "initiative_bundle" ? { initiativeId: initiative.reference } : { scopeId: initiative.reference }));
			expect(result.isError).toBe(true);
			expect(result).not.toHaveProperty("structuredContent");
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(`agent-issues ${tool === "initiative_bundle" ? "show" : "next-work"} ${initiative.reference} --json`) }]);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("returns bounded next-work candidates in unblock order without a server recommendation", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-work-candidates-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "work.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Candidate selection" });
		const issues: Array<Awaited<ReturnType<typeof store.createEntity>>> = [];
		for (let index = 0; index < 12; index++) {
			issues.push(await store.createEntity({ kind: "issue", title: `Candidate ${index}`, body: "Read only when needed.", parentId: initiative.id }));
		}
		const firstBlocked = await store.createEntity({ kind: "issue", title: "First blocked issue", parentId: initiative.id });
		const secondBlocked = await store.createEntity({ kind: "issue", title: "Second blocked issue", parentId: initiative.id });
		await store.linkEntities({ fromId: issues[11].id, relationType: "blocks", toId: firstBlocked.id });
		await store.linkEntities({ fromId: issues[11].id, relationType: "blocks", toId: secondBlocked.id });
		await store.linkEntities({ fromId: issues[10].id, relationType: "blocks", toId: firstBlocked.id });
		const expected = [issues[11], issues[10], ...issues.slice(0, 10).sort((first, second) => first.id < second.id ? -1 : 1)];
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "work-candidates-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const limit of [undefined, 1, 20]) {
				const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: issues[0].reference, ...(limit === undefined ? {} : { limit }) } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const response = result.structuredContent as {
					available: Array<{ issue: { id: string; reads: { body: { tool: string } } }; unfinishedUnblockCount: number }>;
					counts: { available: number; blocked: number };
					hasMore: boolean;
				};
				expect(response.available.map((item) => item.issue.id)).toEqual(expected.slice(0, limit ?? 5).map((issue) => issue.id));
				expect(response.available[0].unfinishedUnblockCount).toBe(2);
				expect(response.counts).toEqual({ available: 12, blocked: 2 });
				expect(response.hasMore).toBe((limit ?? 5) < 12);
				for (const field of ["recommendation", "blocked", "blockerLinks", "unblockLinks", "nextContinuation"]) expect(response).not.toHaveProperty(field);
				for (const candidate of response.available) {
					expect(candidate.issue).not.toHaveProperty("body");
					expect(candidate.issue.reads.body.tool).toBe("resource_body");
					expect(candidate).not.toHaveProperty("unblocks");
				}
			}
			for (const limit of [0, 21, 1.5, "5"]) {
				const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: initiative.reference, limit } });
				expect(result.isError).toBe(true);
				expect(result).not.toHaveProperty("structuredContent");
			}
			const tool = (await client.listTools()).tools.find((item) => item.name === "entity_next_work")!;
			expect(tool.inputSchema.properties).not.toHaveProperty("continuation");
			expect(tool.inputSchema.properties).toHaveProperty("limit", expect.objectContaining({ minimum: 1, maximum: 20, default: 5 }));
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([true, false])("returns next-work counts without dependency collections (internal blockers %s)", async (internalBlockers) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-work-blockers-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "work.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Many blockers" });
		const blocked = await store.createEntity({ kind: "issue", title: "Blocked work", parentId: initiative.id });
		const blockers: string[] = [];
		for (let index = 0; index < 90; index++) {
			const blocker = await store.createEntity({ kind: "issue", title: `Blocker ${index}`, ...(internalBlockers ? { parentId: initiative.id } : {}) });
			blockers.push(blocker.reference);
			await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: blocked.id });
		}
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "work-blockers-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: initiative.reference } });
			expect(result.isError).not.toBe(true);
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			const response = result.structuredContent as {
				available: Array<{ issue: { reference: string }; unfinishedUnblockCount: number }>;
				counts: { available: number; blocked: number };
				hasMore: boolean;
			};
			expect(response.counts).toEqual({ available: internalBlockers ? 90 : 0, blocked: 1 });
			expect(response.available).toHaveLength(internalBlockers ? 5 : 0);
			expect(response.hasMore).toBe(internalBlockers);
			for (const item of response.available) {
				expect(blockers).toContain(item.issue.reference);
				expect(item.unfinishedUnblockCount).toBe(1);
			}
			for (const field of ["recommendation", "blocked", "blockerLinks", "unblockLinks", "nextContinuation"]) expect(response).not.toHaveProperty(field);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([undefined, 2])("reads all entity summaries through byte-bounded pages (limit %s)", async (limit) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-pages-"));
		directories.push(directory);
		const dbPath = path.join(directory, "entities.db");
		const { store } = await openSqliteStore(dbPath);
		const expected: string[] = [];
		for (let index = 0; index < 24; index++) {
			const entity = await store.createEntity({ kind: "issue", title: `Issue ${index} ${"Read this summary. ".repeat(100)}`, body: "Complete body.\n".repeat(1_000) });
			expected.push(entity.id);
		}
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({ dbPath, homeDirectory: directory, credentialStoreOptions });
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const client = new Client({ name: "entity-pages-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const actual: string[] = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(collectionCall("entity", {
					kind: "issue", ...(limit === undefined ? {} : { limit }), ...(continuation === null ? {} : { continuation })
				}));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { entities: Array<{ id: string; reads: { body: { tool: string; arguments: { entityId: string } } } }>; nextContinuation: string | null };
				expect(page.entities.length).toBeGreaterThan(0);
				if (limit !== undefined) expect(page.entities.length).toBeLessThanOrEqual(limit);
				for (const entity of page.entities) {
					expect(entity).not.toHaveProperty("body");
					expect(entity.reads.body.tool).toBe("resource_body");
					actual.push(entity.id);
				}
				continuation = page.nextContinuation;
				expect(continuation === null || typeof continuation === "string").toBe(true);
				expect(++pageCount).toBeLessThan(30);
			} while (continuation !== null);
			expect(actual).toEqual(expected.sort());
			expect(pageCount).toBeGreaterThan(1);
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
			await store.close();
		}
	});

	it("binds entity collection continuation to resource, request, owner, project, and server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-continuation-"));
		directories.push(directory);
		const dbPath = path.join(directory, "entities.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: otherStore } = await openSqliteStore(dbPath, { tenant: "other-owner" });
		let activeStore = store;
		let workspaceRoot = path.join(directory, "first-project");
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(path.join(directory, "second-project"), { recursive: true });
		const issue = await store.createEntity({ kind: "issue", title: "First" });
		await store.createEntity({ kind: "issue", title: "Second" });
		const initiative = await store.createEntity({ kind: "initiative", title: "Collection scope" });
		const plan = await store.createEntity({ kind: "plan", title: "Collection Plan", parentId: initiative.id });
		const server = createMcpServer({ openStore: async () => activeStore });
		const client = new Client({ name: "entity-continuation-test", version: "1.0.0" }, { capabilities: { roots: {} } });
		client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspaceRoot).href }] }));
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool(collectionCall("entity", { kind: "issue", limit: 1 }));
			const { nextContinuation: continuation } = first.structuredContent as { nextContinuation: string };
			expect(typeof continuation).toBe("string");
			const request = { kind: "issue", limit: 1, continuation };
			const expectInvalid = async (argumentsValue: Record<string, unknown>, resource = "entity") => {
				const result = await client.callTool(collectionCall(resource, argumentsValue));
				expect(result.isError).toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(result.structuredContent).toBeUndefined();
			};
			for (const change of [
				{ kind: "initiative" }, { statuses: ["done"] }, { parentId: "other-parent" }, { limit: 2 },
				{ continuation: "invalid" }, { continuation: `${continuation.slice(0, -1)}!` },
				{ continuation: "x".repeat(3_000) }
			]) await expectInvalid({ ...request, ...change });
			for (const [resource, otherRequest] of [
				["orphanEntity", { kind: "issue", continuation }],
				["planEntry", { planId: plan.reference, continuation }],
				["context", { continuation }],
				["contextDirectory", { continuation }],
				["comment", { issueId: issue.reference, before: continuation }],
				["tenant", { continuation }]
			] as const) await expectInvalid(otherRequest, resource);
			activeStore = otherStore;
			await expectInvalid(request);
			activeStore = store;
			workspaceRoot = path.join(directory, "second-project");
			await expectInvalid(request);
			workspaceRoot = path.join(directory, "first-project");
			const valid = await client.callTool(collectionCall("entity", request));
			expect(valid).toMatchObject({ structuredContent: { entities: [expect.any(Object)], nextContinuation: null } });
			expect(await client.callTool(collectionCall("entity", request))).toEqual(valid);
			const otherServer = createMcpServer({ openStore: async () => store });
			const otherClient = new Client({ name: "other-server-test", version: "1.0.0" });
			const [otherClientTransport, otherServerTransport] = InMemoryTransport.createLinkedPair();
			try {
				await otherServer.connect(otherServerTransport);
				await otherClient.connect(otherClientTransport);
				const replay = await otherClient.callTool(collectionCall("entity", request));
				expect(replay.isError).toBe(true);
			} finally {
				await otherClient.close();
				await otherServer.close();
			}
		} finally {
			await client.close();
			await server.close();
			await otherStore.close();
			await store.close();
		}
	});

	it("keeps entity-list traversal stable when records change between pages", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-mutations-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "entities.db"));
		const parent = await store.createEntity({ kind: "initiative", title: "Parent" });
		const entities: Array<Awaited<ReturnType<typeof store.createEntity>>> = [];
		for (let index = 0; index < 12; index++) {
			entities.push(await store.createEntity({ kind: "issue", title: `Issue ${index}`, parentId: parent.id }));
		}
		entities.sort((first, second) => first.id < second.id ? -1 : 1);
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "entity-mutations-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = { kind: "issue", parentId: parent.reference, statuses: ["todo"], limit: 2 };
			let continuation: string | null = null;
			const seen: string[] = [];
			while (seen.length < 6) {
				const result = await client.callTool(collectionCall("entity", { ...request, ...(continuation ? { continuation } : {}) }));
				const page = result.structuredContent as { entities: Array<{ id: string }>; nextContinuation: string | null };
				seen.push(...page.entities.map((entity) => entity.id));
				continuation = page.nextContinuation;
			}
			const after = seen.at(-1)!;
			await store.deleteEntity({ entityId: seen[0] });
			let insertedBefore = false;
			for (let index = 0; index < 100 && !insertedBefore; index++) {
				const inserted = await store.createEntity({ kind: "issue", title: "Inserted", parentId: parent.id });
				insertedBefore = inserted.id < after;
			}
			expect(insertedBefore).toBe(true);
			await store.updateEntityStatus({ entityId: entities[7].id, status: "done" });
			await store.updateEntity({ entityId: entities[8].id, title: "Changed title", expectedRevision: entities[8].revision, expectedContentHash: entities[8].contentHash });
			const current = await store.queryEntities({ kind: "issue", parentId: parent.id, statuses: ["todo"] });
			const expected = current.entities.filter((entity) => entity.id > after).map((entity) => entity.id).sort();
			const remaining: Array<{ id: string; title: string }> = [];
			let pageCount = 0;
			do {
				const result = await client.callTool(collectionCall("entity", { ...request, continuation }));
				expect(result.isError).not.toBe(true);
				const page = result.structuredContent as { entities: Array<{ id: string; title: string }>; nextContinuation: string | null };
				remaining.push(...page.entities);
				continuation = page.nextContinuation;
				expect(++pageCount).toBeLessThan(15);
			} while (continuation !== null);
			expect(remaining.map((entity) => entity.id)).toEqual(expected);
			expect(remaining.find((entity) => entity.id === entities[8].id)?.title).toBe("Changed title");
			expect(remaining.every((entity) => !seen.includes(entity.id))).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["empty", "oversized summary", "oversized error"])("returns bounded entity-list outcomes for %s", async (scenario) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-entity-page-errors-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "entities.db"));
		const entity = scenario === "oversized summary"
			? await store.createEntity({ kind: "issue", title: "\u{1F680}\"\\".repeat(12_000) })
			: undefined;
		const server = createMcpServer({ openStore: async () => {
			if (scenario === "oversized error") throw new Error("Storage unavailable. ".repeat(3_000));
			return store;
		} });
		const client = new Client({ name: "entity-page-errors-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool(collectionCall("entity", { kind: "issue" }));
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			if (scenario === "empty") {
				expect(result.isError).not.toBe(true);
				expect(result.structuredContent).toEqual({ entities: [], nextContinuation: null });
			} else {
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				if (entity) expect((result.content as Array<{ text: string }>)[0].text).toContain(`agent-issues show ${entity.reference} --json`);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("runs entity lifecycle queries and mutations", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const firstParent = await store.createEntity({ kind: "initiative", title: "First parent" });
		const secondParent = await store.createEntity({ kind: "initiative", title: "Second parent" });
		const issue = await store.createEntity({ kind: "issue", title: "Lifecycle issue", body: "Lifecycle body", parentId: firstParent.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const status = await client.callTool({ name: "entity_status", arguments: { entityId: issue.reference, status: "in-progress" } });
		const move = await client.callTool({ name: "entity_move", arguments: { entityId: issue.reference, newParentId: secondParent.reference } });
		const history = await client.callTool(historyCall("entity", "revision", { entityId: issue.reference, revision: 1 }));
		const list = await client.callTool(collectionCall("entity", { kind: "issue", parentId: secondParent.reference }));
		const relations = await client.callTool({ name: "relation_query", arguments: { entityId: issue.reference } });
		const archive = await client.callTool({ name: "entity_archive", arguments: { entityId: issue.reference } });

		expect(status).toMatchObject({ structuredContent: { entity: { reference: issue.reference, status: "in-progress" } } });
		expect((status.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((status.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
		expect(move).toMatchObject({ structuredContent: { entity: { reference: issue.reference }, newParentId: secondParent.id } });
		expect((move.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((move.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
		expect(history).toMatchObject({ structuredContent: { entityId: issue.reference, targetRevision: 1 } });
		const historicalEntity = history.structuredContent as { reference: string; reads: { body: { tool: string; arguments: Record<string, unknown> } } };
		expect(historicalEntity.reference).toBe(issue.reference);
		expect((await client.callTool({ name: historicalEntity.reads.body.tool, arguments: historicalEntity.reads.body.arguments })).content).toContainEqual({ type: "text", text: "Lifecycle body" });
		expect((await client.callTool(historyCall("entity", "revision", { entityId: issue.reference, revision: 99 }))).isError).toBe(true);
		expect(list).toMatchObject({ structuredContent: { entities: [expect.objectContaining({ reference: issue.reference })] } });
		expect((list.structuredContent as { entities: object[] }).entities[0]).not.toHaveProperty("body");
		expect((list.structuredContent as { entities: object[] }).entities[0]).not.toHaveProperty("bodySource");
		expect((relations.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((relations.structuredContent as { incoming: Array<{ entity: object }> }).incoming[0]?.entity).not.toHaveProperty("body");
		expect(archive).toMatchObject({ structuredContent: { entity: { reference: issue.reference, status: "done" } } });
		expect((archive.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((archive.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");

		await client.close();
		await server.close();
		await store.close();
	});

	it("records a workspace observation when the MCP status tool completes an issue", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Observed completion" });
		const server = createMcpServer({ fallbackWorkspaceRoot: directory, openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			await client.callTool({ name: "entity_status", arguments: { entityId: issue.id, status: "done" } });
			expect((await store.getEntityDetails(issue.id)).completionObservations).toEqual([
				expect.objectContaining({
					completionOrdinal: 1,
					calculatedVersionState: "unknown",
					diagnostics: [{ code: "workspace-observation-failed", message: expect.any(String) }]
				})
			]);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("deletes an entity through resource_delete after inspection", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Delete through MCP" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "entity", action: "inspect", entityId: issue.reference } }
		});
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "entity", action: "delete", entityId: issue.reference, confirmationToken } }
		});

		expect(inspection).toMatchObject({ structuredContent: { impact: { entity: { reference: issue.reference } }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { entity: { reference: issue.reference }, removed: true } });
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("bodySource");
		await expect(store.getEntityDetails(issue.reference)).rejects.toThrow();

		await client.close();
		await server.close();
		await store.close();
	});

	it("runs relation and initiative graph queries", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Graph initiative" });
		const source = await store.createEntity({ kind: "issue", title: "Source", body: "Large graph body\n".repeat(4_000), parentId: initiative.id });
		const target = await store.createEntity({ kind: "issue", title: "Target", parentId: initiative.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });
		const bundleReads = vi.spyOn(store, "getInitiativeBundle");

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const linked = await client.callTool({ name: "relation_link", arguments: { fromId: source.reference, relationType: "blocks", toId: target.reference } });
		const relations = await client.callTool({ name: "relation_query", arguments: { entityId: source.reference, direction: "outgoing", types: ["blocks"] } });
		const bundleIssues: Array<{ reference: string }> = [];
		let continuation: string | null = null;
		let graphPages = 0;
		do {
			const bundle = await client.callTool({ name: "initiative_bundle", arguments: { initiativeId: initiative.reference, ...(continuation ? { continuation } : {}) } });
			expect(bundle.isError).not.toBe(true);
			const page = bundle.structuredContent as { initiative: { reference: string }; issues: Array<{ reference: string }>; nextContinuation: string | null };
			expect(page.initiative.reference).toBe(initiative.reference);
			bundleIssues.push(...page.issues);
			continuation = page.nextContinuation;
			expect(++graphPages).toBeLessThan(20);
		} while (continuation !== null);
		const shown = await client.callTool({ name: "resource_show", arguments: { request: { resource: "entity", reference: initiative.reference } } });
		const unlinked = await client.callTool({ name: "relation_unlink", arguments: { fromId: source.reference, relationType: "blocks", toId: target.reference } });

		expect(linked).toMatchObject({ structuredContent: { created: true } });
		expect(relations).toMatchObject({ structuredContent: { outgoing: [expect.objectContaining({ entity: expect.objectContaining({ reference: target.reference }) })] } });
		expect(bundleIssues).toEqual(expect.arrayContaining([expect.objectContaining({ reference: source.reference })]));
		expect(shown.isError).not.toBe(true);
		expect(Buffer.byteLength(JSON.stringify(shown), "utf8")).toBeLessThanOrEqual(65536);
		expect(shown).toMatchObject({ structuredContent: {
			entity: { reference: initiative.reference, kind: "initiative", revision: initiative.revision },
			reads: { body: { tool: "resource_body", arguments: { request: { resource: "entity", ...{ entityId: initiative.reference } } } } }
		} });
		expect(Object.keys(shown.structuredContent!)).toEqual(["entity", "reads"]);
		expect(bundleReads).toHaveBeenCalledTimes(graphPages);
		bundleReads.mockRestore();
		expect(unlinked).toMatchObject({ structuredContent: { removed: true } });

		await client.close();
		await server.close();
		await store.close();
	});

	it.each([["incoming", 24], ["outgoing", 24], ["both", 24], ["both", 0]] as const)("reads complete bounded relation pages (%s, %i links)", async (direction, linkCount) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-relation-pages-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "relations.db"));
		const anchor = await store.createEntity({ kind: "issue", title: "Relation anchor", body: "Large source body\n".repeat(2_000) });
		const expected: string[] = [];
		for (let index = 0; index < linkCount; index++) {
			const neighbor = await store.createEntity({ kind: "issue", title: `Neighbor ${index} ${"title ".repeat(560)}`, body: "Large related body\n".repeat(2_000) });
			const edgeDirection = index % 2 === 0 ? "incoming" : "outgoing";
			await store.linkEntities({ fromId: edgeDirection === "incoming" ? neighbor.id : anchor.id, relationType: "blocks", toId: edgeDirection === "incoming" ? anchor.id : neighbor.id });
			if (direction === "both" || direction === edgeDirection) expected.push(`${edgeDirection}:${neighbor.reference}`);
		}
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "relation-pages-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const seen: string[] = [];
			const keys: string[] = [];
			let pages = 0;
			do {
				const result = await client.callTool({ name: "relation_query", arguments: { entityId: anchor.reference, direction, types: ["blocks"], ...(continuation ? { continuation } : {}) } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { incoming: Array<{ relationType: string; entity: { id: string; reference: string } }>; outgoing: Array<{ relationType: string; entity: { id: string; reference: string } }>; nextContinuation: string | null };
				for (const edgeDirection of ["incoming", "outgoing"] as const) {
					for (const edge of page[edgeDirection]) {
						expect(edge.relationType).toBe("blocks");
						expect(edge.entity).not.toHaveProperty("body");
						seen.push(`${edgeDirection}:${edge.entity.reference}`);
						keys.push(JSON.stringify([edgeDirection, edge.relationType, edge.entity.id]));
					}
				}
				expect(page.nextContinuation === null || typeof page.nextContinuation === "string").toBe(true);
				continuation = page.nextContinuation;
				pages++;
				expect(pages).toBeLessThan(25);
			} while (continuation !== null);
			if (linkCount === 0) expect(pages).toBe(1);
			else expect(pages).toBeGreaterThan(1);
			expect(seen.toSorted()).toEqual(expected.toSorted());
			expect(new Set(seen).size).toBe(seen.length);
			expect(keys).toEqual(keys.toSorted());
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("pages linked Plan provenance without embedding entry bodies", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-relation-provenance-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "relations.db"));
		const anchor = await store.createEntity({ kind: "issue", title: "Anchor" });
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Linked Plan", parentId: initiative.id });
		const expected: string[] = [];
		for (let index = 0; index < 100; index++) {
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: `Decision ${index}\n${"Complete decision text\n".repeat(2_000)}`, referencedEntityIds: [anchor.id] });
			expected.push(entry.reference);
		}
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "relation-provenance-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			let pages = 0;
			const seen: string[] = [];
			do {
				const result = await client.callTool({ name: "relation_query", arguments: { entityId: anchor.reference, direction: "outgoing", types: ["blocks"], ...(continuation ? { continuation } : {}) } });
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { planEntries: Array<{ reference: string; reads: { details: { tool: string; arguments: Record<string, unknown> } } }>; nextContinuation: string | null };
				for (const entry of page.planEntries) {
					expect(entry).not.toHaveProperty("body");
					expect(entry.reads.details).toEqual({ tool: "resource_show", arguments: { request: { resource: "planEntry", view: "details", entryId: entry.reference, revision: 1 } } });
					const details = await client.callTool({ name: entry.reads.details.tool, arguments: entry.reads.details.arguments });
					expect(details.isError).not.toBe(true);
					expect(JSON.parse((details.content as Array<{ text: string }>)[1].text)).toMatchObject({ reference: entry.reference, revision: 1, referencedEntityIds: [anchor.id] });
					seen.push(entry.reference);
				}
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(13);
			} while (continuation !== null);
			expect(pages).toBeGreaterThan(1);
			expect(seen.toSorted()).toEqual(expected.toSorted());
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("binds relation continuation to the entity, direction, filters, and server", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-relation-cursor-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "relations.db"));
		const anchor = await store.createEntity({ kind: "issue", title: "Anchor" });
		const other = await store.createEntity({ kind: "issue", title: "Other" });
		for (let index = 0; index < 8; index++) {
			const neighbor = await store.createEntity({ kind: "issue", title: `Neighbor ${index} ${"summary ".repeat(800)}` });
			await store.linkEntities({ fromId: anchor.id, relationType: "blocks", toId: neighbor.id });
		}
		const server = createMcpServer({ openStore: async () => store });
		const otherServer = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "relation-cursor-test", version: "1.0.0" });
		const otherClient = new Client({ name: "other-relation-cursor-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const [otherClientTransport, otherServerTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			await otherServer.connect(otherServerTransport);
			await otherClient.connect(otherClientTransport);
			const tools = await client.listTools();
			expect(tools.tools.find((tool) => tool.name === "relation_query")?.inputSchema.properties?.types).toMatchObject({ type: "array", items: { type: "string", minLength: 1 } });
			const request = { entityId: anchor.reference, direction: "outgoing", types: ["blocks"] };
			const first = await client.callTool({ name: "relation_query", arguments: request });
			const continuation = (first.structuredContent as { nextContinuation: string }).nextContinuation;
			expect(continuation).toEqual(expect.any(String));
			for (const argumentsValue of [
				{ ...request, continuation: "invalid" },
				{ ...request, continuation: `${continuation.slice(0, -1)}!` },
				{ ...request, continuation, entityId: other.reference },
				{ ...request, continuation, direction: "incoming" },
				{ ...request, continuation, types: ["tracks"] },
				{ ...request, types: Array(200).fill("") },
				{ ...request, types: Array(200).fill(123) }
			]) {
				const result = await client.callTool({ name: "relation_query", arguments: argumentsValue });
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			const crossServer = await otherClient.callTool({ name: "relation_query", arguments: { ...request, continuation } });
			expect(crossServer.isError).toBe(true);
			const normalized = await client.callTool({ name: "relation_query", arguments: { ...request, entityId: anchor.id, types: ["blocks", "blocks"], continuation } });
			expect(normalized.isError).not.toBe(true);
		} finally {
			await client.close();
			await otherClient.close();
			await server.close();
			await otherServer.close();
			await store.close();
		}
	});

	it("keeps relation item-key traversal stable after links change", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-relation-live-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "relations.db"));
		const anchor = await store.createEntity({ kind: "issue", title: "Anchor" });
		const neighbors = [];
		for (let index = 0; index < 12; index++) neighbors.push(await store.createEntity({ kind: "issue", title: `Neighbor ${index} ${"summary ".repeat(800)}` }));
		neighbors.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
		for (const neighbor of neighbors.slice(1, -1)) await store.linkEntities({ fromId: anchor.id, relationType: "blocks", toId: neighbor.id });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "relation-live-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = { entityId: anchor.reference, direction: "outgoing", types: ["blocks"] };
			const first = await client.callTool({ name: "relation_query", arguments: request });
			const firstPage = first.structuredContent as { outgoing: Array<{ entity: { id: string } }>; nextContinuation: string };
			expect(firstPage.nextContinuation).toEqual(expect.any(String));
			const seen = firstPage.outgoing.map((edge) => edge.entity.id);
			await store.unlinkEntities({ fromId: anchor.id, relationType: "blocks", toId: seen[0] });
			await store.linkEntities({ fromId: anchor.id, relationType: "blocks", toId: neighbors[0].id });
			await store.linkEntities({ fromId: anchor.id, relationType: "blocks", toId: neighbors.at(-1)!.id });
			const removed = neighbors.at(-2)!;
			await store.unlinkEntities({ fromId: anchor.id, relationType: "blocks", toId: removed.id });
			let continuation: string | null = firstPage.nextContinuation;
			let pages = 0;
			do {
				const result = await client.callTool({ name: "relation_query", arguments: { ...request, continuation } });
				expect(result.isError).not.toBe(true);
				const page = result.structuredContent as { outgoing: Array<{ entity: { id: string } }>; nextContinuation: string | null };
				seen.push(...page.outgoing.map((edge) => edge.entity.id));
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(12);
			} while (continuation !== null);
			expect(seen).toEqual(neighbors.slice(1).filter((neighbor) => neighbor.id !== removed.id).map((neighbor) => neighbor.id));
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["entity metadata", "Plan link collection"])("returns a bounded error instead of skipping an oversized relation summary (%s)", async (category) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-relation-oversized-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "relations.db"));
		const anchor = await store.createEntity({ kind: "issue", title: "Anchor" });
		let detailReference: string;
		if (category === "entity metadata") {
			const neighbor = await store.createEntity({ kind: "issue", title: "Large relation metadata ".repeat(2_000) });
			await store.linkEntities({ fromId: anchor.id, relationType: "blocks", toId: neighbor.id });
			detailReference = neighbor.reference;
		} else {
			const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Linked Plan", parentId: initiative.id });
			const referencedEntityIds = [anchor.id];
			for (let index = 0; index < 1000; index++) referencedEntityIds.push((await store.createEntity({ kind: "issue", title: `Linked issue ${index}` })).id);
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Decision", referencedEntityIds });
			detailReference = entry.reference;
		}
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "relation-oversized-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({ name: "relation_query", arguments: { entityId: anchor.reference, direction: "outgoing" } });
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(detailReference) }]);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("keeps next-work parent and deferred blocker rules and reports completed work", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Work initiative" });
		const parent = await store.createEntity({ kind: "issue", title: "Parent", parentId: initiative.id });
		const child = await store.createEntity({ kind: "issue", title: "Child", parentId: parent.id });
		const blocker = await store.createEntity({ kind: "issue", title: "External deferred blocker", status: "deferred" });
		const blocked = await store.createEntity({ kind: "issue", title: "Blocked", parentId: initiative.id });
		await store.createEntity({ kind: "issue", title: "Finished", status: "done", parentId: initiative.id });
		await store.createEntity({ kind: "issue", title: "Later", status: "deferred", parentId: initiative.id });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: blocked.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const read = async () => {
				const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: blocked.reference } });
				expect(result.isError).not.toBe(true);
				return result.structuredContent;
			};
			expect(await read()).toMatchObject({
				available: [{ issue: { reference: child.reference }, unfinishedUnblockCount: 1 }],
				counts: { available: 1, blocked: 2 }, hasMore: false
			});
			await store.updateEntityStatus({ entityId: child.id, status: "done" });
			expect(await read()).toMatchObject({
				available: [{ issue: { reference: parent.reference }, unfinishedUnblockCount: 0 }],
				counts: { available: 1, blocked: 1 }, hasMore: false
			});
			await store.updateEntityStatus({ entityId: parent.id, status: "done" });
			expect(await read()).toMatchObject({ available: [], counts: { available: 0, blocked: 1 }, hasMore: false });
			await store.updateEntityStatus({ entityId: blocker.id, status: "done" });
			expect(await read()).toMatchObject({
				available: [{ issue: { reference: blocked.reference } }], counts: { available: 1, blocked: 0 }, hasMore: false
			});
			await store.updateEntityStatus({ entityId: blocked.id, status: "done" });
			expect(await read()).toMatchObject({ available: [], counts: { available: 0, blocked: 0 }, hasMore: false });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("excludes every issue with an unfinished blocker from available entity_next_work", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Work initiative" });
		const blocker = await store.createEntity({ kind: "issue", title: "Shared blocker", parentId: initiative.id });
		const firstBlocked = await store.createEntity({ kind: "issue", title: "First blocked", parentId: initiative.id });
		const secondBlocked = await store.createEntity({ kind: "issue", title: "Second blocked", parentId: initiative.id });
		const selected = await store.createEntity({ kind: "issue", title: "Available selection", parentId: initiative.id });
		await store.createEntity({ kind: "issue", title: "Later work", parentId: initiative.id, status: "deferred" });
		await store.createEntity({ kind: "issue", title: "Optional child", parentId: selected.id, status: "deferred" });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: firstBlocked.id });
		await store.linkEntities({ fromId: blocker.id, relationType: "blocks", toId: secondBlocked.id });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "entity_next_work", arguments: { scopeId: selected.reference } });
		expect(result.isError).not.toBe(true);
		const content = result.structuredContent as { available: Array<{ issue: { reference: string } }>; counts: { available: number; blocked: number } };
		expect(content.available.map((item) => item.issue.reference)).toEqual([blocker.reference, selected.reference]);
		expect(content.counts).toEqual({ available: 2, blocked: 2 });

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns bounded entity metadata with usable read references", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const body = "# Complete entity body\n\n".repeat(4_000);
		const issue = await store.createEntity({ kind: "issue", title: "Read through MCP", body });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "entity", reference: issue.reference } } });

		expect(result.isError).not.toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
		expect(result).toMatchObject({ structuredContent: {
			entity: { id: issue.id, reference: issue.reference, kind: "issue", title: "Read through MCP", revision: issue.revision },
			reads: {
				body: { tool: "resource_body", arguments: { request: { resource: "entity", ...{ entityId: issue.reference } } } },
				relations: { tool: "relation_query", arguments: { entityId: issue.reference } },
				details: { command: "agent-issues", arguments: ["show", issue.reference, "--json"] }
			}
		} });
		expect((result.structuredContent as { entity: object }).entity).not.toHaveProperty("body");
		expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
		const reads = (result.structuredContent as { reads: { body: { tool: string; arguments: { entityId: string } }; relations: { tool: string; arguments: { entityId: string } } } }).reads;
		const bodyPart = await client.callTool({ name: reads.body.tool, arguments: reads.body.arguments });
		expect(bodyPart.isError).not.toBe(true);
		const part = (bodyPart.content as Array<{ text: string }>)[1].text;
		expect(part.length).toBeGreaterThan(0);
		expect(body.startsWith(part)).toBe(true);
		const relations = await client.callTool({ name: reads.relations.tool, arguments: reads.relations.arguments });
		expect(relations).toMatchObject({ structuredContent: { entity: { reference: issue.reference } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it.each(["metadata", "missing reference"])("returns bounded resource_show entity errors for oversized %s", async (scenario) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-show-budget-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "\u{1F680}\"\\\n".repeat(6_000), body: "Complete body" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "entity-show-budget-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const reference = scenario === "metadata" ? issue.reference : "missing".repeat(6_000);
			const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "entity", reference } } });
			expect(result.isError).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			if (scenario === "metadata") {
				expect(result.structuredContent).toMatchObject({
					error: expect.stringContaining("metadata"), reference: issue.reference,
					reads: { details: { command: "agent-issues", arguments: ["show", issue.reference, "--json"] } }
				});
				expect(result.structuredContent).not.toHaveProperty("entity");
				expect((await store.getEntityDetails(issue.reference)).entity.title).toBe(issue.title);
			} else {
				expect(result.structuredContent).toBeUndefined();
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("reports stale Plan confirmation through plan_confirm", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Initial decision." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
		await store.updatePlanEntry({ entryId: entry.id, body: "Changed decision.", expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
		const result = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/snapshot is stale/i) }] });

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns a ready Plan as read-only and confirms its snapshot idempotently", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Ready MCP Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "The Plan is ready." });
		const readySnapshot = await store.getEntityDetails(plan.reference);
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await store.confirmPlan({
			planId: plan.id,
			snapshotDigest: projectProposedPlan(readySnapshot.entity, [await store.getPlanEntry({ entryId: entry.id })]).snapshotDigest
		});
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
		const confirmation = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(preview).toMatchObject({ structuredContent: { plan: { reference: plan.reference, status: "ready" } } });
		expect(confirmation).toMatchObject({
			structuredContent: { entity: { reference: plan.reference, status: "ready" }, previousStatus: "ready", confirmed: false }
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("confirms the exact Proposed Plan snapshot through plan_confirm", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Use the confirmation tool." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const preview = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });
		const snapshotDigest = (preview.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest;
			for (const [name, request] of [["planEntry", { planId: plan.id }], ["planEntryHistory", { entryId: entry.id }], ["resource_body", { entryId: entry.id }]] as const) {
			expect((await client.callTool(collectionCall(name, planDetailArguments(name, request)))).isError).not.toBe(true);
		}
		const result = await client.callTool({ name: "plan_confirm", arguments: { planId: plan.reference, snapshotDigest } });

		expect(result).toMatchObject({
			structuredContent: { entity: { reference: plan.reference, status: "ready" }, previousStatus: "in-progress", confirmed: true }
		});

		await client.close();
		await server.close();
		await store.close();
	});

	it("returns a Proposed Plan through plan_preview", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({
			kind: "plan",
			title: "MCP Plan",
			body: "## Goal\n\nReview the MCP contract.\n\n## Context\n\nUse a text fallback.",
			parentId: initiative.id
		});
		await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Return structured content." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "plan_preview", arguments: { planId: plan.reference } });

		expect(result).toMatchObject({
			structuredContent: {
				plan: {
					reference: plan.reference,
					title: "MCP Plan",
					goal: "Review the MCP contract.",
					context: "Use a text fallback.",
					current: [expect.objectContaining({ key: "decisions" })],
					snapshotDigest: expect.any(String)
				}
			}
		});
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const text = content[0];
		expect(content).toEqual([{ type: "text", text: expect.stringContaining("MCP Plan") }]);
		expect(text && "text" in text ? text.text : "").toContain((result.structuredContent as { plan: { snapshotDigest: string } }).plan.snapshotDigest);

		await client.close();
		await server.close();
		await store.close();
	});

	it("creates, changes, links, and deletes Plan entries through MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Plan initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "MCP Plan", parentId: initiative.id });
		const prd = await store.createEntity({ kind: "prd", title: "Plan product requirement" });
		const relatedIssue = await store.createEntity({ kind: "issue", title: "Related Plan issue" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const created = await client.callTool({
			name: "resource_create",
			arguments: { request: { resource: "planEntry", planId: plan.reference, role: "question", body: "What must the tool return?", referencedEntityIds: [relatedIssue.reference] } }
		});
		expect(created).toMatchObject({ structuredContent: { entry: { referencedEntityIds: [relatedIssue.id] } } });
		expect((created.structuredContent as { entry: object }).entry).not.toHaveProperty("body");
		const entry = (created.structuredContent as { entry: { reference: string; revision: number; contentHash: string } }).entry;
		const list = await client.callTool(collectionCall("planEntry", { planId: plan.reference }));
		const edited = await client.callTool({
			name: "resource_edit",
			arguments: { request: { resource: "planEntry", entryId: entry.reference, body: "The tool returns structured data.", expectedRevision: entry.revision, expectedContentHash: entry.contentHash } }
		});
		const updatedEntry = (edited.structuredContent as { entry: { reference: string; revision: number; contentHash: string } }).entry;
		const history = await client.callTool(historyCall("planEntry", "list", { entryId: updatedEntry.reference }));
		const linked = await client.callTool({ name: "plan_entry_entity_link", arguments: { entryId: updatedEntry.reference, targetId: prd.reference } });
		const linkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const unlinked = await client.callTool({ name: "plan_entry_entity_unlink", arguments: { entryId: updatedEntry.reference, targetId: prd.reference } });
		const unlinkedEntry = await store.getPlanEntry({ entryId: updatedEntry.reference });
		const deleted = await client.callTool({
			name: "resource_delete",
			arguments: {
				request: {
					resource: "planEntry",
					action: "delete",
					entryId: updatedEntry.reference,
					expectedRevision: unlinkedEntry.revision,
					expectedContentHash: unlinkedEntry.contentHash
				}
			}
		});

		expect(list).toMatchObject({ structuredContent: { entries: [expect.objectContaining({ reference: entry.reference, role: "question", revision: 1 })], nextContinuation: null } });
		const sourceRead = (list.structuredContent as { entries: Array<{ reads: { body: { tool: string; arguments: Record<string, unknown> } } }> }).entries[0].reads.body;
		const originalBody = await client.callTool({ name: sourceRead.tool, arguments: sourceRead.arguments });
		expect((originalBody.content as Array<{ text: string }>)[1].text).toBe("What must the tool return?");
		expect(edited).toMatchObject({ structuredContent: { entry: { reference: entry.reference, body: "The tool returns structured data.", revision: 2 } } });
		expect(history).toMatchObject({ structuredContent: { history: expect.arrayContaining([expect.objectContaining({ entryId: expect.any(String), targetRevision: 1, role: "question" })]), nextContinuation: null } });
		expect(linked).toMatchObject({ structuredContent: { created: true } });
		expect(linkedEntry.referencedEntityIds).toContain(prd.id);
		expect(unlinked).toMatchObject({ structuredContent: { removed: true } });
		expect(deleted).toMatchObject({ structuredContent: { entry: { reference: entry.reference, tombstone: true } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("reads complete comment bodies through bounded list summaries and body parts", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-comment-parts-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "comments.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Large comment issue" });
		const body = "Complete Markdown\n\"\\\t\u{1F680}".repeat(2_000);
		const comment = await store.createIssueComment({ issueId: issue.id, body });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "comment-parts-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool(collectionCall("comment", { issueId: issue.reference, all: true }));
			expect(result.isError).not.toBe(true);
			expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			const page = result.structuredContent as { comments: Array<{ reference: string; reads: { body: { tool: string; arguments: Record<string, unknown> } } }>; total: number; nextBefore: string | null };
			expect(page).toMatchObject({ total: 1, nextBefore: null });
			expect(page.comments[0]).not.toHaveProperty("body");
			expect(page.comments[0].reference).toBe(comment.reference);
			let offset: number | null = 0;
			let documentHash: string | undefined;
			let assembled = "";
			while (offset !== null) {
				const read = page.comments[0].reads.body;
				const request = read.arguments.request as Record<string, unknown>;
				const part = await client.callTool({ name: read.tool, arguments: { request: { ...request, offset, ...(documentHash ? { documentHash } : {}) } } });
				expect(part.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(part), "utf8")).toBeLessThanOrEqual(65536);
				const content = part.content as Array<{ text: string }>;
				const metadata = JSON.parse(content[0].text);
				expect(metadata.offset).toBe(assembled.length);
				documentHash ??= metadata.documentHash;
				expect(metadata.documentHash).toBe(documentHash);
				assembled += content[1].text;
				offset = metadata.nextOffset;
			}
			expect(assembled).toBe(body);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("pages every comment revision through bounded history summaries", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-comment-history-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "comments.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Comment history issue" });
		let comment = await store.createIssueComment({ issueId: issue.id, body: "First revision\n".repeat(1_000) });
		for (let revision = 2; revision <= 100; revision++) {
			comment = await store.updateIssueComment({ commentId: comment.id, body: `Revision ${revision}\n`.repeat(1_000), expectedRevision: comment.revision, expectedContentHash: comment.contentHash });
		}
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "comment-history-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const revisions: number[] = [];
			let pages = 0;
			do {
				const result = await client.callTool(historyCall("comment", "list", { commentId: comment.reference, ...(continuation ? { continuation } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { history: Array<{ targetRevision: number; reads: { body: { tool: string; arguments: { commentId: string; revision: number } } } }>; nextContinuation: string | null };
				expect(page.history.length).toBeGreaterThan(0);
				for (const entry of page.history) {
					expect(entry).not.toHaveProperty("body");
					expect(entry.reads.body).toMatchObject({ tool: "resource_body", arguments: { request: { resource: "comment", ...{ revision: entry.targetRevision } } } });
					revisions.push(entry.targetRevision);
				}
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(20);
			} while (continuation !== null);
			expect(pages).toBeGreaterThan(1);
			expect(revisions).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
			const empty = await client.callTool(historyCall("comment", "list", { commentId: randomUUID() }));
			expect(empty).toMatchObject({ structuredContent: { history: [], nextContinuation: null } });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("traverses bounded comment pages with scoped before cursors and live totals", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-comment-pages-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "comments.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Paged comment issue" });
		const otherIssue = await store.createEntity({ kind: "issue", title: "Other comment issue" });
		for (let index = 0; index < 61; index++) await store.createIssueComment({ issueId: issue.id, body: `Comment ${index}` });
		const expected = (await store.listIssueComments({ issueId: issue.id, all: true })).comments.map((comment) => comment.reference);
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "comment-pages-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let before: string | null = null;
			let total = 61;
			let pages = 0;
			const references: string[] = [];
			do {
				const result = await client.callTool(collectionCall("comment", { issueId: issue.reference, all: true, ...(before ? { before } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { comments: Array<{ reference: string }>; total: number; nextBefore: string | null };
				expect(page.total).toBe(total);
				expect(page.comments.length).toBeGreaterThan(0);
				references.unshift(...page.comments.map((comment) => comment.reference));
				before = page.nextBefore;
				if (pages === 0) {
					expect(before).not.toBeNull();
					for (const argumentsValue of [
						{ issueId: otherIssue.reference, before },
						{ issueId: issue.reference, before: `${before}invalid` },
						{ issueId: issue.reference, before: "invalid" }
					]) {
						const invalid = await client.callTool(collectionCall("comment", argumentsValue));
						expect(invalid.isError).toBe(true);
						expect(invalid.structuredContent).toBeUndefined();
						expect(Buffer.byteLength(JSON.stringify(invalid), "utf8")).toBeLessThanOrEqual(65536);
					}
					await store.createIssueComment({ issueId: issue.id, body: "Newer than the first page" });
					total++;
				}
				expect(++pages).toBeLessThan(62);
			} while (before !== null);
			expect(references).toEqual(expected);
			const empty = await client.callTool(collectionCall("comment", { issueId: otherIssue.reference }));
			expect(empty).toMatchObject({ structuredContent: { comments: [], users: [], total: 0, nextBefore: null } });
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("rejects invalid comment body snapshots and scopes live history continuation", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-comment-snapshots-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "comments.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Comment snapshot issue" });
		const originalBody = "Original body\n".repeat(8_000);
		let comment = await store.createIssueComment({ issueId: issue.id, body: originalBody });
		const other = await store.createIssueComment({ issueId: issue.id, body: originalBody });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "comment-snapshot-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const first = await client.callTool({ name: "resource_body", arguments: { request: { resource: "comment", ...{ commentId: comment.reference } } } });
			const metadata = JSON.parse((first.content as Array<{ text: string }>)[0].text) as { documentHash: string; nextOffset: number };
			expect(metadata.nextOffset).toBeGreaterThan(0);
			comment = await store.updateIssueComment({ commentId: comment.id, body: "Changed body", expectedRevision: comment.revision, expectedContentHash: comment.contentHash });
			for (const argumentsValue of [
				{ commentId: comment.reference, offset: metadata.nextOffset },
				{ commentId: comment.reference, offset: metadata.nextOffset, documentHash: metadata.documentHash },
				{ commentId: other.reference, offset: metadata.nextOffset, documentHash: metadata.documentHash },
				{ commentId: comment.reference, revision: 2, offset: metadata.nextOffset, documentHash: metadata.documentHash },
				{ commentId: comment.reference, revision: 1, offset: originalBody.length, documentHash: metadata.documentHash },
				{ commentId: comment.reference, revision: 99 },
				{ commentId: randomUUID() }
			]) {
				const invalid = await client.callTool({ name: "resource_body", arguments: { request: { resource: "comment", ...argumentsValue } } });
				expect(invalid.isError).toBe(true);
				expect(invalid.structuredContent).toBeUndefined();
				expect((invalid.content as Array<{ text: string }>)).toHaveLength(1);
				expect(Buffer.byteLength(JSON.stringify(invalid), "utf8")).toBeLessThanOrEqual(65536);
			}
			const historical = await client.callTool({ name: "resource_body", arguments: { request: { resource: "comment", ...{ commentId: comment.reference, revision: 1, offset: metadata.nextOffset, documentHash: metadata.documentHash } } } });
			expect(historical.isError).not.toBe(true);
			expect((historical.content as Array<{ text: string }>)[1].text).toBe(originalBody.slice(metadata.nextOffset));
			const restarted = await client.callTool({ name: "resource_body", arguments: { request: { resource: "comment", ...{ commentId: comment.reference } } } });
			expect((restarted.content as Array<{ text: string }>)[1].text).toBe("Changed body");
			for (let revision = 3; revision <= 100; revision++) comment = await store.updateIssueComment({ commentId: comment.id, body: `Revision ${revision}`, expectedRevision: comment.revision, expectedContentHash: comment.contentHash });
			const history = await client.callTool(historyCall("comment", "list", { commentId: comment.reference }));
			const page = history.structuredContent as { history: Array<{ targetRevision: number }>; nextContinuation: string };
			expect(page.nextContinuation).toEqual(expect.any(String));
			const historyInitiative = await store.createEntity({ kind: "initiative", title: "History cursor scope" });
			const historyPlan = await store.createEntity({ kind: "plan", title: "History cursor Plan", parentId: historyInitiative.id });
			const historyEntry = await store.createPlanEntry({ planId: historyPlan.id, role: "decision", body: "Other resource" });
			for (const crossResourceRequest of [
				historyCall("planEntry", "list", { entryId: historyEntry.reference, continuation: page.nextContinuation }),
				collectionCall("comment", { issueId: issue.reference, before: page.nextContinuation })
			]) {
				const result = await client.callTool(crossResourceRequest);
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
			}
			for (const argumentsValue of [
				{ commentId: other.reference, continuation: page.nextContinuation },
				{ commentId: comment.reference, continuation: `${page.nextContinuation}invalid` }
			]) {
				const invalid = await client.callTool(historyCall("comment", "list", argumentsValue));
				expect(invalid.isError).toBe(true);
				expect(invalid.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(invalid), "utf8")).toBeLessThanOrEqual(65536);
			}
			await store.updateIssueComment({ commentId: comment.id, body: "Added revision", expectedRevision: comment.revision, expectedContentHash: comment.contentHash });
			const next = await client.callTool(historyCall("comment", "list", { commentId: comment.reference, continuation: page.nextContinuation }));
			const nextPage = next.structuredContent as { history: Array<{ targetRevision: number; headRevision: number }> };
			expect(nextPage.history[0].targetRevision).toBe(page.history.at(-1)!.targetRevision + 1);
			expect(nextPage.history.every((entry) => entry.headRevision === 101)).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("rejects oversized comment metadata without losing access to its body", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-comment-metadata-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "comments.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Oversized comment metadata" });
		const referencedIssueIds: string[] = [];
		for (let index = 0; index < 1000; index++) referencedIssueIds.push((await store.createEntity({ kind: "issue", title: `Reference ${index}` })).id);
		const comment = await store.createIssueComment({ issueId: issue.id, body: "Complete body despite large references", referencedIssueIds });
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "comment-metadata-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			for (const request of [
				collectionCall("comment", { issueId: issue.reference, all: true }),
				historyCall("comment", "list", { commentId: comment.reference })
			]) {
				const result = await client.callTool(request);
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect((result.content as Array<{ text: string }>)[0].text).toContain("65536-byte response budget");
			}
			const body = await client.callTool({ name: "resource_body", arguments: { request: { resource: "comment", ...{ commentId: comment.reference } } } });
			expect(body.isError).not.toBe(true);
			expect((body.content as Array<{ text: string }>)[1].text).toBe("Complete body despite large references");
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("creates, changes, lists, and deletes issue comments through MCP", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Comment issue" });
		const relatedIssue = await store.createEntity({ kind: "issue", title: "Related comment issue" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const created = await client.callTool({
			name: "resource_create",
			arguments: { request: { resource: "comment", issueId: issue.reference, body: "Authored comment", referencedIssueIds: [relatedIssue.reference] } }
		});
		expect(created).toMatchObject({ structuredContent: { comment: { referencedIssueIds: [relatedIssue.id] } } });
		expect((created.structuredContent as { comment: object }).comment).not.toHaveProperty("body");
		const comment = (created.structuredContent as { comment: { reference: string; revision: number; contentHash: string } }).comment;
		const list = await client.callTool(collectionCall("comment", { issueId: issue.reference, all: true }));
		const edited = await client.callTool({
			name: "resource_edit",
			arguments: { request: { resource: "comment", commentId: comment.reference, body: "Edited comment", expectedRevision: comment.revision, expectedContentHash: comment.contentHash } }
		});
		const updatedComment = (edited.structuredContent as { comment: { reference: string; revision: number; contentHash: string } }).comment;
		const history = await client.callTool(historyCall("comment", "list", { commentId: updatedComment.reference }));
		const deleted = await client.callTool({
			name: "resource_delete",
			arguments: {
				request: {
					resource: "comment",
					action: "delete",
					commentId: updatedComment.reference,
					expectedRevision: updatedComment.revision,
					expectedContentHash: updatedComment.contentHash
				}
			}
		});

		expect(list).toMatchObject({ structuredContent: { comments: [expect.objectContaining({ reference: comment.reference })], nextBefore: null } });
		expect(edited).toMatchObject({ structuredContent: { comment: { reference: comment.reference, body: "Edited comment", revision: 2 } } });
		expect(history).toMatchObject({
			structuredContent: {
				history: expect.arrayContaining([expect.objectContaining({ commentId: expect.any(String), targetRevision: 1 })]),
				nextContinuation: null
			}
		});
		expect(deleted).toMatchObject({ structuredContent: { comment: { reference: comment.reference, tombstone: true, revision: 3 } } });

		await client.close();
		await server.close();
		await store.close();
	});

	it.each(["context", "contextDirectory", "context_search"])("reads complete bounded %s pages without embedding context bodies", async (tool) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-context-pages-"));
		directories.push(directory);
		const dbPath = path.join(directory, "contexts.db");
		const { store } = await openSqliteStore(dbPath);
		const summary = "Large context summary\n".repeat(1000).trim();
		const definition = "Large term definition\n".repeat(1000).trim();
		await store.upsertContext({ title: "Shared glossary", summary });
		await store.defineContextTerm({ term: "Shared term", definition });
		for (let index = 0; index < 100; index++) {
			const initiative = await store.createEntity({ kind: "initiative", title: `Glossary ${index}` });
			await store.upsertContext({ scopeRef: initiative.reference, title: `Context ${index}`, summary });
			await store.defineContextTerm({ scopeRef: initiative.reference, term: `Term ${index}`, definition });
		}
		const expectedContexts = (await store.listContexts()).contexts.map((item) => item.context.key).sort();
		const expectedTitles = new Map((await store.listContexts()).contexts.map((item) => [item.context.key, item.context.title]));
		const expectedTerms = (await store.getContextDirectory()).terms.map((item) => item.term).sort();
		const credentialStoreOptions = fakeCredentialStore();
		const daemon = createLocalDaemonServer({ dbPath, homeDirectory: directory, credentialStoreOptions });
		await new Promise<void>((resolve) => daemon.server.once("listening", resolve));
		const server = createLocalMcpServer({ dbPath, homeDirectory: directory, credentialStoreOptions, spawn: () => { throw new Error("Unexpected daemon spawn."); } });
		const client = new Client({ name: "context-pages-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const contexts: string[] = [];
			const terms: string[] = [];
			let pageCount = 0;
			let bodyRead: { tool: string; arguments: { request: Record<string, unknown> } } | undefined;
			let termRead: typeof bodyRead;
			do {
				const result = await client.callTool(collectionCall(tool, continuation ? { continuation } : {}));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				expect(JSON.stringify(result)).not.toContain("Large context summary");
				expect(JSON.stringify(result)).not.toContain("Large term definition");
				const page = result.structuredContent as {
					contexts?: Array<{ context: { key: string; title: string }; reads: { body: NonNullable<typeof bodyRead> } }>;
					shared?: { context: { key: string; title: string }; reads: { body: NonNullable<typeof bodyRead> } } | null;
					initiatives?: Array<{ context: { key: string; title: string }; reads: { body: NonNullable<typeof bodyRead> } }>;
					terms?: Array<{ term: string; sources: Array<{ reads: { body: NonNullable<typeof bodyRead> } }> }>;
					nextContinuation: string | null;
				};
				for (const item of [...(page.contexts ?? []), ...(page.shared ? [page.shared] : []), ...(page.initiatives ?? [])]) {
					expect(item.context.title).toBe(expectedTitles.get(item.context.key));
					contexts.push(item.context.key);
					bodyRead ??= item.reads.body;
				}
				for (const item of page.terms ?? []) {
					terms.push(item.term);
					termRead ??= item.sources[0].reads.body;
				}
				continuation = page.nextContinuation;
				expect(continuation === null || typeof continuation === "string").toBe(true);
				expect(++pageCount).toBeLessThan(40);
			} while (continuation !== null);
			expect(pageCount).toBeGreaterThan(1);
			expect(contexts.slice().sort()).toEqual(expectedContexts);
			if (tool !== "context") expect(terms.slice().sort()).toEqual(expectedTerms);
			const bodyCases: Array<[typeof bodyRead, string]> = [[bodyRead, summary]];
			if (termRead) bodyCases.push([termRead, definition]);
			for (const [read, expected] of bodyCases) {
				expect(read).toBeDefined();
				let offset: number | null = null;
				let documentHash: string | undefined;
				let body = "";
				do {
					const result = await client.callTool({ name: read!.tool, arguments: { request: { ...read!.arguments.request, ...(offset === null ? {} : { offset, documentHash }) } } });
					expect(result.isError).not.toBe(true);
					expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
					const content = result.content as Array<{ type: "text"; text: string }>;
					const metadata = JSON.parse(content[0].text) as { nextOffset: number | null; documentHash: string };
					body += content[1].text;
					offset = metadata.nextOffset;
					documentHash = metadata.documentHash;
				} while (offset !== null);
				expect(body).toBe(expected);
			}
		} finally {
			await client.close();
			await server.close();
			await daemon.close();
			await store.close();
		}
	});

	it.each(["context", "contextDirectory", "context_search"])("binds %s context continuation and preserves live traversal", async (tool) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-context-continuation-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "contexts.db"));
		for (let index = 0; index < 100; index++) {
			const initiative = await store.createEntity({ kind: "initiative", title: `Scope ${index}` });
			await store.upsertContext({ scopeRef: initiative.id, title: `Context ${index}`, summary: "Searchable summary" });
			await store.defineContextTerm({ scopeRef: initiative.id, term: `Term ${index}`, definition: "Searchable definition" });
		}
		const options = { projectIdentity: "context-scope-a", openStore: async () => store };
		const server = createMcpServer(options);
		const client = new Client({ name: "context-continuation-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = tool === "context_search" ? { query: "Searchable", view: "initiatives" } : {};
			const firstResult = await client.callTool(collectionCall(tool, request));
			expect(firstResult.isError).not.toBe(true);
			const first = firstResult.structuredContent as { contexts?: Array<{ context: { key: string } }>; initiatives?: Array<{ context: { key: string } }>; nextContinuation: string };
			expect(first.nextContinuation).toEqual(expect.any(String));
			for (const invalid of ["invalid", `${first.nextContinuation}x`]) {
				const result = await client.callTool(collectionCall(tool, { ...request, continuation: invalid }));
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			}
			const otherTool = tool === "context" ? "contextDirectory" : "context";
			expect((await client.callTool(collectionCall(otherTool, { continuation: first.nextContinuation }))).isError).toBe(true);
			if (tool === "context_search") {
				for (const changed of [{ query: "Other", view: "initiatives" }, { query: "Searchable", view: "global" }]) {
					expect((await client.callTool(collectionCall(tool, { ...changed, continuation: first.nextContinuation }))).isError).toBe(true);
				}
			}
			options.projectIdentity = "context-scope-b";
			expect((await client.callTool(collectionCall(tool, { ...request, continuation: first.nextContinuation }))).isError).toBe(true);
			options.projectIdentity = "context-scope-a";
			const allContexts = (await store.listContexts()).contexts.slice().sort((firstItem, secondItem) => firstItem.context.key < secondItem.context.key ? -1 : 1);
			const returnedKeys = new Set((first.contexts ?? first.initiatives ?? []).map((item) => item.context.key));
			const later = allContexts.find((item) => !returnedKeys.has(item.context.key) && item.context.scopeKind === "initiative")!;
			await store.upsertContext({ scopeRef: later.context.scopeEntityId!, title: "Changed during traversal", summary: "Searchable revised summary", expectedRevision: later.context.revision, expectedContentHash: later.context.contentHash });
			const keys: string[] = [];
			const titles: string[] = [];
			let continuation: string | null = first.nextContinuation;
			let pages = 0;
			do {
				const result = await client.callTool(collectionCall(tool, { ...request, continuation }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { contexts?: Array<{ context: { key: string; title: string } }>; initiatives?: Array<{ context: { key: string; title: string } }>; nextContinuation: string | null };
				for (const item of page.contexts ?? page.initiatives ?? []) {
					keys.push(item.context.key);
					titles.push(item.context.title);
				}
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(40);
			} while (continuation !== null);
			expect(keys).toEqual(allContexts.filter((item) => !returnedKeys.has(item.context.key) && (tool === "context" || item.context.scopeKind === "initiative")).map((item) => item.context.key));
			expect(titles).toContain("Changed during traversal");
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["context", "contextDirectory", "context_search"])("ends empty %s context reads and rejects oversized summaries without a page", async (tool) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-context-errors-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "contexts.db"));
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "context-errors-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const empty = await client.callTool(collectionCall(tool, tool === "context_search" ? { query: "No matching terms" } : {}));
			expect(empty.isError).not.toBe(true);
			expect(Buffer.byteLength(JSON.stringify(empty), "utf8")).toBeLessThanOrEqual(65536);
			expect(empty.structuredContent).toMatchObject({ nextContinuation: null });
			if (tool === "context_search") expect(empty.structuredContent).toMatchObject({ shared: null, initiatives: [], terms: [], duplicateTerms: [] });
			else if (tool === "contextDirectory") expect(empty.structuredContent).toMatchObject({ initiatives: [], terms: [], duplicateTerms: [] });
			else expect(empty.structuredContent).toMatchObject({ contexts: [{ context: { exists: false }, termCount: 0 }] });
			let saved = await store.upsertContext({ title: "Oversized title".repeat(8000), summary: "Small body" });
			const oversized = await client.callTool(collectionCall(tool, {}));
			expect(oversized.isError).toBe(true);
			expect(oversized.structuredContent).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeLessThanOrEqual(65536);
			expect(JSON.stringify(oversized.content)).toContain("agent-issues context");
			if (tool !== "context") {
				saved = await store.upsertContext({ title: "Small title", summary: "Small body", expectedRevision: saved.context.revision, expectedContentHash: saved.context.contentHash });
				await store.defineContextTerm({ term: "Huge metadata", definition: "Small definition", avoid: ["Oversized alternative".repeat(8000)] });
				let continuation: string | null = null;
				let failed = false;
				for (let pageCount = 0; pageCount < 4; pageCount++) {
					const result = await client.callTool(collectionCall(tool, continuation ? { continuation } : {}));
					expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
					if (result.isError) {
						expect(result.structuredContent).toBeUndefined();
						failed = true;
						break;
					}
					continuation = (result.structuredContent as { nextContinuation: string | null }).nextContinuation;
					if (continuation === null) break;
				}
				expect(failed).toBe(true);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("returns context metadata and term summaries through resource_show", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Glossary initiative" });
		await store.upsertContext({ scopeRef: initiative.reference, title: "Glossary", summary: "Initiative terms." });
		await store.defineContextTerm({ scopeRef: initiative.reference, term: "MCP", definition: "A protocol." });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "context", scopeRef: initiative.reference } } });

		expect(result).toMatchObject({
			structuredContent: {
				context: { title: "Glossary" },
				terms: [{ term: "MCP", reads: { body: { tool: "resource_body" } } }],
				reads: { body: { tool: "resource_body" } }
			}
		});
		expect(JSON.stringify(result)).not.toContain("Initiative terms.");
		expect(JSON.stringify(result)).not.toContain("A protocol.");
		const selected = await client.callTool({ name: "resource_show", arguments: { request: { resource: "contextTerm", scopeRef: initiative.reference, term: "MCP" } } });
		expect(selected).toMatchObject({ structuredContent: { term: { term: "MCP" }, reads: { body: { tool: "resource_body" } } } });
		const selectedMetadata = selected.structuredContent as { reads: { body: { tool: string; arguments: Record<string, unknown> } } };
		const body = await client.callTool({ name: selectedMetadata.reads.body.tool, arguments: selectedMetadata.reads.body.arguments });
		expect(body.content).toEqual(expect.arrayContaining([{ type: "text", text: "A protocol." }]));
		const global = await client.callTool({ name: "resource_show", arguments: { request: { resource: "context" } } });
		expect(global.isError).not.toBe(true);
		const globalMetadata = global.structuredContent as { reads: { body: { tool: string; arguments: Record<string, unknown> } } };
		expect((await client.callTool({ name: globalMetadata.reads.body.tool, arguments: globalMetadata.reads.body.arguments })).isError).not.toBe(true);
		expect((await client.callTool({ name: "resource_show", arguments: { request: { resource: "contextTerm", scopeRef: initiative.reference, term: "missing" } } })).isError).toBe(true);

		await client.close();
		await server.close();
		await store.close();
	});

	it("queries, changes, and reads context revisions through context tools", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const firstInitiative = await store.createEntity({ kind: "initiative", title: "First context initiative" });
		const secondInitiative = await store.createEntity({ kind: "initiative", title: "Second context initiative" });
		const thirdInitiative = await store.createEntity({ kind: "initiative", title: "Third context initiative" });
		await store.upsertContext({ scopeRef: firstInitiative.reference, title: "First context", summary: "First summary." });
		await store.upsertContext({ scopeRef: secondInitiative.reference, title: "Second context", summary: "Second summary." });
		await store.defineContextTerm({ scopeRef: firstInitiative.reference, term: "parity", definition: "Equivalent behavior." });
		await store.defineContextTerm({ scopeRef: secondInitiative.reference, term: "parity", definition: "A different definition." });
		const firstContext = await store.getContextDetails({ scopeRef: firstInitiative.reference });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const directoryResult = await client.callTool(collectionCall("contextDirectory", {}));
		const search = await client.callTool({ name: "context_search", arguments: { query: "parity", view: "initiatives" } });
		const conflicts = await client.callTool({ name: "context_conflicts", arguments: { query: "parity" } });
		const set = await client.callTool({
			name: "resource_create",
			arguments: {
				request: {
					resource: "context",
					scopeRef: firstInitiative.reference,
					title: "First context revised",
					summary: "Revised summary.",
					expectedRevision: firstContext.context.revision,
					expectedContentHash: firstContext.context.contentHash
				}
			}
		});
		const createdContext = await client.callTool({
			name: "resource_create",
			arguments: { request: { resource: "context", scopeRef: thirdInitiative.reference, title: "Third context", summary: "Created through resource_create." } }
		});
		const define = await client.callTool({
			name: "context_term_define",
			arguments: { scopeRef: firstInitiative.reference, term: "token", definition: "A temporary confirmation value." }
		});
		const token = (await store.getContextDetails({ scopeRef: firstInitiative.reference })).terms.find((term) => term.term === "token");
		const contextRevision = await client.callTool(historyCall("context", "revision", { scopeRef: firstInitiative.reference, revision: 1 }));
		const termRevision = await client.callTool(historyCall("contextTerm", "revision", { scopeRef: firstInitiative.reference, term: "parity", revision: 1 }));
		const forget = await client.callTool({
			name: "resource_delete",
			arguments: {
				request: {
					resource: "contextTerm",
					action: "delete",
					scopeRef: firstInitiative.reference,
					term: "token",
					expectedRevision: token?.revision,
					expectedContentHash: token?.contentHash
				}
			}
		});

		expect(directoryResult).toMatchObject({
			structuredContent: {
				initiatives: expect.arrayContaining([expect.objectContaining({ context: expect.objectContaining({ title: "First context" }) })])
			}
		});
		expect(search).toMatchObject({ structuredContent: { query: "parity", view: "initiatives", terms: [expect.objectContaining({ term: "parity" })] } });
		expect(conflicts).toMatchObject({ structuredContent: { conflictsOnly: true, terms: [expect.objectContaining({ term: "parity", hasConflictingDefinitions: true })] } });
		expect(set).toMatchObject({ structuredContent: { context: { title: "First context revised" } } });
		expect((set.structuredContent as { context: object }).context).not.toHaveProperty("summary");
		expect(createdContext).toMatchObject({ structuredContent: { context: { title: "Third context" } } });
		expect(define).toMatchObject({ structuredContent: { term: { term: "token" }, created: true } });
		expect((define.structuredContent as { term: object }).term).not.toHaveProperty("definition");
		expect(contextRevision).toMatchObject({ structuredContent: { reference: firstContext.context.reference, targetRevision: 1, title: "First context" } });
		expect(termRevision).toMatchObject({ structuredContent: { reference: firstContext.terms.find((term) => term.term === "parity")!.reference, targetRevision: 1, term: "parity" } });
		for (const [result, expectedBody, field] of [
			[contextRevision, "First summary.", "summary"], [termRevision, "Equivalent behavior.", "definition"]
		] as const) {
			const metadata = result.structuredContent as { reads: { body: { tool: string; arguments: Record<string, unknown> } } };
			expect(metadata).not.toHaveProperty(field);
			const body = await client.callTool({ name: metadata.reads.body.tool, arguments: metadata.reads.body.arguments });
			expect(body.isError).not.toBe(true);
			expect(body.content).toContainEqual({ type: "text", text: expectedBody });
		}
		for (const request of [
			historyCall("context", "revision", { scopeRef: firstInitiative.reference, revision: 99 }),
			historyCall("contextTerm", "revision", { scopeRef: firstInitiative.reference, term: "parity", revision: 99 })
		]) expect((await client.callTool(request)).isError).toBe(true);
		const removedTerm = await client.callTool(historyCall("contextTerm", "revision", { scopeRef: firstInitiative.reference, term: "token", revision: 2 }));
		expect(removedTerm).toMatchObject({ structuredContent: { targetRevision: 2, headRevision: 2, tombstone: true } });
		expect(forget).toMatchObject({ structuredContent: { term: "token", removed: true } });

		await client.close();
		await server.close();
		await store.close();
	});

	it.each(["issue", undefined, "adr"])("reads complete bounded entity_orphans pages (kind %s)", async (kind) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-orphan-pages-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "orphans.db"));
		const initiative = await store.createEntity({ kind: "initiative", title: "Parent" });
		await store.createEntity({ kind: "issue", title: "Parented issue", parentId: initiative.id });
		for (let index = 0; index < 18; index++) {
			await store.createEntity({ kind: "issue", title: `Orphan ${index} ${"summary ".repeat(640)}`, body: "Large orphan body\n".repeat(2_000) });
		}
		const expected = (await store.listOrphans(kind)).toSorted((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "orphan-pages-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const seen: string[] = [];
			let pages = 0;
			do {
				const result = await client.callTool(collectionCall("orphanEntity", { ...(kind ? { kind } : {}), ...(continuation ? { continuation } : {}) }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { entities: Array<{ reference: string; reads: { body: { tool: string; arguments: { entityId: string } } } }>; nextContinuation: string | null };
				expect(page.nextContinuation === null || typeof page.nextContinuation === "string").toBe(true);
				for (const entity of page.entities) {
					expect(entity).not.toHaveProperty("body");
					expect(entity).not.toHaveProperty("bodySource");
					expect(entity.reads.body).toEqual({ tool: "resource_body", arguments: { request: { resource: "entity", ...{ entityId: entity.reference } } } });
					seen.push(entity.reference);
				}
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(25);
			} while (continuation !== null);
			expect(seen).toEqual(expected.map((entity) => entity.reference));
			if (expected.length > 0) expect(pages).toBeGreaterThan(1);
			else expect(pages).toBe(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each([0, 240])("reads complete bounded tenant_list pages (%s extra tenants)", async (tenantCount) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		for (let index = 0; index < tenantCount; index++) {
			const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: `tenant-${index.toString().padStart(3, "0")}-${"long-name".repeat(12)}` });
			await tenantStore.createEntity({ kind: "issue", title: "Tenant issue" });
			await tenantStore.close();
		}
		const expected = (await store.listTenants()).toSorted((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			const seen: typeof expected = [];
			let pages = 0;
			do {
				const result = await client.callTool(collectionCall("tenant", continuation ? { continuation } : {}));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { tenants: typeof expected; nextContinuation: string | null };
				expect(page.nextContinuation === null || typeof page.nextContinuation === "string").toBe(true);
				seen.push(...page.tenants);
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(40);
			} while (continuation !== null);
			expect(seen).toEqual(expected);
			if (tenantCount > 0) expect(pages).toBeGreaterThan(1);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["tenant", "orphanEntity"])("binds %s continuation to scope and checks access on every page", async (toolName) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-scoped-list-"));
		directories.push(directory);
		const dbPath = path.join(directory, "lists.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: otherStore } = await openSqliteStore(dbPath, { tenant: "other-owner" });
		for (let index = 0; index < (toolName === "tenant" ? 160 : 20); index++) {
			if (toolName === "tenant") {
				const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: `Tenant ${index} ${"display ".repeat(60)}` });
				await tenantStore.close();
			} else {
				await store.createEntity({ kind: "issue", title: `Issue ${index} ${"summary ".repeat(640)}` });
			}
		}
		let activeStore = store;
		let accessDenied = false;
		let workspaceRoot = path.join(directory, "first-project");
		mkdirSync(workspaceRoot, { recursive: true });
		mkdirSync(path.join(directory, "second-project"), { recursive: true });
		const server = createMcpServer({ openStore: async () => {
			if (accessDenied) throw new Error("Access denied. ".repeat(2_000));
			return activeStore;
		} });
		const client = new Client({ name: "scoped-list-test", version: "1.0.0" }, { capabilities: { roots: {} } });
		client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspaceRoot).href }] }));
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = toolName === "orphanEntity" ? { kind: "issue" } : {};
			const first = await client.callTool(collectionCall(toolName, request));
			const continuation = (first.structuredContent as { nextContinuation: string }).nextContinuation;
			expect(continuation).toEqual(expect.any(String));
			const continuedRequest = { ...request, continuation };
			const expectDenied = async (argumentsValue: Record<string, unknown>, name = toolName) => {
				const result = await client.callTool(collectionCall(name, argumentsValue));
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toBeUndefined();
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
			};
			await expectDenied({ ...continuedRequest, continuation: "invalid" });
			await expectDenied({ ...continuedRequest, continuation: `${continuation.slice(0, -1)}!` });
			if (toolName === "orphanEntity") await expectDenied({ ...continuedRequest, kind: "adr" });
			await expectDenied(continuedRequest, toolName === "tenant" ? "orphanEntity" : "tenant");
			activeStore = otherStore;
			await expectDenied(continuedRequest);
			activeStore = store;
			workspaceRoot = path.join(directory, "second-project");
			await expectDenied(continuedRequest);
			workspaceRoot = path.join(directory, "first-project");
			accessDenied = true;
			await expectDenied(continuedRequest);
			accessDenied = false;
			const valid = await client.callTool(collectionCall(toolName, continuedRequest));
			expect(valid.isError).not.toBe(true);
			expect(await client.callTool(collectionCall(toolName, continuedRequest))).toEqual(valid);
			const otherServer = createMcpServer({ openStore: async () => store });
			const otherClient = new Client({ name: "other-list-server-test", version: "1.0.0" }, { capabilities: { roots: {} } });
			otherClient.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspaceRoot).href }] }));
			const [otherClientTransport, otherServerTransport] = InMemoryTransport.createLinkedPair();
			try {
				await otherServer.connect(otherServerTransport);
				await otherClient.connect(otherClientTransport);
				const replay = await otherClient.callTool(collectionCall(toolName, continuedRequest));
				expect(replay.isError).toBe(true);
			} finally {
				await otherClient.close();
				await otherServer.close();
			}
		} finally {
			await client.close();
			await server.close();
			await otherStore.close();
			await store.close();
		}
	});

	it.each(["tenant", "orphanEntity"])("keeps %s item-key traversal stable after changes", async (toolName) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-live-list-"));
		directories.push(directory);
		const dbPath = path.join(directory, "lists.db");
		const { store } = await openSqliteStore(dbPath);
		for (let index = 0; index < (toolName === "tenant" ? 160 : 20); index++) {
			if (toolName === "tenant") {
				const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: `Tenant ${index} ${"display ".repeat(60)}` });
				await tenantStore.close();
			} else {
				await store.createEntity({ kind: "issue", title: `Issue ${index} ${"summary ".repeat(640)}` });
			}
		}
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "live-list-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const request = toolName === "orphanEntity" ? { kind: "issue" } : {};
			const collection = toolName === "tenant" ? "tenants" : "entities";
			const first = await client.callTool(collectionCall(toolName, request));
			const firstPage = first.structuredContent as { tenants?: Array<{ id: string }>; entities?: Array<{ id: string }>; nextContinuation: string };
			const seen = firstPage[collection]!;
			const after = seen.at(-1)!.id;
			expect(firstPage.nextContinuation).toEqual(expect.any(String));
			if (toolName === "tenant") {
				await store.deleteTenant(seen.find((tenant) => tenant.id !== store.tenantId)!.id);
				const later = (await store.listTenants()).filter((tenant) => tenant.id > after);
				await store.renameTenant(later.at(-1)!.id, "Renamed tenant");
				for (let index = 0; index < 8; index++) {
					const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: `Inserted tenant ${index}` });
					await tenantStore.close();
				}
			} else {
				await store.deleteEntity({ entityId: seen[0].id });
				const later = (await store.listOrphans("issue")).filter((entity) => entity.id > after).toSorted((first, second) => first.id < second.id ? -1 : 1);
				const parent = await store.createEntity({ kind: "initiative", title: "New parent" });
				await store.moveEntity({ entityId: later.at(-1)!.id, newParentId: parent.id });
				await store.updateEntity({ entityId: later[0].id, title: "Updated orphan", expectedRevision: later[0].revision, expectedContentHash: later[0].contentHash });
				for (let index = 0; index < 8; index++) await store.createEntity({ kind: "issue", title: `Inserted orphan ${index}` });
			}
			const current = toolName === "tenant" ? await store.listTenants() : await store.listOrphans("issue");
			const expected = current.filter((item) => item.id > after).map((item) => item.id).sort();
			const remaining: string[] = [];
			let continuation: string | null = firstPage.nextContinuation;
			let pages = 0;
			do {
				const result = await client.callTool(collectionCall(toolName, { ...request, continuation }));
				expect(result.isError).not.toBe(true);
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				const page = result.structuredContent as { tenants?: Array<{ id: string }>; entities?: Array<{ id: string }>; nextContinuation: string | null };
				remaining.push(...page[collection]!.map((item) => item.id));
				continuation = page.nextContinuation;
				expect(++pages).toBeLessThan(30);
			} while (continuation !== null);
			expect(remaining).toEqual(expected);
			expect(remaining.every((id) => !seen.some((item) => item.id === id))).toBe(true);
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it.each(["tenant", "orphanEntity"])("returns a bounded error for one oversized %s summary", async (toolName) => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-oversized-list-"));
		directories.push(directory);
		const dbPath = path.join(directory, "lists.db");
		const { store } = await openSqliteStore(dbPath);
		const title = "\u{1F680}\"\\".repeat(12_000);
		if (toolName === "tenant") {
			const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "long-tenant-name".repeat(8_000) });
			await tenantStore.close();
		} else {
			await store.createEntity({ kind: "issue", title });
		}
		const server = createMcpServer({ openStore: async () => store });
		const client = new Client({ name: "oversized-list-test", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			let continuation: string | null = null;
			let pages = 0;
			for (;;) {
				const result = await client.callTool(collectionCall(toolName, { ...(toolName === "orphanEntity" ? { kind: "issue" } : {}), ...(continuation ? { continuation } : {}) }));
				expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(65536);
				if (result.isError) {
					expect(result.structuredContent).toBeUndefined();
					expect((result.content as Array<{ text: string }>)[0].text).toContain("65536-byte response budget");
					break;
				}
				continuation = (result.structuredContent as { nextContinuation: string | null }).nextContinuation;
				expect(continuation).toEqual(expect.any(String));
				expect(++pages).toBeLessThan(3);
			}
		} finally {
			await client.close();
			await server.close();
			await store.close();
		}
	});

	it("renames a tenant through tenant_rename", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-source" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({
			name: "tenant_rename",
			arguments: { previousTenantId: "tenant-source", newTenantId: "tenant-renamed" }
		});

		expect(result).toMatchObject({ structuredContent: { previousTenantId: "tenant-source", newTenantId: "tenant-renamed", renamed: true } });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("deletes a tenant through resource_delete after inspection", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-delete" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "inspect", tenantId: "tenant-delete" } }
		});
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "delete", tenantId: "tenant-delete", confirmationToken } }
		});

		expect(inspection).toMatchObject({ structuredContent: { impact: { id: "tenant-delete" }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { tenantId: "tenant-delete", removed: true } });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects expired confirmation tokens", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-expired" });
		let now = Date.UTC(2026, 0, 1);
		const server = createMcpServer({ openStore: async () => store, now: () => now });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "inspect", tenantId: "tenant-expired" } }
		});
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		now += 5 * 60 * 1000;
		const result = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "delete", tenantId: "tenant-expired", confirmationToken } }
		});

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("has expired") }] });
		expect(await store.listTenants()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tenant-expired" })]));

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects a replayed confirmation token", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: tenantStore } = await openSqliteStore(dbPath, { tenant: "tenant-replay" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "inspect", tenantId: "tenant-replay" } }
		});
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "delete", tenantId: "tenant-replay", confirmationToken } }
		});
		const result = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "delete", tenantId: "tenant-replay", confirmationToken } }
		});

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Invalid confirmation token") }] });

		await client.close();
		await server.close();
		await tenantStore.close();
		await store.close();
	});

	it("rejects a confirmation token for a different tenant deletion", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const { store } = await openSqliteStore(dbPath);
		const { store: sourceStore } = await openSqliteStore(dbPath, { tenant: "tenant-source" });
		const { store: targetStore } = await openSqliteStore(dbPath, { tenant: "tenant-target" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "inspect", tenantId: "tenant-source" } }
		});
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({
			name: "resource_delete",
			arguments: { request: { resource: "tenant", action: "delete", tenantId: "tenant-target", confirmationToken } }
		});

		expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("does not authorize") }] });
		expect(await store.listTenants()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tenant-source" }), expect.objectContaining({ id: "tenant-target" })]));

		await client.close();
		await server.close();
		await sourceStore.close();
		await targetStore.close();
		await store.close();
	});

	it("requires inspection before entity_restore", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		const issue = await store.createEntity({ kind: "issue", title: "Original title", body: "Original body" });
		await store.updateEntity({
			entityId: issue.id,
			title: "Updated title",
			expectedRevision: issue.revision,
			expectedContentHash: issue.contentHash
		});
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "entity_restore_inspect", arguments: { entityId: issue.id, revision: 1 } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "entity_restore", arguments: { entityId: issue.id, revision: 1, confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { entityId: issue.id, title: "Original title" }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { entityId: issue.id, title: "Original title", restoredFromRevision: 1 } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("requires inspection before body_backfill", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-server-"));
		directories.push(directory);
		const { store } = await openSqliteStore(path.join(directory, "agent-issues.db"));
		await store.createEntity({ kind: "issue", title: "Backfill this body" });
		const server = createMcpServer({ openStore: async () => store });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const inspection = await client.callTool({ name: "body_backfill_inspect", arguments: { kinds: ["issue"] } });
		const confirmationToken = (inspection.structuredContent as { confirmationToken: string }).confirmationToken;
		const result = await client.callTool({ name: "body_backfill", arguments: { kinds: ["issue"], confirmationToken } });

		expect(inspection).toMatchObject({ structuredContent: { impact: { dryRun: true, updated: 1 }, confirmationToken: expect.any(String) } });
		expect(result).toMatchObject({ structuredContent: { dryRun: false, updated: 1 } });

		await client.close();
		await server.close();
		await store.close();
	});

	it("starts a missing local daemon once and reads entity details through it", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-daemon-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const homeDirectory = path.join(directory, "home");
		const credentialStoreOptions = fakeCredentialStore();
		const { store } = await openSqliteStore(dbPath, { tenant: resolveWellKnownLocalTenantId() });
		const issue = await store.createEntity({ kind: "issue", title: "Read through the daemon" });
		await store.close();

		let daemon: LocalDaemonServerHandle | undefined;
		let spawnCount = 0;
		const server = createLocalMcpServer({
			dbPath,
			homeDirectory,
			credentialStoreOptions,
			spawn: () => {
				spawnCount++;
				daemon = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions, idleTimeoutMs: 0 });
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const result = await client.callTool({ name: "resource_show", arguments: { request: { resource: "entity", reference: issue.reference } } });
		const created = await client.callTool({ name: "resource_create", arguments: { request: { resource: "entity", kind: "issue", title: "Create through the daemon" } } });

		expect(result).toMatchObject({ structuredContent: { entity: { reference: issue.reference, title: "Read through the daemon" } } });
		expect(created).toMatchObject({ structuredContent: { entity: { title: "Create through the daemon" } } });
		expect(spawnCount).toBe(1);

		await client.close();
		await server.close();
		await daemon?.close();
	});

	it("writes authored comment and Plan-entry bodies through the local daemon", async () => {
		const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-mcp-daemon-"));
		directories.push(directory);
		const dbPath = path.join(directory, "agent-issues.db");
		const homeDirectory = path.join(directory, "home");
		const credentialStoreOptions = fakeCredentialStore();
		const { store } = await openSqliteStore(dbPath, { tenant: resolveWellKnownLocalTenantId() });
		const initiative = await store.createEntity({ kind: "initiative", title: "Daemon initiative" });
		const plan = await store.createEntity({ kind: "plan", title: "Daemon Plan", parentId: initiative.id });
		const issue = await store.createEntity({ kind: "issue", title: "Daemon issue" });
		await store.close();

		let daemon: LocalDaemonServerHandle | undefined;
		let spawnCount = 0;
		const server = createLocalMcpServer({
			dbPath,
			homeDirectory,
			credentialStoreOptions,
			spawn: () => {
				spawnCount++;
				daemon = createLocalDaemonServer({ dbPath, homeDirectory, credentialStoreOptions, idleTimeoutMs: 0 });
			}
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent-issues-test", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const comment = await client.callTool({ name: "resource_create", arguments: { request: { resource: "comment", issueId: issue.reference, body: "Authored daemon comment" } } });
		const entry = await client.callTool({ name: "resource_create", arguments: { request: { resource: "planEntry", planId: plan.reference, role: "decision", body: "Authored daemon decision" } } });

		expect(comment).toMatchObject({ structuredContent: { comment: { issueId: issue.id } } });
		expect((comment.structuredContent as { comment: object }).comment).not.toHaveProperty("body");
		expect(entry).toMatchObject({ structuredContent: { entry: { planId: plan.id } } });
		expect((entry.structuredContent as { entry: object }).entry).not.toHaveProperty("body");
		expect(spawnCount).toBe(1);

		await client.close();
		await server.close();
		await daemon?.close();
	});
});