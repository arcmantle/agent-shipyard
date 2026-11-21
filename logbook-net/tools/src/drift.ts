// Drift check: a TypeScript change must not silently invalidate the .NET golden-file oracle.
// It records the cases of the claimed Port slices from the TypeScript implementation again and compares each recording with its golden file.
// It never writes a golden file. A difference stays a failure until the golden files and the .NET code are updated.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyCliCase, MCP_TOOLS_LIST, type CoverageInventory, type SliceFile } from "./coverage.ts";
import type { Case } from "./cases.ts";
import { compareObservations, readGolden } from "./differ.ts";
import type { Observation } from "./recorder.ts";

/** The surfaces that a case drives. An MCP case that drives no tool, list or resource (a handshake case) belongs to the MCP server itself, the owner of `mcp:tools/list`. */
export function caseSurfaces(testCase: Case, inventory: CoverageInventory): string[] {
	if (testCase.surface === "cli") {
		const found = classifyCliCase(testCase, inventory.cli.commands);
		return found ? [found.target] : [];
	}
	if (testCase.surface === "rpc") return [...new Set(testCase.steps.map((step) => `rpc:${step.method}`))];
	const surfaces = new Set<string>();
	for (const step of testCase.steps) {
		const params = (step.params ?? {}) as { name?: unknown; uri?: unknown };
		if (step.method === "tools/call" && typeof params.name === "string") surfaces.add(`mcp:${params.name}`);
		if (step.method === "tools/list") surfaces.add(MCP_TOOLS_LIST);
		if (step.method === "resources/read" && typeof params.uri === "string") surfaces.add(`mcp-resource:${params.uri}`);
	}
	return surfaces.size > 0 ? [...surfaces] : [MCP_TOOLS_LIST];
}

export type DriftSelection = {
	/** Cases of a claimed slice: the drift check compares these. */
	ported: Case[];
	/** Cases that drive only surfaces that are not yet ported. They have no .NET implementation to protect, so they are not compared. */
	notYetPorted: Case[];
	/** Cases that no slice owns. A case must not leave the accounting silently, so this list makes the check fail. */
	unowned: Case[];
};

/** Splits the cases by the slice accounting. `sliceIds` limits the ported cases to the named claimed slices. */
export function selectPortedCases(cases: Case[], sliceFile: SliceFile, inventory: CoverageInventory, sliceIds?: string[]): DriftSelection {
	const claimedBy = new Map<string, string>();
	for (const slice of sliceFile.slices) if (slice.claimed) for (const surface of slice.surfaces) claimedBy.set(surface, slice.id);
	const pending = new Set(sliceFile.notYetPorted.flatMap((entry) => entry.surfaces));
	// A surface of an unclaimed (in development) slice is also not yet ported.
	for (const slice of sliceFile.slices) if (!slice.claimed) for (const surface of slice.surfaces) pending.add(surface);
	const selection: DriftSelection = { ported: [], notYetPorted: [], unowned: [] };
	for (const testCase of cases) {
		const surfaces = caseSurfaces(testCase, inventory);
		const owners = surfaces.flatMap((surface) => (claimedBy.has(surface) ? [claimedBy.get(surface)!] : []));
		if (owners.length > 0) {
			if (sliceIds === undefined || owners.some((owner) => sliceIds.includes(owner))) selection.ported.push(testCase);
		} else if (surfaces.some((surface) => pending.has(surface))) selection.notYetPorted.push(testCase);
		else selection.unowned.push(testCase);
	}
	return selection;
}

export type DriftResult = { id: string; status: "same" | "drift" | "error"; differences: string[]; message?: string };

export type DriftInput = {
	cases: Case[];
	goldenRoot: string;
	/** Records one case from the current TypeScript implementation. */
	record(testCase: Case): Promise<Observation>;
};

/**
 * Compares a fresh TypeScript recording of each case with its golden file. The comparison is the strict one of the differ:
 * array order, JSON type, literal content hashes, `null` versus absent all count. No intended-difference rule applies, because both sides are TypeScript results.
 * A missing golden file, or a recording that fails, is a failure and never a pass.
 */
export async function checkDrift(input: DriftInput): Promise<DriftResult[]> {
	const results: DriftResult[] = [];
	for (const testCase of input.cases) {
		let golden: Observation;
		try {
			golden = readGolden(input.goldenRoot, testCase.id);
		} catch (error) {
			results.push({ id: testCase.id, status: "error", differences: [], message: (error as Error).message });
			continue;
		}
		let fresh: Observation;
		try {
			fresh = await input.record(testCase);
		} catch (error) {
			results.push({ id: testCase.id, status: "error", differences: [], message: `recording failed: ${(error as Error).message}` });
			continue;
		}
		const differences = compareObservations(golden, fresh);
		results.push({ id: testCase.id, status: differences.length ? "drift" : "same", differences });
	}
	return results;
}

/** Golden files that belong to no case. They cannot be compared, so they are drift of the oracle itself. */
export function orphanGoldenFiles(goldenRoot: string, cases: Case[]): string[] {
	if (!existsSync(goldenRoot)) return [];
	const known = new Set(cases.map((testCase) => testCase.id));
	return readdirSync(goldenRoot, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".golden.json"))
		.map((file) => file.replace(/\.golden\.json$/, "").split(path.sep).join("/"))
		.filter((id) => !known.has(id))
		.sort();
}

export function formatDrift(results: DriftResult[], selection: DriftSelection, orphans: string[]): string {
	const lines: string[] = [];
	for (const result of results) {
		if (result.status === "same") continue;
		lines.push(`${result.status === "drift" ? "DRIFT" : "ERROR"} ${result.id}`);
		if (result.message) lines.push(`  ${result.message.split("\n").join("\n  ")}`);
		for (const line of result.differences) lines.push(`  ${line}`);
	}
	for (const testCase of selection.unowned) lines.push(`UNOWNED ${testCase.id}: no slice claims or lists a surface that this case drives`);
	for (const id of orphans) lines.push(`ORPHAN golden file for ${id}: no case has this id`);
	const same = results.filter((result) => result.status === "same").length;
	lines.push(`${same}/${results.length} ported cases match their golden files; ${selection.notYetPorted.length} cases of not-yet-ported surfaces were not compared`);
	return lines.join("\n");
}

/** True when the drift check passes: every ported case is the same, and nothing is unowned or orphaned. */
export function driftPassed(results: DriftResult[], selection: DriftSelection, orphans: string[]): boolean {
	return results.every((result) => result.status === "same") && selection.unowned.length === 0 && orphans.length === 0;
}
