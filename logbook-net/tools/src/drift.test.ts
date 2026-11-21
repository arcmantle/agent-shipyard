import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCases, type Case } from "./cases.ts";
import { validateSliceFile, type CoverageInventory, type SliceFile } from "./coverage.ts";
import { checkDrift, driftPassed, orphanGoldenFiles, selectPortedCases } from "./drift.ts";
import { readGolden } from "./differ.ts";
import type { Observation } from "./recorder.ts";

const netRoot = path.resolve(import.meta.dir, "../..");
const read = (file: string) => JSON.parse(readFileSync(path.join(netRoot, file), "utf8"));
const inventory = read("contract/inventory.json") as CoverageInventory;
const sliceFile = validateSliceFile(read("contract/slices.json"));
const cases = loadCases(path.join(netRoot, "contract/cases"));
const goldenRoot = path.join(netRoot, "contract/golden");
const selection = selectPortedCases(cases, sliceFile, inventory);

/** A TypeScript implementation that has not changed: its recording equals the golden file. */
const unchanged = async (testCase: Case): Promise<Observation> => structuredClone(readGolden(goldenRoot, testCase.id));
const run = (record: (testCase: Case) => Promise<Observation>, only: Case[] = selection.ported) => checkDrift({ cases: only, goldenRoot, record });

test("the real skeleton corpus is owned: every case is ported or not yet ported, and every golden file has a case", () => {
	expect(selection.unowned.map((testCase) => testCase.id)).toEqual([]);
	expect(orphanGoldenFiles(goldenRoot, cases)).toEqual([]);
	const ported = selection.ported.map((testCase) => testCase.id);
	// The handshake case belongs to the MCP server; commands that stay not yet ported are not compared.
	for (const id of ["cli/init-json", "rpc/list-entities", "mcp/project-identity", "mcp/server-info", "cli/schema-json"]) expect(ported).toContain(id);
	const pending = selection.notYetPorted.map((testCase) => testCase.id);
	for (const id of ["cli/capabilities-help", "cli/help-help"]) expect(pending).toContain(id);
	expect(ported.length + pending.length).toBe(cases.length);
});

test("an unchanged recording passes", async () => {
	const results = await run(unchanged);
	expect(results.length).toBe(selection.ported.length);
	expect(results.filter((result) => result.status !== "same")).toEqual([]);
	expect(driftPassed(results, selection, [])).toBe(true);
});

test("a deliberate change of a ported result fails with its JSON Pointer", async () => {
	const results = await run(async (testCase) => {
		const fresh = await unchanged(testCase);
		if (testCase.id === "cli/init-json") (fresh.stdout as Record<string, unknown>).status = "changed";
		return fresh;
	});
	const failed = results.filter((result) => result.status !== "same");
	expect(failed.map((result) => result.id)).toEqual(["cli/init-json"]);
	expect(failed[0].status).toBe("drift");
	expect(failed[0].differences[0]).toContain("/stdout/status");
	expect(driftPassed(results, selection, [])).toBe(false);
});

test("the comparison stays strict: hash, null, type and array order are drift", async () => {
	const strict = async (change: (value: Record<string, unknown>) => void) => {
		const target = cases.find((testCase) => testCase.id === "rpc/create-entity-null-fields")!;
		const results = await run(async (testCase) => {
			const fresh = structuredClone(readGolden(goldenRoot, testCase.id)) as Record<string, unknown>;
			if (testCase.id === target.id) change(fresh);
			return fresh;
		}, [target]);
		return results[0].status;
	};
	expect(await strict(() => {})).toBe("same");
	const firstKey = (value: Record<string, unknown>) => {
		const steps = value.steps as { body: Record<string, unknown> }[];
		return steps[0].body;
	};
	expect(await strict((value) => { (firstKey(value) as Record<string, unknown>).extra = null; })).toBe("drift");
	expect(await strict((value) => { (firstKey(value) as Record<string, unknown>).extra = 1; })).toBe("drift");
});

test("a missing golden file, or a recording that fails, is never a pass", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "drift-test-"));
	try {
		const one = cases[0];
		const missing = await checkDrift({ cases: [one], goldenRoot: root, record: async () => ({}) });
		expect(missing[0].status).toBe("error");
		mkdirSync(path.join(root, path.dirname(one.id)), { recursive: true });
		writeFileSync(path.join(root, `${one.id}.golden.json`), "{}\n");
		const failing = await checkDrift({ cases: [one], goldenRoot: root, record: async () => { throw new Error("boom"); } });
		expect(failing[0].status).toBe("error");
		expect(failing[0].message).toContain("boom");
		expect(driftPassed(failing, selection, [])).toBe(false);
		// The check reads only: the golden file is unchanged.
		expect(readFileSync(path.join(root, `${one.id}.golden.json`), "utf8")).toBe("{}\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an orphan golden file or an unowned case fails the check", () => {
	const root = mkdtempSync(path.join(tmpdir(), "drift-test-"));
	try {
		mkdirSync(path.join(root, "cli"), { recursive: true });
		writeFileSync(path.join(root, "cli/gone.golden.json"), "{}\n");
		const orphans = orphanGoldenFiles(root, cases);
		expect(orphans).toEqual(["cli/gone"]);
		expect(driftPassed([], selection, orphans)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const stranger: Case = { id: "rpc/strange", surface: "rpc", steps: [{ method: "notInTheInventory" }] };
	const changed = selectPortedCases([...cases, stranger], sliceFile, inventory);
	expect(changed.unowned.map((testCase) => testCase.id)).toEqual(["rpc/strange"]);
	expect(driftPassed([], changed, [])).toBe(false);
});

test("the ported/not-yet-ported line follows the slice accounting", () => {
	const claimedOnly = (file: SliceFile): string[] => selectPortedCases(cases, file, inventory).ported.map((testCase) => testCase.id);
	expect(claimedOnly(sliceFile).length).toBeGreaterThan(0);
	// An unclaimed slice has no ported cases, so nothing is compared and its cases are not yet ported.
	const development = structuredClone(sliceFile);
	for (const slice of development.slices) slice.claimed = false;
	const none = selectPortedCases(cases, development, inventory);
	expect(none.ported).toEqual([]);
	expect(none.unowned.map((testCase) => testCase.id)).toEqual([]);
	// A slice filter limits the compared cases to the named slices.
	expect(selectPortedCases(cases, sliceFile, inventory, ["nothing"]).ported).toEqual([]);
});
