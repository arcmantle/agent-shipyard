import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCases, type Case, type CliCase } from "./cases.ts";
import { applyIntended, compareObservations, loadRules, readGolden, RuleError, runParity, validateRules, type IntendedDifference } from "./differ.ts";
import { recordCli, RecordingError, type Observation } from "./recorder.ts";

const netRoot = path.resolve(import.meta.dir, "../..");
const cases = loadCases(path.join(netRoot, "contract/cases"));
const goldenRoot = path.join(netRoot, "contract/golden");
const rules = loadRules(path.join(netRoot, "contract/intended-differences.json"));
const golden = (id: string) => readGolden(goldenRoot, id);
const clone = <T>(value: T): T => structuredClone(value);

/** Simulates the port differences that the approved rules cover. */
function dotnetShape(id: string, observation: Observation): Observation {
	const copy = clone(observation) as { stdout: unknown };
	if (id.endsWith("-help")) {
		copy.stdout = (copy.stdout as string).replace(/agent-issues(?= )/g, "agent-logbook").split("\n").filter((line) => !line.includes("SQLite")).join("\n")
			.replace("override, ", "override, .agent-shipyard.json file, .agent-shipyard file, ").replace("file, Git remote", "file, old extensionless project file, Git remote");
	}
	return copy as Observation;
}

const run = (candidate: (testCase: Case) => Promise<Observation>, activeRules: IntendedDifference[] = rules) =>
	runParity({ cases, rules: activeRules, baseline: async (testCase) => golden(testCase.id), candidate });
const byId = (report: Awaited<ReturnType<typeof run>>, id: string) => report.results.find((result) => result.id === id)!;
const candidateWith = (change: (id: string, observation: Observation) => Observation) => async (testCase: Case) => change(testCase.id, dotnetShape(testCase.id, golden(testCase.id)));

test("project-identity cases pass with the approved differences, in any key order", async () => {
	const reorder = (value: unknown): unknown =>
		Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
	const report = await run(candidateWith((id, observation) => (id.startsWith("rpc/") ? observation : (reorder(observation) as Observation))));
	expect(byId(report, "cli/project-identity-json").status).toBe("pass");
	expect(byId(report, "cli/project-identity-help").status).toBe("pass");
	expect(report.unusedRules).toEqual([]);
	expect(Object.keys(report.ruleUse).sort()).toEqual(["command-name", "no-sqlite-db-option", "project-identity-new-project-files", "project-identity-old-extensionless-file-note"]);
});

test("without the approved rules the same help differences fail", async () => {
	const shaped = candidateWith((_, observation) => observation);
	expect(byId(await run(shaped, []), "cli/project-identity-help").status).toBe("fail");
	expect(byId(await run(shaped, rules), "cli/project-identity-help").status).toBe("pass");
});

test("the prototype null-omission defect fails and names each missing null field", async () => {
	const dropNulls = (value: unknown): unknown =>
		Array.isArray(value) ? value.map(dropNulls) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) : value;
	const countNulls = (value: unknown): number =>
		value === null ? 1 : Array.isArray(value) ? value.reduce<number>((sum, v) => sum + countNulls(v), 0) : value && typeof value === "object" ? Object.values(value).reduce<number>((sum, v) => sum + countNulls(v), 0) : 0;
	const nulls = countNulls(golden("rpc/get-entity-details"));
	expect(nulls).toBeGreaterThan(0);
	const report = await run(candidateWith((id, observation) => (id.startsWith("rpc/") ? (dropNulls(observation) as Observation) : observation)));
	const result = byId(report, "rpc/get-entity-details");
	expect(result.status).toBe("fail");
	expect(result.differences.length).toBe(nulls);
	expect(result.differences.every((line) => line.includes("missing in candidate (expected null)"))).toBe(true);
	expect(new Set(result.differences.map((line) => line.split(":")[0])).size).toBe(nulls);
});

