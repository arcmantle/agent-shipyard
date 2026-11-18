import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Case } from "./cases.ts";
import type { Observation } from "./recorder.ts";
import { retainedProbes } from "./rename.ts";

// ---------- intended-difference rules ----------

export type IntendedDifference = {
	id: string;
	cases: string;
	path: string;
	action: "rewrite" | "remove-line";
	match: string;
	replace?: string;
	reason: string;
};

export class RuleError extends Error {}

/** Strings that a narrow rule must not match. A pattern that matches any of them would rewrite almost every text. */
const BROAD_PROBES = ["", " ", "\n", ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/|<>[]()", "abc", "abc def", "123", "--db <path>"];

/** Matches a case ID with a glob for command-line filters. `*` stands for any characters. */
export function filterMatch(glob: string, value: string): boolean {
	return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
}

/** Matches a case ID with a glob. `*` stands for any characters inside one path segment. */
export function globMatch(glob: string, value: string): boolean {
	return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`).test(value);
}

/**
 * Checks the rules file. A rule that is too broad is rejected, because it can hide a candidate defect:
 * the case glob must name one surface, the pointer must name one value, and the pattern must not match common text.
 */
export function validateRules(value: unknown, source: string): IntendedDifference[] {
	const fail = (message: string): never => {
		throw new RuleError(`${source}: ${message}`);
	};
	if (!Array.isArray(value)) return fail("rules must be an array");
	const seen = new Set<string>();
	return value.map((entry, index) => {
		const rule = entry as Record<string, unknown>;
		const label = `rule ${index + 1}${typeof rule?.id === "string" ? ` (${rule.id})` : ""}`;
		if (!rule || typeof rule !== "object") return fail(`${label} must be an object`);
		for (const key of ["id", "cases", "path", "action", "match", "reason"]) {
			if (typeof rule[key] !== "string" || (rule[key] as string).trim() === "") return fail(`${label}: ${key} must be a non-empty string`);
		}
		const item = rule as unknown as IntendedDifference;
		if (seen.has(item.id)) return fail(`${label}: duplicate id`);
		seen.add(item.id);
		if (!/^(cli|rpc)\/[a-z0-9*-]+$/.test(item.cases) || item.cases.split("/")[1].replace(/[*-]/g, "").length < 4) {
			return fail(`${label}: cases must name one surface and at least four letters of a case name, for example cli/*-help`);
		}
		if (!/^(\/[^/]+)+$/.test(item.path)) return fail(`${label}: path must be a JSON Pointer to one value, for example /stdout`);
		if (item.action !== "rewrite" && item.action !== "remove-line") return fail(`${label}: action must be rewrite or remove-line`);
		if (item.action === "rewrite" && typeof item.replace !== "string") return fail(`${label}: a rewrite rule needs replace`);
		if (item.action === "remove-line" && item.replace !== undefined) return fail(`${label}: a remove-line rule has no replace`);
		let pattern: RegExp;
		try {
			pattern = new RegExp(item.match);
		} catch {
			return fail(`${label}: match is not a valid regular expression`);
		}
		if (BROAD_PROBES.some((probe) => pattern.test(probe))) return fail(`${label}: match is too broad, it matches common text`);
		const global = new RegExp(item.match, "g");
		const touched = retainedProbes().find((probe) =>
			item.action === "remove-line" ? probe.split("\n").some((line) => new RegExp(item.match).test(line)) : probe.replace(global, item.replace ?? "") !== probe
		);
		if (touched !== undefined) return fail(`${label}: the rule changes the retained input in ${JSON.stringify(touched)}; a rename rule must not match retained project-identity inputs or stable-ID namespaces`);
		return item;
	});
}

export function loadRules(file: string): IntendedDifference[] {
	return validateRules(JSON.parse(readFileSync(file, "utf8")), path.basename(file));
}

// ---------- JSON Pointer ----------

function pointerKeys(pointer: string): string[] {
	return pointer.split("/").slice(1).map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function child(parent: unknown, key: string): unknown {
	if (Array.isArray(parent)) return /^(0|[1-9]\d*)$/.test(key) ? parent[Number(key)] : undefined;
	if (parent && typeof parent === "object" && Object.hasOwn(parent, key)) return (parent as Record<string, unknown>)[key];
	return undefined;
}

function getAt(root: unknown, pointer: string): unknown {
	return pointerKeys(pointer).reduce<unknown>((current, key) => child(current, key), root);
}

function setAt(root: unknown, pointer: string, value: unknown): void {
	const keys = pointerKeys(pointer);
	const last = keys.pop()!;
	const parent = keys.reduce<unknown>((current, key) => child(current, key), root) as Record<string, unknown> | unknown[];
	(parent as Record<string, unknown>)[last] = value;
}

// ---------- applying rules to the legacy side ----------

export type RuleUse = Map<string, string[]>;

/**
 * Turns a legacy observation into the expected candidate observation.
 * Rules change only the legacy side and only string values. The candidate is never changed, so a candidate defect cannot be approved by a rule.
 * A rule counts as used for a case only when it changes the value.
 */
export function applyIntended(caseId: string, legacy: Observation, rules: IntendedDifference[], use: RuleUse): Observation {
	const expected = structuredClone(legacy);
	for (const rule of rules) {
		if (!globMatch(rule.cases, caseId)) continue;
		const current = getAt(expected, rule.path);
		if (typeof current !== "string") continue;
		const next = rule.action === "remove-line"
			? current.split("\n").filter((line) => !new RegExp(rule.match).test(line)).join("\n")
			: current.replace(new RegExp(rule.match, "g"), rule.replace ?? "");
		if (next === current) continue;
		setAt(expected, rule.path, next);
		use.set(rule.id, [...(use.get(rule.id) ?? []), caseId]);
	}
	return expected;
}

// ---------- strict comparison ----------

const kind = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Lists each difference with its JSON Pointer. `null` and an absent key are different. Array order and JSON types must be equal. */
export function compareObservations(expected: unknown, actual: unknown, at = ""): string[] {
	const where = at || "/";
	if (kind(expected) !== kind(actual)) return [`${where}: expected ${JSON.stringify(expected)} (${kind(expected)}), actual ${JSON.stringify(actual)} (${kind(actual)})`];
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const lines: string[] = [];
		for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
			if (index >= actual.length) lines.push(`${at}/${index}: missing in candidate (expected ${JSON.stringify(expected[index])})`);
			else if (index >= expected.length) lines.push(`${at}/${index}: unexpected in candidate (${JSON.stringify(actual[index])})`);
			else lines.push(...compareObservations(expected[index], actual[index], `${at}/${index}`));
		}
		return lines;
	}
	if (expected && actual && typeof expected === "object" && typeof actual === "object") {
		const left = expected as Record<string, unknown>;
		const right = actual as Record<string, unknown>;
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		return keys.flatMap((key) => {
			const pointer = `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
			if (!Object.hasOwn(right, key)) return [`${pointer}: missing in candidate (expected ${JSON.stringify(left[key])})`];
			if (!Object.hasOwn(left, key)) return [`${pointer}: unexpected in candidate (${JSON.stringify(right[key])})`];
			return compareObservations(left[key], right[key], pointer);
		});
	}
	if (typeof expected === "string" && typeof actual === "string" && expected !== actual && (expected.includes("\n") || actual.includes("\n"))) {
		const a = expected.split("\n");
		const b = actual.split("\n");
		const lines: string[] = [];
		for (let index = 0; index < Math.max(a.length, b.length); index++) {
			if (a[index] !== b[index]) lines.push(`${where} line ${index + 1}: expected ${JSON.stringify(a[index])}, actual ${JSON.stringify(b[index])}`);
		}
		return lines;
	}
	return Object.is(expected, actual) ? [] : [`${where}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`];
}

// ---------- running ----------

export type CaseResult = { id: string; status: "pass" | "fail" | "error"; differences: string[]; message?: string };
export type Report = { results: CaseResult[]; ruleUse: Record<string, string[]>; unusedRules: string[] };

export type ParityInput = {
	cases: Case[];
	rules: IntendedDifference[];
	/** Where the expectation comes from: a golden file (check mode) or a live TypeScript run (dual-run mode). */
	baseline(testCase: Case): Promise<Observation>;
	candidate(testCase: Case): Promise<Observation>;
};

/** One code path for both modes: only the baseline source differs. A failed run is reported for its case and does not stop the others. */
export async function runParity(input: ParityInput): Promise<Report> {
	const use: RuleUse = new Map();
	const results: CaseResult[] = [];
	for (const testCase of input.cases) {
		let baseline: Observation;
		try {
			baseline = await input.baseline(testCase);
		} catch (error) {
			results.push({ id: testCase.id, status: "error", differences: [], message: `baseline: ${(error as Error).message}` });
			continue;
		}
		let actual: Observation;
		try {
			actual = await input.candidate(testCase);
		} catch (error) {
			results.push({ id: testCase.id, status: "error", differences: [], message: `candidate: ${(error as Error).message}` });
			continue;
		}
		const differences = compareObservations(applyIntended(testCase.id, baseline, input.rules, use), actual);
		results.push({ id: testCase.id, status: differences.length ? "fail" : "pass", differences });
	}
	return {
		results,
		ruleUse: Object.fromEntries(use),
		unusedRules: input.rules.filter((rule) => !use.has(rule.id)).map((rule) => rule.id)
	};
}

export function readGolden(goldenRoot: string, caseId: string): Observation {
	const file = path.join(goldenRoot, `${caseId}.golden.json`);
	if (!existsSync(file)) throw new Error(`no golden file for ${caseId}; record it first`);
	return JSON.parse(readFileSync(file, "utf8")) as Observation;
}

export function formatReport(report: Report, options: { includeUnused: boolean }): string {
	const lines: string[] = [];
	for (const result of report.results) {
		lines.push(`${result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "ERROR"} ${result.id}`);
		if (result.message) lines.push(`  ${result.message.split("\n").join("\n  ")}`);
		for (const line of result.differences) lines.push(`  ${line}`);
	}
	const passed = report.results.filter((result) => result.status === "pass").length;
	lines.push("", `${passed}/${report.results.length} cases match`);
	const used = Object.entries(report.ruleUse).map(([id, ids]) => `${id} (${ids.join(", ")})`);
	lines.push(`intended differences used: ${used.join("; ") || "none"}`);
	if (options.includeUnused) for (const id of report.unusedRules) lines.push(`UNUSED intended difference ${id}`);
	else lines.push("unused rules not reported: only some cases ran");
	return lines.join("\n");
}
