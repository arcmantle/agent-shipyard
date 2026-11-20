import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type CliCase = {
	id: string;
	surface: "cli";
	workspace: { folder: string; files?: Record<string, string> };
	/** Commands that run first in the same home and workspace. Each must exit 0 with JSON output; `as` binds it for `${name.field}` in later arguments. */
	setup?: { argv: string[]; as?: string }[];
	argv: string[];
	stdout: "json" | "text";
	expectExitCode?: number;
};
export type RpcStep = { as?: string; method: string; params?: unknown; expectError?: boolean };
export type RpcCase = { id: string; surface: "rpc"; steps: RpcStep[] };
/**
 * One JSON-RPC request of an MCP stdio session. The recorder numbers the requests and sends them one by one after the initialize handshake of the
 * first step. `tools` keeps only the named tools of a `tools/list` result, so a candidate that lists fewer tools than the legacy server still
 * compares the tools that it implements. `pick` keeps only the listed JSON Pointers of the response `result`. `omit` removes the listed JSON Pointers of
 * the `result` (after `tools`) from the observation of both implementations: use it only for a protocol detail of the SDK version that has no behavior, and name it in the case. `as` binds the response `result` for `${name.field}`.
 */
export type McpStep = { method: string; params?: unknown; as?: string; tools?: string[]; pick?: string[]; omit?: string[] };
/** An MCP case runs the CLI with `--mcp` in the workspace. `setup` is the same as for a CLI case. */
export type McpCase = {
	id: string;
	surface: "mcp";
	workspace: { folder: string; files?: Record<string, string> };
	setup?: { argv: string[]; as?: string }[];
	steps: McpStep[];
};
export type Case = CliCase | RpcCase | McpCase;

export class CaseError extends Error {}

export function validateCase(value: unknown, source: string): Case {
	const fail = (message: string): never => {
		throw new CaseError(`${source}: ${message}`);
	};
	if (!value || typeof value !== "object") return fail("case must be an object");
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(item.id)) return fail("id must be <surface>/<name>");
	if (item.surface !== "cli" && item.surface !== "rpc" && item.surface !== "mcp") return fail("surface must be cli, rpc or mcp");
	if (!item.id.startsWith(`${item.surface}/`)) return fail("id must start with the surface");
	if (item.surface === "cli" || item.surface === "mcp") {
		const workspace = item.workspace as { folder?: unknown } | undefined;
		if (typeof workspace?.folder !== "string" || /[\\/]/.test(workspace.folder) || workspace.folder.startsWith(".")) return fail("workspace.folder must be one plain folder name");
		if (item.surface === "cli" && (!Array.isArray(item.argv) || !item.argv.every((arg) => typeof arg === "string"))) return fail("argv must be a string array");
		if (item.setup !== undefined) {
			if (!Array.isArray(item.setup)) return fail("setup must be an array");
			for (const step of item.setup as Record<string, unknown>[]) {
				if (!step || !Array.isArray(step.argv) || !step.argv.every((arg) => typeof arg === "string")) return fail("each setup step needs an argv string array");
				if (step.as !== undefined && typeof step.as !== "string") return fail("setup as must be a string");
			}
		}
		if (item.surface === "cli") {
			if (item.stdout !== "json" && item.stdout !== "text") return fail("stdout must be json or text");
			if (item.expectExitCode !== undefined && !Number.isInteger(item.expectExitCode)) return fail("expectExitCode must be an integer");
		} else {
			if (!Array.isArray(item.steps) || item.steps.length === 0) return fail("steps must be a non-empty array");
			const steps = item.steps as Record<string, unknown>[];
			if (steps[0]?.method !== "initialize") return fail("the first step must be initialize");
			for (const step of steps) {
				if (!step || typeof step.method !== "string") return fail("each step needs a method");
				for (const key of ["tools", "pick", "omit"]) {
					const list = step[key];
					if (list !== undefined && (!Array.isArray(list) || !list.every((entry) => typeof entry === "string"))) return fail(`step ${key} must be a string array`);
				}
				if (step.tools !== undefined && step.method !== "tools/list") return fail("step tools applies to tools/list only");
			}
		}
	} else {
		if (!Array.isArray(item.steps) || item.steps.length === 0) return fail("steps must be a non-empty array");
		for (const step of item.steps as Record<string, unknown>[]) {
			if (!step || typeof step.method !== "string") return fail("each step needs a method");
		}
	}
	return item as unknown as Case;
}

export function loadCases(casesRoot: string): Case[] {
	return readdirSync(casesRoot, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".case.json"))
		.sort()
		.map((file) => {
			const testCase = validateCase(JSON.parse(readFileSync(path.join(casesRoot, file), "utf8")), file);
			const expected = file.replace(/\.case\.json$/, "").split(path.sep).join("/");
			if (testCase.id !== expected) throw new CaseError(`${file}: id ${testCase.id} must match the file path ${expected}`);
			return testCase;
		});
}