test("negative zero and a different number are differences", () => {
	expect(compareObservations({ n: 0 }, { n: -0 })).toHaveLength(1);
	expect(compareObservations({ n: 1 }, { n: 1.5 })).toHaveLength(1);
});

test("candidate-only extra text next to an approved rewrite still fails", async () => {
	const report = await run(candidateWith((id, observation) => {
		const copy = clone(observation) as any;
		if (id === "cli/project-identity-help") copy.stdout += "extra line\n";
		return copy;
	}));
	const result = byId(report, "cli/project-identity-help");
	expect(result.status).toBe("fail");
	expect(result.differences.join("\n")).toContain("extra line");
});

test("array order, JSON type, hash, status, exit code, stdout, and stderr differences fail", () => {
	expect(compareObservations({ a: [1, 2] }, { a: [2, 1] })).toHaveLength(2);
	expect(compareObservations({ a: 1 }, { a: "1" })).toEqual(['/a: expected 1 (number), actual "1" (string)']);
	expect(compareObservations({ a: null }, { a: false })).toHaveLength(1);
	expect(compareObservations({ a: [] }, { a: {} })).toHaveLength(1);
	expect(compareObservations({ a: [1] }, { a: [1, 2] })).toEqual(["/a/1: unexpected in candidate (2)"]);
	const hash = "a".repeat(64);
	expect(compareObservations({ body: { contentHash: hash } }, { body: { contentHash: "b".repeat(64) } })).toHaveLength(1);
	const base = { steps: [{ status: 200, body: {} }] };
	expect(compareObservations(base, { steps: [{ status: 201, body: {} }] })).toEqual(["/steps/0/status: expected 200, actual 201"]);
	const cli = { exitCode: 0, stdout: "x\n", stderr: "" };
	expect(compareObservations(cli, { ...cli, exitCode: 1 })).toHaveLength(1);
	expect(compareObservations(cli, { ...cli, stdout: "y\n" })).toHaveLength(1);
	expect(compareObservations(cli, { ...cli, stderr: "warn" })).toHaveLength(1);
	expect(compareObservations(cli, { stderr: "", stdout: "x\n", exitCode: 0 })).toEqual([]);
});

test("each strict difference fails the applicable case in a run", async () => {
	const change = (edit: (copy: any) => void) => async (testCase: Case) => {
		const copy = clone(dotnetShape(testCase.id, golden(testCase.id))) as any;
		if (testCase.id === "cli/project-identity-json") edit(copy);
		return copy as Observation;
	};
	for (const edit of [
		(c: any) => (c.exitCode = 1),
		(c: any) => (c.stderr = "oops"),
		(c: any) => (c.stdout.identity = 5),
		(c: any) => (c.stdout.source = `${c.stdout.source}\n`),
		(c: any) => delete c.stdout.source
	]) {
		expect(byId(await run(change(edit)), "cli/project-identity-json").status).toBe("fail");
	}
});

test("rules change only the legacy side and only the approved value", () => {
	const legacy = { exitCode: 0, stderr: "", stdout: "agent-issues x\n.agent-issues.json file\nSQLite db\nkeep\n" } as Observation;
	const use = new Map<string, string[]>();
	const expected = applyIntended("cli/a-help", legacy, rules, use) as { stdout: string };
	expect(expected.stdout).toBe("agent-logbook x\n.agent-issues.json file\nkeep\n");
	expect((legacy as { stdout: string }).stdout).toContain("SQLite");
	expect(applyIntended("cli/a-json", legacy, rules, use)).toEqual(legacy);
	expect(applyIntended("rpc/a-help", legacy, rules, use)).toEqual(legacy);
});

