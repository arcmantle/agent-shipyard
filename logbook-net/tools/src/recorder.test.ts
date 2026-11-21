import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliCase, McpCase, RpcCase } from "./cases.ts";
import { CaseError, validateCase } from "./cases.ts";
import { recordCli, recordMcp, recordRpc, RecordingError, substitute } from "./recorder.ts";

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
		if (method === "text401") return new Response("unauthorized", { status: 401 });
		return Response.json({ jsonrpc: "2.0", id: 1, result: { id: "id-1", tenant: request.headers.get("authorization") } });
	}
});
afterAll(() => server.stop(true));
const rpc = { url: `http://127.0.0.1:${server.port}`, issueToken: async (t: string) => `token-${t}`, newTenantId: () => "tenant-abc" };
const rpcCase = (steps: RpcCase["steps"]): RpcCase => ({ id: "rpc/x", surface: "rpc", steps });

test("the candidate API URL is a data store placeholder", async () => {
	process.env.AGENT_LOGBOOK_API_URL = "http://127.0.0.1:5999/";
	try {
		const seen = (await recordCli(cli, cliCase(["http://127.0.0.1:5999 and http://127.0.0.1:5999/x"]))).stdout as { a: string[] };
		expect(seen.a[0]).toBe("<data-store> and <data-store>/x");
	} finally {
		delete process.env.AGENT_LOGBOOK_API_URL;
	}
});

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

test("CLI setup steps bind JSON output for the observed command", async () => {
	const result = await recordCli(cli, cliCase(["use", "${first.b}"], { setup: [{ argv: ["one"], as: "first" }] })) as { stdout: { a: string[] } };
	expect(result.stdout.a).toEqual(["use 1"]);
	await expect(recordCli(cli, cliCase(["x"], { setup: [{ argv: ["fail"] }] }))).rejects.toThrow(/setup 1: exit code 3/);
	await expect(recordCli(cli, cliCase(["x"], { setup: [{ argv: ["text"] }] }))).rejects.toThrow(/setup 1: stdout is not JSON/);
	await expect(recordCli(cli, cliCase(["${nope.id}"]))).rejects.toThrow(/cli\/x: unknown step name/);
	expect(() => validateCase({ ...cliCase(["a"]), setup: [{ argv: "a" }] }, "x")).toThrow(CaseError);
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

test("RPC recorder records an expected non-JSON error", async () => {
	const result = (await recordRpc(rpc, rpcCase([{ method: "text401", expectError: true }]))) as { steps: { status: number; body: unknown }[] };
	expect(result.steps[0]).toMatchObject({ status: 401, body: "unauthorized" });
});

// A fake MCP server over standard input and output. `--noisy` writes a log line to standard output, as a defective server would.
const mcpScript = path.join(dir, "fake-mcp.mjs");
writeFileSync(mcpScript, `
import readline from "node:readline";
const noisy = process.argv.includes("--noisy");
if (!process.argv.includes("--mcp")) { console.error("missing --mcp"); process.exit(2); }
const lines = readline.createInterface({ input: process.stdin });
if (noisy) console.log("server started");
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	const result = message.method === "initialize"
		? { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "9" }, capabilities: {} }
		: message.method === "tools/list"
			? { tools: [{ name: "a", execution: { x: 1 }, inputSchema: { type: "object", $schema: "s" } }, { name: "b" }] }
			: { cwd: process.cwd(), echo: message.params };
	console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
lines.on("close", () => process.exit(0));
`);
const mcp = (extra: string[] = []) => ({ command: [process.execPath, mcpScript, ...extra], timeoutMs: 5000 });
const init = { method: "initialize", params: { protocolVersion: "2025-06-18" } };
const mcpCase = (steps: McpCase["steps"], extra: Partial<McpCase> = {}): McpCase => ({ id: "mcp/x", surface: "mcp", workspace: { folder: "ws" }, steps, ...extra });

test("MCP recording selects tools, picks and omits fields, and records the exit after the input closes", async () => {
	const result = (await recordMcp(mcp(), mcpCase([
		{ ...init, pick: ["/serverInfo/name"] },
		{ method: "tools/list", tools: ["a"], omit: ["/tools/0/execution", "/tools/0/inputSchema/$schema", "/tools/0/missing"] },
		{ method: "tools/call", params: { name: "t" } }
	]))) as { exitCode: number; stderr: string; stdoutAfterClose: string[]; steps: { response: { result: Record<string, unknown> } }[] };
	expect(result.steps[0].response.result).toEqual({ serverInfo: { name: "fake" } });
	expect(result.steps[1].response.result).toEqual({ tools: [{ name: "a", inputSchema: { type: "object" } }] });
	expect(JSON.stringify(result.steps[2])).toContain("<workspace>");
	expect(result).toMatchObject({ exitCode: 0, stderr: "", stdoutAfterClose: [] });
});

test("MCP recording fails for a log line on standard output and for a tool that is not listed", async () => {
	await expect(recordMcp(mcp(["--noisy"]), mcpCase([init]))).rejects.toThrow("not JSON");
	await expect(recordMcp(mcp(), mcpCase([init, { method: "tools/list", tools: ["nosuch"] }]))).rejects.toThrow("does not list nosuch");
});

test("MCP cases need an initialize step first, and tools only apply to tools/list", () => {
	const base = { id: "mcp/x", surface: "mcp", workspace: { folder: "ws" } };
	expect(() => validateCase({ ...base, steps: [{ method: "tools/list" }] }, "f")).toThrow("first step must be initialize");
	expect(() => validateCase({ ...base, steps: [{ method: "initialize" }, { method: "tools/call", tools: ["a"] }] }, "f")).toThrow("tools/list only");
	expect(() => validateCase({ ...base, steps: [{ method: "initialize" }, { method: "tools/list", omit: "x" }] }, "f")).toThrow(CaseError);
	expect(validateCase({ ...base, steps: [{ method: "initialize" }] }, "f").surface).toBe("mcp");
});
