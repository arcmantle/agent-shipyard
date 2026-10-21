import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runStorageDriverContractSuite } from "@agent-issues/core/storage-driver-contract";
import type { StorageDriver } from "@agent-issues/core";
import { openSqliteStore } from "./sqlite-store.js";

let tempDir: string | null = null;

function openTestStore(): Promise<StorageDriver> {
	tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-"));
	return openSqliteStore(path.join(tempDir, "test.db"), { tenant: "test" }).then((result) => result.store);
}

// Both identities open the same database file and tenant, so the contract's
// separation assertions are about project scoping rather than about two
// unrelated databases.
let contractDir: string | null = null;
function openTestStoreForProject(projectIdentity: string): Promise<StorageDriver> {
	contractDir ??= mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-project-"));
	return openSqliteStore(path.join(contractDir, "test.db"), { tenant: "test", projectIdentity }).then((result) => result.store);
}

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = null;
	}

	if (contractDir) {
		rmSync(contractDir, { force: true, recursive: true });
		contractDir = null;
	}
});

runStorageDriverContractSuite({ label: "SqliteStore", openStore: openTestStore, openStoreForProject: openTestStoreForProject });

describe("storage-driver seam: selected-project relations (SqliteStore)", () => {
	it("shows the selected project as a version's structural parent", async () => {
		const store = await openTestStoreForProject("selected-project-parent");

		try {
			const discovery = await store.getProjectDiscovery();
			expect(discovery.kind).toBe("available");
			if (discovery.kind !== "available") {
				return;
			}
			const project = discovery.projects.find((entry) => entry.project.title === "selected-project-parent")!.project;
			const version = await store.createEntity({ kind: "version", parentId: project.id, title: "1.0.0" });

			await expect(store.getEntityDetails(version.id)).resolves.toMatchObject({
				incoming: [expect.objectContaining({ relationType: "owns", entity: expect.objectContaining({ id: project.id }) })]
			});
			await expect(store.queryEntityRelations({ entityId: version.id, direction: "incoming" })).resolves.toMatchObject({
				incoming: [expect.objectContaining({ relationType: "owns", entity: expect.objectContaining({ id: project.id }) })]
			});
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: search capability (SqliteStore)", () => {
	it("records privacy-safe diagnostics for each search", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Searchable initiative" });

			await store.search({ query: entity.reference, scope: { type: "all-projects" } });

			expect(await store.getSearchDiagnostics()).toEqual([{
				candidateCounts: {
					fullText: 0,
					identity: 1,
					typo: 0
				},
				capability: { state: "available" },
				durationMs: expect.any(Number),
				resultCount: 1
			}]);
		} finally {
			await store.close();
		}
	});

	it("limits merged search candidates across all search paths", async () => {
		const store = await openTestStore();

		try {
			for (let recordIndex = 0; recordIndex < 120; recordIndex += 1) {
				await store.createEntity({
					kind: "initiative",
					title: `Search candidate ${recordIndex}`,
					body: "Search candidate content."
				});
			}

			await store.search({ query: "Search", scope: { type: "all-projects" } });

			const [diagnostic] = await store.getSearchDiagnostics();
			expect(diagnostic!.candidateCounts.identity + diagnostic!.candidateCounts.fullText + diagnostic!.candidateCounts.typo).toBeLessThanOrEqual(100);
		} finally {
			await store.close();
		}
	});

	it("searches visible Search document content with a highlighted snippet", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({
				kind: "initiative",
				title: "Searchable initiative",
				body: "The ranked retrieval engine evaluates every query term."
			});

			await expect(store.search({ query: "ranked retrieval", scope: { type: "all-projects" } })).resolves.toEqual({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: entity.id }),
					match: { field: "body" },
					snippet: {
						text: "The ranked retrieval engine evaluates every query term.",
						highlights: [{ start: 4, end: 20 }]
					}
				})]
			});
		} finally {
			await store.close();
		}
	});

	it("searches a three-character substring in Search document content", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({
				kind: "initiative",
				title: "Searchable initiative",
				body: "The storage contract has one shared search boundary."
			});

			await expect(store.search({ query: "tract", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }), match: { field: "body" } })]
			}));
		} finally {
			await store.close();
		}
	});

	it("identifies a trigram title match as the strongest matching field", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Storage contract" });

			await expect(store.search({ query: "tract", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }), match: { field: "title" } })]
			}));
		} finally {
			await store.close();
		}
	});

	it("finds a Search document for a one-edit content typo", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({
				kind: "initiative",
				title: "Searchable initiative",
				body: "The retrieval system ranks matching records."
			});

			await expect(store.search({ query: "retrival", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: entity.id }),
					match: { field: "body" },
					snippet: {
						text: "The retrieval system ranks matching records.",
						highlights: [{ start: 4, end: 13 }]
					}
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("combines typo-tolerant and exact plain query terms", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({
				kind: "initiative",
				title: "Searchable initiative",
				body: "The retrieval system ranks matching records."
			});

			await expect(store.search({ query: "retrival records", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }), match: { field: "body" } })]
			}));
		} finally {
			await store.close();
		}
	});

	it("supports transpositions and permitted two-edit content typos", async () => {
		const store = await openTestStore();

		try {
			const transposition = await store.createEntity({ kind: "initiative", title: "Searchable initiative", body: "The retrieval system ranks records." });
			const twoEdits = await store.createEntity({ kind: "initiative", title: "Searchable configuration", body: "The configuration has a default value." });

			await expect(store.search({ query: "retreival", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: expect.arrayContaining([expect.objectContaining({ identity: expect.objectContaining({ sourceId: transposition.id }) })])
			}));
			await expect(store.search({ query: "cnfigurtion", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: expect.arrayContaining([expect.objectContaining({ identity: expect.objectContaining({ sourceId: twoEdits.id }) })])
			}));
			await expect(store.search({ query: "cnfigrtion", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
		} finally {
			await store.close();
		}
	});

	it("finds Unicode content through a normalized typo and highlights the source text", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({
				kind: "initiative",
				title: "Searchable initiative",
				body: "A café contains indexed records."
			});

			await expect(store.search({ query: "caff", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: entity.id }),
					snippet: {
						text: "A café contains indexed records.",
						highlights: [{ start: 2, end: 6 }]
					}
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("does not expand strict terms or identity values through typo matching", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Searchable initiative", body: "The retrieval system ranks records." });
			const mistypedReference = `${entity.reference.slice(0, -1)}${entity.reference.endsWith("X") ? "Y" : "X"}`;

			await expect(store.search({ query: '"retrival"', scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			await expect(store.search({ query: "retrival*", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			await expect(store.search({ query: mistypedReference, scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
		} finally {
			await store.close();
		}
	});

	it("returns no more than twenty final search results", async () => {
		const store = await openTestStore();

		try {
			await Promise.all(Array.from({ length: 25 }, (_, index) => store.createEntity({
				kind: "initiative",
				title: `Matching result ${index}`
			})));

			const response = await store.search({ query: "matching", scope: { type: "all-projects" }, limit: 100 });
			expect(response).toEqual(expect.objectContaining({ state: "available" }));
			if (response.state !== "available") {
				throw new Error("SQLite search must be available.");
			}
			expect(response.results).toHaveLength(20);
		} finally {
			await store.close();
		}
	});

	it("executes a structured NEAR query against a Search document", async () => {
		const store = await openTestStore();

		try {
			const nearMatch = await store.createEntity({
				kind: "initiative",
				title: "Near match",
				body: "The ranked retrieval engine evaluates every query term."
			});
			await store.createEntity({
				kind: "initiative",
				title: "Distant match",
				body: "The ranked result has several unrelated words before the retrieval engine."
			});

			await expect(store.search({ query: '"ranked retrieval" NEAR/2 engine', scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: nearMatch.id }) })]
			}));
		} finally {
			await store.close();
		}
	});

	it("excludes Search documents that match a NOT term", async () => {
		const store = await openTestStore();

		try {
			const match = await store.createEntity({
				kind: "initiative",
				title: "Included result",
				body: "Ranked retrieval evaluates query terms."
			});
			await store.createEntity({
				kind: "initiative",
				title: "Excluded result",
				body: "Ranked retrieval excludes draft query terms."
			});

			await expect(store.search({ query: "ranked NOT draft", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: match.id }) })]
			}));
		} finally {
			await store.close();
		}
	});

	it("executes nested OR and NOT query expressions", async () => {
		const store = await openTestStore();

		try {
			const firstMatch = await store.createEntity({ kind: "initiative", title: "First match", body: "Alpha query." });
			const secondMatch = await store.createEntity({ kind: "initiative", title: "Second match", body: "Fallback query." });
			const excludedMatch = await store.createEntity({ kind: "initiative", title: "Excluded match", body: "Alpha excluded query." });

			const response = await store.search({ query: "(alpha OR fallback) AND NOT excluded", scope: { type: "all-projects" } });

			expect(response).toEqual(expect.objectContaining({ state: "available" }));
			if (response.state !== "available") {
				throw new Error("SQLite search must be available.");
			}
			expect(new Set(response.results.map((result) => result.identity.sourceId))).toEqual(new Set([firstMatch.id, secondMatch.id]));
			expect(response.results.some((result) => result.identity.sourceId === excludedMatch.id)).toBe(false);
		} finally {
			await store.close();
		}
	});

	it("executes a strict prefix query against a Search document", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Prefix result", body: "Searchable query result." });

			await expect(store.search({ query: "search*", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }) })]
			}));
		} finally {
			await store.close();
		}
	});

	it("ranks an exact title match ahead of a newer title prefix match", async () => {
		const store = await openTestStore();

		try {
			const exactMatch = await store.createEntity({ kind: "initiative", title: "Ranked" });
			await store.createEntity({ kind: "initiative", title: "Ranked retrieval" });

			await expect(store.search({ query: "ranked", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: exactMatch.id }), match: { field: "title" } }),
					expect.objectContaining({ match: { field: "title" } })
				]
			}));
		} finally {
			await store.close();
		}
	});

	it("identifies an FTS title match as the strongest matching field", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "The retrieval system" });

			await expect(store.search({ query: "retrieval", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: entity.id }),
					match: { field: "title" }
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("searches a Plan entry by its exact reference", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Search Plan", parentId: initiative.id });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Index this Plan entry." });

			await expect(store.search({ query: entry.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: entry.id, sourceType: "plan-entry" }),
					navigationTarget: { type: "plan-entry", planId: plan.id, entryId: entry.id }
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("searches an issue comment by its exact reference", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const issue = await store.createEntity({ kind: "issue", title: "Search issue", parentId: initiative.id });
			const comment = await store.createIssueComment({ issueId: issue.id, body: "Index this issue comment." });

			await expect(store.search({ query: comment.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: comment.id, sourceType: "issue-comment" }),
					navigationTarget: { type: "issue-comment", issueId: issue.id, commentId: comment.id }
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("searches a scoped context by its exact reference", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const { context } = await store.upsertContext({
				scopeRef: initiative.id,
				title: "Search context",
				summary: "Index this context summary."
			});
			if (!context.reference) {
				throw new Error("Created context must have a reference.");
			}

			await expect(store.search({ query: context.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: context.id, sourceType: "context" }),
					navigationTarget: { type: "context", scopeRef: initiative.id }
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("searches a context term by its exact reference", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const { term } = await store.defineContextTerm({
				scopeRef: initiative.id,
				term: "Search term",
				definition: "Index this context term."
			});

			await expect(store.search({ query: term.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: term.id, sourceType: "context-term" }),
					navigationTarget: { type: "context-term", scopeRef: initiative.id, term: term.term }
				})]
			}));
		} finally {
			await store.close();
		}
	});

	it("filters projected Search documents by source type", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Search Plan", parentId: initiative.id });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Index this Plan entry." });

			await expect(store.search({
				query: entry.reference,
				scope: { type: "all-projects" },
				filters: { sourceTypes: ["entity"] }
			})).resolves.toEqual({ state: "available", results: [] });
			await expect(store.search({
				query: entry.reference,
				scope: { type: "all-projects" },
				filters: { sourceTypes: ["plan-entry"] }
			})).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entry.id }) })]
			}));
		} finally {
			await store.close();
		}
	});

	it("stores visible Markdown text in Plan-entry Search documents", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-markdown-"));
		const dbPath = path.join(tempDir, "test.db");
		const { store } = await openSqliteStore(dbPath, { tenant: "test" });

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Search Plan", parentId: initiative.id });
			const entry = await store.createPlanEntry({
				planId: plan.id,
				role: "decision",
				body: "# Visible heading\n\n[Visible label](https://example.com) and `visibleCode`."
			});
			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const document = inspection.prepare("SELECT body FROM search_documents WHERE tenant_id = ? AND source_type = 'plan-entry' AND source_id = ?").get("test", entry.id) as { body: string };
			inspection.close();

			expect(document.body).toContain("Visible heading");
			expect(document.body).toContain("Visible label");
			expect(document.body).toContain("visibleCode");
			expect(document.body).not.toContain("#");
			expect(document.body).not.toContain("https://example.com");
		} finally {
			await store.close();
		}
	});

	it("does not rebuild Search documents for Plan-entry issue links", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-plan-entry-link-"));
		const dbPath = path.join(tempDir, "test.db");
		const { store } = await openSqliteStore(dbPath, { tenant: "test" });

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Search Plan", parentId: initiative.id });
			const issue = await store.createEntity({ kind: "issue", title: "Search Issue", parentId: initiative.id });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Index this Plan entry." });
			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const rowIdBefore = (inspection.prepare("SELECT rowid FROM search_documents WHERE tenant_id = ? AND source_type = 'entity' AND source_id = ?").get("test", issue.id) as { rowid: number }).rowid;

					await store.linkPlanEntryEntity({ entryId: entry.id, targetId: issue.id });
					await store.unlinkPlanEntryEntity({ entryId: entry.id, targetId: issue.id });

			const rowIdAfter = (inspection.prepare("SELECT rowid FROM search_documents WHERE tenant_id = ? AND source_type = 'entity' AND source_id = ?").get("test", issue.id) as { rowid: number }).rowid;
			inspection.close();
			expect(rowIdAfter).toBe(rowIdBefore);
		} finally {
			await store.close();
		}
	});

	it("updates only the affected Plan-entry Search document", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-plan-entry-search-"));
		const dbPath = path.join(tempDir, "test.db");
		const { store } = await openSqliteStore(dbPath, { tenant: "test" });

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Search Plan", parentId: initiative.id });
			const issue = await store.createEntity({ kind: "issue", title: "Stable Search Issue", parentId: initiative.id });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Initial indexed decision." });
			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const unrelatedRowId = (inspection.prepare("SELECT rowid FROM search_documents WHERE tenant_id = ? AND source_type = 'entity' AND source_id = ?").get("test", issue.id) as { rowid: number }).rowid;

			const updated = await store.updatePlanEntry({
				entryId: entry.id,
				body: "Updated indexed decision.",
				expectedRevision: entry.revision,
				expectedContentHash: entry.contentHash
			});
			await expect(store.search({ query: "Initial indexed decision", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			await expect(store.search({ query: "Updated indexed decision", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entry.id }) })]
			}));
			expect((inspection.prepare("SELECT rowid FROM search_documents WHERE tenant_id = ? AND source_type = 'entity' AND source_id = ?").get("test", issue.id) as { rowid: number }).rowid).toBe(unrelatedRowId);

			await store.deletePlanEntry({ entryId: entry.id, expectedRevision: updated.revision, expectedContentHash: updated.contentHash });
			await expect(store.search({ query: "Updated indexed decision", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			inspection.close();
		} finally {
			await store.close();
		}
	});

	it("removes and restores a context-term Search document", async () => {
		const store = await openTestStore();

		try {
			const initiative = await store.createEntity({ kind: "initiative", title: "Search Initiative" });
			const created = await store.defineContextTerm({
				scopeRef: initiative.id,
				term: "Search term",
				definition: "Initial definition."
			});
			const deleted = await store.forgetContextTerm({
				scopeRef: initiative.id,
				term: created.term.term,
				expectedRevision: created.term.revision,
				expectedContentHash: created.term.contentHash
			});

			await expect(store.search({ query: created.term.reference, scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });

			await store.defineContextTerm({
				scopeRef: initiative.id,
				term: created.term.term,
				definition: "Restored definition.",
				expectedRevision: deleted.currentRevision,
				expectedContentHash: deleted.currentContentHash
			});

			await expect(store.search({ query: created.term.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: created.term.id }) })]
			}));
		} finally {
			await store.close();
		}
	});

	it("updates and removes the entity Search document with its source entity", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Initial title" });
			const updated = await store.updateEntity({
				entityId: entity.id,
				title: "Updated title",
				expectedRevision: entity.revision,
				expectedContentHash: entity.contentHash
			});

			await expect(store.search({ query: "Initial title", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			await expect(store.search({ query: "Updated title", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }) })]
			}));

			await store.deleteEntity({ entityId: updated.id });

			await expect(store.search({ query: "Updated title", scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
		} finally {
			await store.close();
		}
	});

	it("refreshes dependent Search documents for entity label and parent changes", async () => {
		const store = await openTestStore();

		try {
			const firstInitiative = await store.createEntity({ kind: "initiative", title: "First Initiative" });
			const secondInitiative = await store.createEntity({ kind: "initiative", title: "Second Initiative" });
			const plan = await store.createEntity({ kind: "plan", title: "Initial Plan", parentId: firstInitiative.id });
			const entry = await store.createPlanEntry({ planId: plan.id, role: "decision", body: "Dependent Plan entry." });
			const issue = await store.createEntity({ kind: "issue", title: "Initial Issue", parentId: firstInitiative.id });
			const comment = await store.createIssueComment({ issueId: issue.id, body: "Dependent comment body." });
			const renamedInitiative = await store.updateEntity({
				entityId: firstInitiative.id,
				title: "Renamed Initiative",
				expectedRevision: firstInitiative.revision,
				expectedContentHash: firstInitiative.contentHash
			});
			await expect(store.search({ query: issue.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ parentLabel: renamedInitiative.title })]
			}));

			const renamedIssue = await store.updateEntity({
				entityId: issue.id,
				title: "Renamed Issue",
				expectedRevision: issue.revision,
				expectedContentHash: issue.contentHash
			});
			await expect(store.search({ query: comment.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ title: renamedIssue.title })]
			}));
			const currentPlan = (await store.getEntityDetails(plan.id)).entity;
			const renamedPlan = await store.updateEntity({
				entityId: currentPlan.id,
				title: "Renamed Plan",
				expectedRevision: currentPlan.revision,
				expectedContentHash: currentPlan.contentHash
			});
			await expect(store.search({ query: entry.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ title: renamedPlan.title, parentLabel: renamedPlan.title })]
			}));

			await store.moveEntity({ entityId: issue.id, newParentId: secondInitiative.id });
			await expect(store.search({ query: issue.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ parentLabel: secondInitiative.title })]
			}));
		} finally {
			await store.close();
		}
	});

	it("removes Search documents when a tenant is deleted", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-search-tenant-"));
		const dbPath = path.join(tempDir, "test.db");
		const betaStore = (await openSqliteStore(dbPath, { tenant: "beta" })).store;

		try {
			const entity = await betaStore.createEntity({ kind: "initiative", title: "Deleted tenant result" });
			await betaStore.deleteTenant("beta");
			await betaStore.close();

			const reopenedStore = (await openSqliteStore(dbPath, { tenant: "beta" })).store;
			try {
				await expect(reopenedStore.search({ query: entity.reference, scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			} finally {
				await reopenedStore.close();
			}
		} finally {
			await betaStore.close();
		}
	});

	it("preserves Search documents when a tenant is renamed", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-search-tenant-"));
		const dbPath = path.join(tempDir, "test.db");
		const originalStore = (await openSqliteStore(dbPath, { tenant: "original" })).store;

		try {
			const entity = await originalStore.createEntity({ kind: "initiative", title: "Renamed tenant result" });
			await originalStore.renameTenant("original", "renamed");
			await originalStore.close();

			const renamedStore = (await openSqliteStore(dbPath, { tenant: "renamed" })).store;
			try {
				await expect(renamedStore.search({ query: entity.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
					state: "available",
					results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }) })]
				}));
			} finally {
				await renamedStore.close();
			}
		} finally {
			await originalStore.close();
		}
	});

	it("returns exact and prefix identity and title matches in ranking order", async () => {
		const store = await openTestStore();

		try {
			const exactTitle = await store.createEntity({ kind: "initiative", title: "Search" });
			const prefixTitle = await store.createEntity({ kind: "initiative", title: "Search result" });

			await expect(store.search({ query: exactTitle.id, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({
					identity: expect.objectContaining({ sourceId: exactTitle.id }),
					match: { field: "identity" }
				})]
			}));
			await expect(store.search({ query: exactTitle.reference.slice(0, 8), scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: expect.arrayContaining([
					expect.objectContaining({
						identity: expect.objectContaining({ sourceId: exactTitle.id }),
						match: { field: "identity" }
					})
				])
			}));
			await expect(store.search({ query: "Search", scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: exactTitle.id }), match: { field: "title" } }),
					expect.objectContaining({ identity: expect.objectContaining({ sourceId: prefixTitle.id }), match: { field: "title" } })
				]
			}));
		} finally {
			await store.close();
		}
	});

	it("removes deleted entities and restores their Search documents", async () => {
		const store = await openTestStore();

		try {
			const entity = await store.createEntity({ kind: "initiative", title: "Restorable search result" });
			const deleted = await store.deleteEntity({ entityId: entity.id });

			await expect(store.search({ query: entity.reference, scope: { type: "all-projects" } })).resolves.toEqual({ state: "available", results: [] });
			await store.restoreEntityRevision({
				entityId: entity.id,
				revision: entity.revision,
				expectedRevision: deleted.entity.revision,
				expectedContentHash: deleted.entity.contentHash
			});
			await expect(store.search({ query: entity.reference, scope: { type: "all-projects" } })).resolves.toEqual(expect.objectContaining({
				state: "available",
				results: [expect.objectContaining({ identity: expect.objectContaining({ sourceId: entity.id }) })]
			}));
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: persisted Stable identity (SqliteStore)", () => {
	it("stores the UUID, Canonical reference, and short reference separately", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-identity-"));
		const dbPath = path.join(tempDir, "test.db");
		const store = (await openSqliteStore(dbPath, { tenant: "test" })).store;

		try {
			const created = await store.createEntity({ kind: "initiative", title: "Persisted identity" });
			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const row = inspection.prepare("SELECT id, reference, short_reference FROM entities WHERE tenant_id = ? AND id = ?").get("test", created.id);
			inspection.close();

			expect(row).toEqual({ id: created.id, reference: created.reference, short_reference: created.shortReference });
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: revision patch hash persistence (SqliteStore)", () => {
	it("stores 32-byte hashes while exposing hexadecimal transitions", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-hashes-"));
		const dbPath = path.join(tempDir, "test.db");
		const store = (await openSqliteStore(dbPath, { tenant: "test" })).store;

		try {
			const created = await store.createEntity({ kind: "initiative", title: "First" });
			await store.updateEntity({ entityId: created.id, title: "Second", expectedRevision: created.revision, expectedContentHash: created.contentHash });

			const inspection = new Database(dbPath, { readonly: true, fileMustExist: true });
			const storedHashes = inspection.prepare(`SELECT typeof(source_hash) AS source_type, length(source_hash) AS source_length, typeof(target_hash) AS target_type, length(target_hash) AS target_length FROM revision_entries`).all();
			inspection.close();
			expect(storedHashes).not.toHaveLength(0);
			expect(storedHashes).toEqual(storedHashes.map(() => ({ source_type: "blob", source_length: 32, target_type: "blob", target_length: 32 })));

			const chain = (await store.exportCanonicalChains()).entities.find((candidate) => candidate.head.id === created.id);
			expect(chain?.deltas.every((delta) => /^[0-9a-f]{64}$/.test(delta.sourceHash) && /^[0-9a-f]{64}$/.test(delta.targetHash))).toBe(true);
			await expect(store.materializeEntityRevision({ entityId: created.id, revision: 1 })).resolves.toMatchObject({ title: "First", headRevision: 2 });
		} finally {
			await store.close();
		}
	});
});

describe("storage-driver seam: tenant administration (SqliteStore)", () => {
	it("lists, renames, and deletes tenants through the seam", async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "agent-issues-storage-driver-tenants-"));
		const dbPath = path.join(tempDir, "test.db");
		const alphaStore = (await openSqliteStore(dbPath, { tenant: "alpha-team" })).store;
		const betaStore = (await openSqliteStore(dbPath, { tenant: "beta-team" })).store;

		try {
			const initiative = await alphaStore.createEntity({ kind: "initiative", title: "Alpha" });
			const plan = await alphaStore.createEntity({ kind: "plan", title: "Alpha Plan", parentId: initiative.id });
			await alphaStore.createPlanEntry({ planId: plan.id, role: "question", body: "Does tenant rename preserve entries?" });
			await betaStore.createEntity({ kind: "initiative", title: "Beta" });

			expect((await alphaStore.listTenants()).map((tenant) => tenant.id)).toEqual(["alpha-team", "beta-team"]);

			const renamed = await alphaStore.renameTenant("alpha-team", "renamed-team");
			expect(renamed.renamed).toBe(true);
			expect(renamed.newTenantId).toBe("renamed-team");
			const renamedStore = (await openSqliteStore(dbPath, { tenant: "renamed-team" })).store;
			try {
				expect(await renamedStore.listPlanEntries({ planId: plan.id })).toHaveLength(1);
			} finally {
				await renamedStore.close();
			}

			const deleted = await betaStore.deleteTenant("beta-team");
			expect(deleted.removed).toBe(true);
		} finally {
			await alphaStore.close();
			await betaStore.close();
		}
	});
});
