import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliCase, RpcCase } from "./cases.ts";
import { CaseError, validateCase } from "./cases.ts";
import { recordCli, recordRpc, RecordingError, substitute } from "./recorder.ts";

const dir = mkdtempSync(path.join(tmpdir(), "recorder-test-"));
const script = path.join(dir, "fake-cli.mjs");
writeFileSync(script, `
const args = process.argv.slice(2);
if (args[0] === "fail") { console.error("boom"); process.exit(3); }
if (args[0] === "text") { process.stdout.write("not json"); process.exit(0); }
if (args[0] === "hang") { setTimeout(() => {}, 60000); }
else console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, b: 1, a: [args.join(" ")] }));
`);
const cli = { command: [process.execPath, script], timeoutMs: 3000 };
const cliCase = (argv: string[], extra: Partial<CliCase> = {}): CliCase => ({ id: "cli/x", surface: "cli", workspace: { folder: "ws" }, argv, stdout: "json", ...extra });

let calls: { method: string; params: unknown }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { method, params } = (await request.json()) as { method: string; params: Record<string, unknown> };
		calls.push({ method, params });
		if (method === "bad") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } }, { status: 200 });
		if (method === "http500") return Response.json({}, { status: 500 });
		return Response.json({ jsonrpc: "2.0", id: 1, result: { id: "id-1", tenant: request.headers.get("authorization") } });
	}
});
afterAll(() => server.stop(true));
const rpc = { url: `http://127.0.0.1:${server.port}`, issueToken: async (t: string) => `token-${t}`, newTenantId: () => "tenant-abc" };
const rpcCase = (steps: RpcCase["steps"]): RpcCase => ({ id: "rpc/x", surface: "rpc", steps });

test("CLI recording is stable and hides temporary paths", async () => {
	const one = await recordCli(cli, cliCase(["a"]));
	const two = await recordCli(cli, cliCase(["a"]));
	expect(one).toEqual(two);
	expect(JSON.stringify(one)).toContain("<workspace>");
	expect(JSON.stringify(one)).not.toContain("parity-cli-");
});

test("CLI recorder fails on exit code, bad JSON, and timeout", async () => {
	await expect(recordCli(cli, cliCase(["fail"]))).rejects.toThrow(/exit code 3/);
	await expect(recordCli(cli, cliCase(["text"]))).rejects.toThrow(/not JSON/);
	await expect(recordCli({ ...cli, timeoutMs: 300 }, cliCase(["hang"]))).rejects.toThrow(/did not finish/);
	await expect(recordCli({ command: ["/no/such/binary"] }, cliCase(["a"]))).rejects.toThrow(RecordingError);
	expect(await recordCli(cli, cliCase(["fail"], { expectExitCode: 3, stdout: "text" }))).toMatchObject({ exitCode: 3, stderr: "boom\n" });
});

test("RPC recording substitutes named steps and hides the tenant", async () => {
	calls = [];
	const result = await recordRpc(rpc, rpcCase([{ as: "a", method: "one" }, { method: "two", params: { ref: "${a.id}" } }]));
	expect(calls[1].params).toEqual({ ref: "id-1" });
	expect(JSON.stringify(result)).not.toContain("tenant-abc");
});

test("RPC recorder fails on a failed step and writes nothing usable", async () => {
	await expect(recordRpc(rpc, rpcCase([{ method: "bad" }]))).rejects.toThrow(/step 1 \(bad\): failed/);
	await expect(recordRpc(rpc, rpcCase([{ method: "http500" }]))).rejects.toThrow(/HTTP 500/);
	await expect(recordRpc(rpc, rpcCase([{ method: "one" }, { method: "bad" }]))).rejects.toThrow(/step 2/);
	await expect(recordRpc(rpc, rpcCase([{ method: "one", expectError: true }]))).rejects.toThrow(/expectError/);
	expect(await recordRpc(rpc, rpcCase([{ method: "bad", expectError: true }]))).toBeTruthy();
	await expect(recordRpc(rpc, rpcCase([{ method: "one", params: { x: "${missing.id}" } }]))).rejects.toThrow(/unknown step name/);
	await expect(recordRpc({ ...rpc, url: "http://127.0.0.1:1" }, rpcCase([{ method: "one" }]))).rejects.toThrow(RecordingError);
});

test("substitute rejects missing and non-scalar values", () => {
	expect(() => substitute("${a.b}", { a: {} })).toThrow(RecordingError);
	expect(() => substitute("${a}", { a: { b: 1 } })).toThrow(RecordingError);
});

test("case validation rejects bad cases", () => {
	expect(() => validateCase({ id: "cli/x", surface: "rpc", steps: [{ method: "m" }] }, "f")).toThrow(CaseError);
	expect(() => validateCase({ id: "cli/x", surface: "cli", workspace: { folder: "../x" }, argv: [], stdout: "json" }, "f")).toThrow(CaseError);
	expect(() => validateCase({ id: "rpc/x", surface: "rpc", steps: [] }, "f")).toThrow(CaseError);
});