test("a rule that cannot match a case is reported unused, and a rule that changes nothing does not count", async () => {
	const extra: IntendedDifference = { id: "old-approval", cases: "cli/project-identity-help", path: "/stdout", action: "rewrite", match: "no such text", replace: "x", reason: "old" };
	const wrongPath: IntendedDifference = { id: "wrong-path", cases: "cli/project-identity-help", path: "/stderr", action: "rewrite", match: "agent-issues", replace: "x", reason: "wrong" };
	const report = await run(candidateWith((_, observation) => observation), [...rules, extra, wrongPath]);
	expect(report.unusedRules).toEqual(["old-approval", "wrong-path"]);
	expect(report.ruleUse["command-name"]).toEqual(["cli/project-identity-help"]);
});

test("a rule that rewrites a retained input or a stable-ID namespace is rejected", () => {
	const rule = (match: string, action = "rewrite") => [{ ...base, match, action, replace: action === "rewrite" ? "agent-logbook" : undefined }];
	for (const match of [
		"agent-issues(?= )", "agent-issues(?=\\.json)", "\\.agent-issues\\.json", "agent-issues(?=/)", "agent-issues/entity-stable-id/v1", "AGENT_ISSUES(?=_PROJECT)", "AGENT_ISSUES_PROJECT_IDENTITY"
	]) expect(() => validateRules(rule(match), "t")).toThrow(/retained input/);
	expect(() => validateRules(rule("\\.agent-issues", "remove-line"), "t")).toThrow(/retained input/);
	expect(() => validateRules(rule("(?<![.\\w/-])agent-issues(?= )"), "t")).not.toThrow();
	expect(() => validateRules(rule("^agent-issues (?=project-identity)"), "t")).not.toThrow();
});

test("the approved command-name rule leaves retained names in help text", () => {
	const legacy = { exitCode: 0, stderr: "", stdout: "  agent-issues show\n.agent-issues file\nUse .agent-issues.json file\nagent-issues/user-stable-id/v1 x\n" } as Observation;
	const expected = applyIntended("cli/a-help", legacy, rules, new Map()) as { stdout: string };
	expect(expected.stdout).toBe("  agent-logbook show\n.agent-issues file\nUse .agent-issues.json file\nagent-issues/user-stable-id/v1 x\n");
});

test("every rule leaves the retained inputs in the recorded legacy results unchanged", () => {
	const retained = [".agent-issues.json", ".agent-issues", "AGENT_ISSUES_PROJECT_IDENTITY", "agent-issues/entity-stable-id/v1", "agent-issues/context-stable-id/v1", "agent-issues/context-term-id/v1", "agent-issues/user-stable-id/v1"];
	const count = (text: string) => retained.map((input) => text.split(input).length - 1);
	let seen = 0;
	for (const testCase of cases) {
		const legacy = golden(testCase.id);
		const expected = applyIntended(testCase.id, legacy, rules, new Map());
		const before = JSON.stringify(legacy);
		const after = JSON.stringify(expected);
		expect(count(after)).toEqual(count(before));
		seen += count(before).reduce((sum, n) => sum + n, 0);
	}
	expect(seen).toBeGreaterThan(0);
});

const base = { id: "r", cases: "cli/x-help", path: "/stdout", action: "rewrite", match: "(?<![.\\w/-])agent-issues(?= )", replace: "agent-logbook", reason: "why" };
test("broad or malformed rules are rejected", () => {
	expect(validateRules([base], "t")).toHaveLength(1);
	for (const bad of [
		{ cases: "*" }, { cases: "cli/*" }, { cases: "cli/*-*" }, { cases: "cli/*e" }, { cases: "rpc/*-" }, { cases: "**" }, { cases: "x/y" }, { cases: "" },
		{ path: "" }, { path: "/" }, { path: "stdout" },
		{ match: ".*" }, { match: "." }, { match: "agent" + "|" }, { match: "\\s" }, { match: "[" }, { match: "e" }, { match: "[a-z]{3}" }, { match: "\\w+\\s" }, { match: "agent|e" },
		{ action: "delete" }, { replace: undefined }, { reason: " " }, { id: "" }
	]) {
		expect(() => validateRules([{ ...base, ...bad }], "t")).toThrow(RuleError);
	}
	expect(() => validateRules([{ ...base, action: "remove-line", replace: "x" }], "t")).toThrow(RuleError);
	expect(() => validateRules([base, base], "t")).toThrow(/duplicate/);
	expect(() => validateRules({}, "t")).toThrow(RuleError);
});

