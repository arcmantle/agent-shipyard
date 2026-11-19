// Compares a candidate (.NET) implementation with the recorded TypeScript results.
// Usage (from logbook-net/tools):
//   bun src/parity.ts check [options] [case-id-glob ...]   candidate against the golden files; does not need the TypeScript implementation
//   bun src/parity.ts diff  [options] [case-id-glob ...]   candidate against a live TypeScript run (local investigation)
// Options:
//   --candidate-cli <command>   command that starts the candidate CLI: a JSON array (safe for paths with spaces) or words split on spaces
//   --candidate-url <url>       base URL of the candidate API host; needed for rpc cases
//   --candidate-token <token>   bearer token for the candidate API host; omit it for no-auth mode
//   --candidate-tenant <id>     one tenant shared by all cases (data can carry over between cases); default is a new tenant for each case
//   --rules <file>              intended differences; default contract/intended-differences.json
//   --fail-on-unused            fail when an intended-difference rule changed no case
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type Case } from "./cases.ts";
import { filterMatch, formatReport, loadRules, readGolden, runParity } from "./differ.ts";
import { recordCli, recordRpc, RecordingError, type Observation } from "./recorder.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const netRoot = path.resolve(here, "../..");

const args = process.argv.slice(2);
const mode = args[0];
if (mode !== "check" && mode !== "diff") {
	console.error("usage: bun src/parity.ts <check|diff> [options] [case-id-glob ...]");
	process.exit(2);
}
const VALUE_OPTIONS = ["candidate-cli", "candidate-url", "candidate-token", "candidate-tenant", "rules"];
const options: Record<string, string> = {};
const globs: string[] = [];
let failOnUnused = false;
for (let index = 1; index < args.length; index++) {
	const arg = args[index];
	if (arg === "--fail-on-unused") failOnUnused = true;
	else if (arg.startsWith("--")) {
		const name = arg.slice(2);
		if (!VALUE_OPTIONS.includes(name)) {
			console.error(`unknown option ${arg}`);
			process.exit(2);
		}
		const value = args[++index];
		if (!value) {
			console.error(`option ${arg} needs a value`);
			process.exit(2);
		}
		options[name] = value;
	}
	else globs.push(arg);
}

const cases = loadCases(path.join(netRoot, "contract/cases")).filter((testCase) => globs.length === 0 || globs.some((glob) => filterMatch(glob, testCase.id)));
if (cases.length === 0) {
	console.error("no cases match");
	process.exit(2);
}
const rules = loadRules(path.resolve(options.rules ?? path.join(netRoot, "contract/intended-differences.json")));

const cliText = options["candidate-cli"];
const candidateCommand = cliText ? (cliText.trim().startsWith("[") ? (JSON.parse(cliText) as string[]) : cliText.trim().split(/\s+/)) : undefined;
const candidateUrl = options["candidate-url"];
const token = options["candidate-token"] ?? "";
const candidate = (testCase: Case): Promise<Observation> => {
	if (testCase.surface === "cli") {
		if (!candidateCommand) throw new RecordingError("no --candidate-cli given");
		return recordCli({ command: candidateCommand }, testCase);
	}
	if (!candidateUrl) throw new RecordingError("no --candidate-url given");
	return recordRpc({ url: candidateUrl, issueToken: async () => token, newTenantId: () => options["candidate-tenant"] ?? `parity-${randomUUID()}` }, testCase);
};

let legacy: Awaited<ReturnType<typeof import("./legacy.ts").startLegacy>> | undefined;
if (mode === "diff") legacy = await (await import("./legacy.ts")).startLegacy((await import("./legacy.ts")).legacyRoot(netRoot));
const goldenRoot = path.join(netRoot, "contract/golden");
let report;
try {
	report = await runParity({
		cases,
		rules,
		baseline: async (testCase) => (legacy ? (testCase.surface === "cli" ? recordCli(legacy.cli, testCase) : recordRpc(legacy.rpc, testCase)) : readGolden(goldenRoot, testCase.id)),
		candidate
	});
} finally {
	await legacy?.close();
}
// An errored case skips its rules, so unused rules are only reliable when every case ran and compared.
const complete = globs.length === 0 && report.results.every((result) => result.status !== "error");
console.log(formatReport(report, { includeUnused: complete }));
const failed = report.results.some((result) => result.status !== "pass") || (failOnUnused && complete && report.unusedRules.length > 0);
process.exit(failed ? 1 : 0);
