// Rejects TypeScript drift in the ported golden cases.
// Usage (from any folder): bun logbook-net/tools/check-drift.ts [--slice <id> ...]
//
// Records every case of the claimed Port slices from the current TypeScript implementation (in memory) and compares each recording with its
// golden file in `contract/golden`. It writes nothing, publishes nothing, and applies no intended-difference rule. A difference fails the check
// until the golden files and the .NET code are updated, in the same change or in a linked issue.
// Needs the built TypeScript packages of `logbook/` (see README) and, for rpc cases, PostgreSQL (see the recorder).
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCases, type Case } from "./src/cases.ts";
import { validateSliceFile, type CoverageInventory } from "./src/coverage.ts";
import { checkDrift, driftPassed, formatDrift, orphanGoldenFiles, selectPortedCases } from "./src/drift.ts";
import { legacyCli, legacyRoot, startLegacy } from "./src/legacy.ts";
import { recordCli, recordMcp, recordRpc } from "./src/recorder.ts";

const netRoot = path.resolve(import.meta.dir, "..");
const sliceIds: string[] = [];
for (let index = 2; index < process.argv.length; index++) {
	if (process.argv[index] === "--slice") sliceIds.push(process.argv[++index] ?? "");
	else {
		console.error(`unknown argument ${process.argv[index]}`);
		process.exit(2);
	}
}
const read = (file: string) => JSON.parse(readFileSync(path.join(netRoot, file), "utf8"));
const inventory = read("contract/inventory.json") as CoverageInventory;
const sliceFile = validateSliceFile(read("contract/slices.json"));
for (const id of sliceIds) {
	if (!sliceFile.slices.some((slice) => slice.id === id && slice.claimed)) {
		console.error(`${id} is not a claimed slice of contract/slices.json`);
		process.exit(2);
	}
}

const cases = loadCases(path.join(netRoot, "contract/cases"));
const selection = selectPortedCases(cases, sliceFile, inventory, sliceIds.length > 0 ? sliceIds : undefined);
const goldenRoot = path.join(netRoot, "contract/golden");
// Orphans are judged against all cases, so a slice filter does not hide them.
const orphans = orphanGoldenFiles(goldenRoot, cases);

const logbookRoot = legacyRoot(netRoot);
const legacy = selection.ported.some((testCase) => testCase.surface === "rpc") ? await startLegacy(logbookRoot) : undefined;
const cli = legacy?.cli ?? legacyCli(logbookRoot);
let results;
try {
	results = await checkDrift({
		cases: selection.ported,
		goldenRoot,
		record: (testCase: Case) => (testCase.surface === "cli" ? recordCli(cli, testCase) : testCase.surface === "mcp" ? recordMcp(cli, testCase) : recordRpc(legacy!.rpc, testCase))
	});
} finally {
	await legacy?.close();
}
const report = formatDrift(results, selection, orphans);
if (driftPassed(results, selection, orphans)) {
	console.log(report);
} else {
	console.error(`${report}\n\nThe TypeScript implementation no longer matches the golden files. Update the golden files (bun src/record.ts <case>) and the .NET code in the same change or in a linked issue. Do not edit the golden files only to silence this check.`);
	process.exit(1);
}