test("a rewrite with JSON Pointer escapes and array indexes reaches the right value", () => {
	const rule: IntendedDifference = { id: "p", cases: "rpc/step-edit", path: "/steps/1/body/a~1b", action: "rewrite", match: "old", replace: "new", reason: "r" };
	const legacy = { steps: [{ body: { "a/b": "old" } }, { body: { "a/b": "old", other: "old" } }] } as Observation;
	const expected = applyIntended("rpc/step-edit", legacy, validateRules([rule], "t"), new Map()) as any;
	expect(expected.steps[1].body).toEqual({ "a/b": "new", other: "old" });
	expect(expected.steps[0].body["a/b"]).toBe("old");
});

test("a failed candidate run fails its case, names the cause, and does not stop other cases", async () => {
	const report = await run(async (testCase) => {
		if (testCase.id === "cli/project-identity-json") throw new RecordingError("exit code 134, expected 0\nstderr: crash");
		return dotnetShape(testCase.id, golden(testCase.id));
	});
	const failed = byId(report, "cli/project-identity-json");
	expect(failed.status).toBe("error");
	expect(failed.message).toContain("candidate: exit code 134");
	expect(byId(report, "cli/project-identity-help").status).toBe("pass");
	const missing = await runParity({ cases: cases.slice(0, 1), rules, baseline: async (testCase) => golden(`${testCase.id}-none`), candidate: async () => ({}) });
	expect(missing.results[0]).toMatchObject({ status: "error" });
	expect(missing.results[0].message).toContain("no golden file");
});

test("real process failures of the candidate are reported per case", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "differ-test-"));
	const script = path.join(dir, "candidate.mjs");
	writeFileSync(script, `
const args = process.argv.slice(2);
if (args.includes("--help")) { console.error("boom"); process.exit(3); }
console.log(JSON.stringify({ command: "project-identity", identity: "default-project", source: "folder-name" }));
`);
	const target = { command: [process.execPath, script], timeoutMs: 5000 };
	const cliCases = cases.filter((testCase): testCase is CliCase => testCase.surface === "cli");
	const report = await runParity({
		cases: cliCases,
		rules,
		baseline: async (testCase) => golden(testCase.id),
		candidate: (testCase) => recordCli(target, testCase as CliCase)
	});
	expect(byId(report, "cli/project-identity-json").status).toBe("pass");
	expect(byId(report, "cli/project-identity-help")).toMatchObject({ status: "error" });
	expect(byId(report, "cli/project-identity-help").message).toContain("exit code 3");
	const missing = await runParity({
		cases: cliCases,
		rules,
		baseline: async (testCase) => golden(testCase.id),
		candidate: (testCase) => recordCli({ command: ["/no/such/binary"] }, testCase as CliCase)
	});
	expect(missing.results.every((result) => result.status === "error")).toBe(true);
});

test("dual-run and golden-check agree for the same inputs", async () => {
	// The dual-run baseline is a live legacy observation. Here it is the same data the golden file holds.
	const live = (testCase: Case) => Promise.resolve(clone(golden(testCase.id)));
	const candidate = candidateWith((id, observation) => (id.startsWith("rpc/") ? { steps: (observation as any).steps.slice(1) } : observation));
	const fromGolden = await run(candidate);
	const fromLive = await runParity({ cases, rules, baseline: live, candidate });
	expect(fromLive).toEqual(fromGolden);
	expect(fromGolden.results.some((result) => result.status === "fail")).toBe(true);
});
