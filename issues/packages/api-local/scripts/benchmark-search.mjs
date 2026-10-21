import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { openSqliteStore } from "../dist/index.js";

const RECORDS_PER_PROJECT = Number.parseInt(process.env.SEARCH_BENCHMARK_RECORDS_PER_PROJECT ?? "100", 10);
const MEASURED_QUERIES = Number.parseInt(process.env.SEARCH_BENCHMARK_QUERIES ?? "100", 10);
const TENANT_ID = "search-benchmark";

if (!Number.isSafeInteger(RECORDS_PER_PROJECT) || RECORDS_PER_PROJECT < 1) {
	throw new Error("SEARCH_BENCHMARK_RECORDS_PER_PROJECT must be a positive integer.");
}
if (!Number.isSafeInteger(MEASURED_QUERIES) || MEASURED_QUERIES < 1) {
	throw new Error("SEARCH_BENCHMARK_QUERIES must be a positive integer.");
}

const directory = mkdtempSync(path.join(tmpdir(), "agent-issues-search-benchmark-"));
const dbPath = path.join(directory, "search.db");
const primary = await openSqliteStore(dbPath, { tenant: TENANT_ID, projectIdentity: "primary" });
const secondary = await openSqliteStore(dbPath, { tenant: TENANT_ID, projectIdentity: "secondary" });

try {
	await seedProject(primary.store, "Primary");
	await seedProject(secondary.store, "Secondary");

	const queryTimings = {
		currentProject: await measure(MEASURED_QUERIES, () => primary.store.search({ query: "observability", scope: { type: "current-project", projectId: "primary" } })),
		allProjects: await measure(MEASURED_QUERIES, () => primary.store.search({ query: "observability", scope: { type: "all-projects" } })),
		typoAllProjects: await measure(MEASURED_QUERIES, () => primary.store.search({ query: "observabilty", scope: { type: "all-projects" } }))
	};
	const mutationTiming = await measure(1, () => primary.store.createEntity({
		kind: "issue",
		title: "Search benchmark mutation",
		body: "This document measures observability, ranking, and candidate retrieval costs."
	}));
	const canonicalChains = await primary.store.exportCanonicalChains();
	const rebuildTiming = await measure(1, () => primary.store.importCanonicalChains(canonicalChains));
	const diagnostics = await primary.store.getSearchDiagnostics();

	console.log(JSON.stringify({
		dataset: {
			recordsPerProject: RECORDS_PER_PROJECT,
			projects: 2,
			totalSeededRecords: RECORDS_PER_PROJECT * 2
		},
		queryTimings,
		mutationTiming,
		rebuildTiming,
		storageBytes: readSearchStorageBytes(dbPath),
		latestDiagnostics: diagnostics.slice(-2)
	}, null, 2));
} finally {
	await primary.store.close();
	await secondary.store.close();
	rmSync(directory, { force: true, recursive: true });
}

async function seedProject(store, projectLabel) {
	for (let recordIndex = 0; recordIndex < RECORDS_PER_PROJECT; recordIndex += 1) {
		await store.createEntity({
			kind: "issue",
			title: `${projectLabel} search record ${recordIndex}`,
			body: `This searchable record contains observability and ranking data for benchmark scenario ${recordIndex}.`
		});
	}
}

async function measure(iterations, operation) {
	const durations = [];
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const startedAt = performance.now();
		await operation();
		durations.push(performance.now() - startedAt);
	}
	const sortedDurations = [...durations].sort((left, right) => left - right);
	return {
		iterations,
		averageMs: durations.reduce((total, duration) => total + duration, 0) / durations.length,
		p95Ms: sortedDurations[Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * 0.95) - 1)]
	};
}

function readSearchStorageBytes(dbPath) {
	const database = new Database(dbPath, { readonly: true });
	try {
		const rows = database.prepare(`
			SELECT
				CASE
					WHEN name GLOB 'search_documents_fts*' THEN 'tokenFts'
					WHEN name GLOB 'search_documents_trigram*' THEN 'trigramFts'
					WHEN name GLOB 'search_typo_vocabulary*' THEN 'typoVocabulary'
					ELSE 'searchDocuments'
				END AS component,
				SUM(pgsize) AS bytes
			FROM dbstat
			WHERE name GLOB 'search_documents*' OR name GLOB 'search_typo_vocabulary*'
			GROUP BY component
		`).all();
		return Object.fromEntries(rows.map((row) => [row.component, row.bytes]));
	} finally {
		database.close();
	}
}
