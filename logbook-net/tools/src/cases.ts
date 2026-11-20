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
export type Case = CliCase | RpcCase;

export class CaseError extends Error {}

export function validateCase(value: unknown, source: string): Case {
	const fail = (message: string): never => {
		throw new CaseError(`${source}: ${message}`);
	};
	if (!value || typeof value !== "object") return fail("case must be an object");
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(item.id)) return fail("id must be <surface>/<name>");
	if (item.surface !== "cli" && item.surface !== "rpc") return fail("surface must be cli or rpc");
	if (!item.id.startsWith(`${item.surface}/`)) return fail("id must start with the surface");
	if (item.surface === "cli") {
		const workspace = item.workspace as { folder?: unknown } | undefined;
		if (typeof workspace?.folder !== "string" || /[\\/]/.test(workspace.folder) || workspace.folder.startsWith(".")) return fail("workspace.folder must be one plain folder name");
		if (!Array.isArray(item.argv) || !item.argv.every((arg) => typeof arg === "string")) return fail("argv must be a string array");
		if (item.setup !== undefined) {
			if (!Array.isArray(item.setup)) return fail("setup must be an array");
			for (const step of item.setup as Record<string, unknown>[]) {
				if (!step || !Array.isArray(step.argv) || !step.argv.every((arg) => typeof arg === "string")) return fail("each setup step needs an argv string array");
				if (step.as !== undefined && typeof step.as !== "string") return fail("setup as must be a string");
			}
		}
		if (item.stdout !== "json" && item.stdout !== "text") return fail("stdout must be json or text");
		if (item.expectExitCode !== undefined && !Number.isInteger(item.expectExitCode)) return fail("expectExitCode must be an integer");
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
