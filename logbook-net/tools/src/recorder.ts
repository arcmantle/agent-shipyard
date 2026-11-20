import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliCase, RpcCase } from "./cases.ts";
import { createNormalizer } from "./normalize.ts";

export type Observation = Record<string, unknown>;

/** A recording failed. The recorder must not write a golden file for it. */
export class RecordingError extends Error {}

export type CliTarget = { command: string[]; timeoutMs?: number };
export type RpcTarget = { url: string; issueToken(tenantId: string): Promise<string>; newTenantId(): string };

// AGENT_LOGBOOK_API_URL points the .NET candidate at the API host that a parity check starts; the TypeScript CLI ignores it.
const PASSTHROUGH_ENV = ["PATH", "LANG", "TMPDIR", "SystemRoot", "AGENT_LOGBOOK_API_URL"];

export async function recordCli(target: CliTarget, testCase: CliCase): Promise<Observation> {
	const root = mkdtempSync(path.join(tmpdir(), "parity-cli-"));
	const home = path.join(root, "home");
	const workspace = path.join(root, testCase.workspace.folder);
	mkdirSync(home);
	mkdirSync(workspace);
	try {
		for (const [file, content] of Object.entries(testCase.workspace.files ?? {})) {
			const target = path.resolve(workspace, file);
			if (!target.startsWith(`${workspace}${path.sep}`)) throw new RecordingError(`${testCase.id}: workspace file ${file} is outside the workspace`);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		// A clean environment: no user settings reach the recording. The TypeScript CLI accepts AGENT_ISSUES_NO_DAEMON
		// (a local store without the background daemon) only in a development build under VITEST=true; commands that open
		// a store need that build (`pnpm --filter agent-issues build:dev`).
		const env: Record<string, string> = { HOME: home, USERPROFILE: home, AGENT_ISSUES_NO_DAEMON: "1", NO_COLOR: "1", VITEST: "true" };
		for (const key of PASSTHROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]!;

		// Setup commands run first in the same home and workspace. Their JSON output binds `${name.field}` for later arguments.
		const bindings: Record<string, unknown> = {};
		for (const [index, setup] of (testCase.setup ?? []).entries()) {
			const ran = await runCli(target, `${testCase.id} setup ${index + 1}`, substituteArgv(setup.argv, bindings, testCase.id), workspace, env);
			if (ran.exitCode !== 0) throw new RecordingError(`${testCase.id} setup ${index + 1}: exit code ${ran.exitCode}\nstderr: ${ran.stderr.trim()}`);
			let output: unknown;
			try {
				output = JSON.parse(ran.stdout);
			} catch {
				throw new RecordingError(`${testCase.id} setup ${index + 1}: stdout is not JSON: ${ran.stdout.slice(0, 200)}`);
			}
			if (setup.as) bindings[setup.as] = output;
		}

		const { stdout, stderr, exitCode } = await runCli(target, testCase.id, substituteArgv(testCase.argv, bindings, testCase.id), workspace, env);
		const expected = testCase.expectExitCode ?? 0;
		if (exitCode !== expected) {
			throw new RecordingError(`${testCase.id}: exit code ${exitCode}, expected ${expected}\nstderr: ${stderr.trim()}`);
		}
		let parsed: unknown = stdout;
		if (testCase.stdout === "json") {
			try {
				parsed = JSON.parse(stdout);
			} catch {
				throw new RecordingError(`${testCase.id}: stdout is not JSON: ${stdout.slice(0, 200)}`);
			}
		}
		const literals: Record<string, string> = {};
		for (const [literal, placeholder] of [[workspace, "<workspace>"], [home, "<home>"], [root, "<root>"]] as const) {
			literals[literal] = placeholder;
			literals[realpathSync(literal)] = placeholder;
		}
		return createNormalizer(literals)({ exitCode, stdout: parsed, stderr }) as Observation;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}


function substituteArgv(argv: string[], bindings: Record<string, unknown>, id: string): string[] {
	try {
		return substitute(argv, bindings) as string[];
	} catch (error) {
		if (error instanceof RecordingError) throw new RecordingError(`${id}: ${error.message}`);
		throw error;
	}
}

async function runCli(target: CliTarget, label: string, argv: string[], cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn([...target.command, ...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		throw new RecordingError(`${label}: cannot start ${target.command.join(" ")}: ${(error as Error).message}`);
	}
	const timeoutMs = target.timeoutMs ?? 60_000;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream).text(),
		new Response(child.stderr as ReadableStream).text(),
		child.exited
	]).finally(() => clearTimeout(timer));
	if (timedOut) throw new RecordingError(`${label}: process did not finish within ${timeoutMs} ms`);
	return { stdout, stderr, exitCode };
}

/** Replaces `${name.field}` with a value from an earlier named step. An unresolved name is a failure. */
export function substitute(value: unknown, bindings: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([\w.]+)\}/g, (_, expression: string) => {
			const [name, ...fields] = expression.split(".");
			if (!(name in bindings)) throw new RecordingError(`unknown step name in \${${expression}}`);
			let current: unknown = bindings[name];
			for (const field of fields) {
				if (current === null || typeof current !== "object" || !(field in current)) throw new RecordingError(`\${${expression}} has no value`);
				current = (current as Record<string, unknown>)[field];
			}
			if (current === null || typeof current === "object") throw new RecordingError(`\${${expression}} is not a scalar value`);
			return String(current);
		});
	}
	if (Array.isArray(value)) return value.map((item) => substitute(item, bindings));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, bindings)]));
	return value;
}

export async function recordRpc(target: RpcTarget, testCase: RpcCase): Promise<Observation> {
	const tenantId = target.newTenantId();
	const token = await target.issueToken(tenantId);
	const bindings: Record<string, unknown> = {};
	const steps: unknown[] = [];
	for (const [index, step] of testCase.steps.entries()) {
		const label = `${testCase.id} step ${index + 1} (${step.method})`;
		let status: number;
		let body: unknown;
		try {
			const response = await fetch(`${target.url}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: step.method, params: substitute(step.params ?? {}, bindings) })
			});
			status = response.status;
			const text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
		} catch (error) {
			if (error instanceof RecordingError) throw new RecordingError(`${label}: ${error.message}`);
			throw new RecordingError(`${label}: request failed: ${(error as Error).message}`);
		}
		const failed = status < 200 || status >= 300 || (body as { error?: unknown } | null)?.error !== undefined;
		if (failed !== (step.expectError === true)) {
			throw new RecordingError(`${label}: ${failed ? "failed" : "succeeded but expectError is set"} (HTTP ${status}) ${JSON.stringify(body)}`);
		}
		if (step.as) bindings[step.as] = (body as { result?: unknown } | null)?.result;
		steps.push({ method: step.method, status, body });
	}
	return createNormalizer({ [tenantId]: "<tenant>" })({ steps }) as Observation;
}
