// Records golden files from the TypeScript implementation.
// Usage (from logbook-net/tools): bun src/record.ts [--out <dir>] [case-id-glob ...]
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type Case } from "./cases.ts";
import { legacyCli, legacyRoot, startLegacy } from "./legacy.ts";
import { recordCli, recordMcp, recordRpc, RecordingError, type Observation } from "./recorder.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const netRoot = path.resolve(here, "../..");
const logbookRoot = legacyRoot(netRoot);

const args = process.argv.slice(2);
let goldenRoot = path.join(netRoot, "contract/golden");
const globs: string[] = [];
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--out") goldenRoot = path.resolve(args[++index] ?? "");
	else globs.push(args[index]);
}
const matches = (id: string) => globs.length === 0 || globs.some((glob) => new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(id));

const cases = loadCases(path.join(netRoot, "contract/cases")).filter((testCase) => matches(testCase.id));
if (cases.length === 0) {
	console.error("no cases match");
	process.exit(1);
}

// Only an rpc case needs the TypeScript API host and PostgreSQL; cli and mcp cases run the built CLI alone.
const legacy = cases.some((testCase) => testCase.surface === "rpc") ? await startLegacy(logbookRoot) : undefined;
const cli = legacy?.cli ?? legacyCli(logbookRoot);
let failures = 0;
try {
	const record = (testCase: Case): Promise<Observation> => (testCase.surface === "cli" ? recordCli(cli, testCase) : testCase.surface === "mcp" ? recordMcp(cli, testCase) : recordRpc(legacy!.rpc, testCase));
	for (const testCase of cases) {
		try {
			const observation = await record(testCase);
			const file = path.join(goldenRoot, `${testCase.id}.golden.json`);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(`${file}.tmp`, `${JSON.stringify(observation, null, "\t")}\n`);
			renameSync(`${file}.tmp`, file);
			console.log(`recorded ${testCase.id}`);
		} catch (error) {
			failures++;
			// A failed recording must not leave an older golden file that looks current.
			rmSync(path.join(goldenRoot, `${testCase.id}.golden.json`), { force: true });
			console.error(`FAILED ${testCase.id}: ${error instanceof RecordingError ? error.message : (error as Error).stack}`);
		}
	}
} finally {
	await legacy?.close();
}
process.exit(failures ? 1 : 0);
