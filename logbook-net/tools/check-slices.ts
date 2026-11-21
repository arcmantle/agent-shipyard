// Runs the complete check of the claimed Port slices against the .NET implementation, as CI does.
// Usage (from any folder): AGENT_LOGBOOK_LOCAL_PG_URL=<postgres url> bun logbook-net/tools/check-slices.ts [--release] [--candidate-cli <command>]
//
//   1. the coverage check (`src/coverage.ts`): every surface is classified and each claimed surface has its cases;
//   2. a Local API host on a PostgreSQL database that the check empties (use a database that has no other use);
//   3. every parity case against that host, each on empty tables, with the intended differences of the contract;
//   4. the selected TypeScript HttpStore storage-driver groups of the claimed slices against the same host on empty tables.
//
// `--candidate-cli` is a JSON array or words that start the .NET CLI. Default: the Debug build of AgentLogbook.Cli.
// The TypeScript packages of `logbook/` must be built (core, for step 4). Exit code 0 only when every step passes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQL } from "bun";
import { loadCases } from "./src/cases.ts";

const toolsRoot = import.meta.dir;
const netRoot = path.resolve(toolsRoot, "..");
const release = process.argv.includes("--release");
const option = (name: string) => {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
};

const pgUrl = process.env.AGENT_LOGBOOK_LOCAL_PG_URL;
if (!pgUrl) {
	console.error("AGENT_LOGBOOK_LOCAL_PG_URL must name an empty PostgreSQL database that this check may empty.");
	process.exit(2);
}
const cliText = option("--candidate-cli");
const defaultDll = path.join(netRoot, "src/AgentLogbook.Cli/bin/Debug/net11.0/AgentLogbook.Cli.dll");
if (!cliText && !existsSync(defaultDll)) {
	console.error(`${defaultDll} does not exist. Run dotnet build, or pass --candidate-cli.`);
	process.exit(2);
}
const cli: string[] = cliText ? (cliText.trim().startsWith("[") ? JSON.parse(cliText) : cliText.trim().split(/\s+/)) : ["dotnet", defaultDll];

const failures: string[] = [];
/** Runs one step. A quiet step prints its output only when it fails. */
const run = (label: string, command: string[], env: Record<string, string> = {}, quiet = false) => {
	const result = spawnSync(command[0], command.slice(1), { stdio: quiet ? "pipe" : "inherit", cwd: toolsRoot, env: { ...process.env, ...env }, encoding: "utf8" });
	if (result.status !== 0) {
		failures.push(label);
		if (quiet) console.error(`${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
	return result.status === 0;
};

// 1. Coverage. A failure here still lets the other steps run, so one run reports everything.
run("coverage", ["bun", "src/coverage.ts", ...(release ? ["--release"] : [])]);

// 2. The Local API host. Its discovery file goes to a temporary Shipyard data folder, never to the user's.
const shipyardHome = mkdtempSync(path.join(tmpdir(), "logbook-check-"));
const hostEnv = { ...process.env, AGENT_SHIPYARD_HOME: shipyardHome, AGENT_LOGBOOK_LOCAL_PG_URL: pgUrl };
const host = spawn(cli[0], [...cli.slice(1), "serve"], { env: hostEnv, stdio: ["ignore", "pipe", "inherit"] });
const apiUrl = await new Promise<string>((resolve, reject) => {
	let text = "";
	host.stdout.on("data", (chunk) => {
		text += chunk;
		const found = /listening on (http:\/\/\S+) /.exec(text);
		if (found) resolve(found[1]);
	});
	host.once("exit", (code) => reject(new Error(`the Local API host exited with ${code} before it was ready`)));
	setTimeout(() => reject(new Error("the Local API host did not start within 60 seconds")), 60_000);
}).catch((error) => {
	host.kill();
	rmSync(shipyardHome, { recursive: true, force: true });
	console.error(String(error.message ?? error));
	process.exit(1);
});

const database = new SQL(pgUrl);
const emptyTables = async () => {
	const tables = (await database`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`).map((row: { tablename: string }) => `"${row.tablename}"`);
	await database.unsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
};

try {
	// 3. Parity cases. Each case runs on empty tables, because the Local API host has one tenant.
	for (const testCase of loadCases(path.join(netRoot, "contract/cases"))) {
		await emptyTables();
		run(`parity ${testCase.id}`, ["bun", "src/parity.ts", "check", "--candidate-cli", JSON.stringify(cli), "--candidate-url", apiUrl, testCase.id], { AGENT_LOGBOOK_API_URL: apiUrl }, true);
	}
	// 4. The storage-driver contract of the claimed slices.
	await emptyTables();
	run("storage-driver contract", ["bun", "storage-driver-contract/run.ts", apiUrl]);
} finally {
	// The host removes its discovery file on shutdown, so the folder stays until the host has exited.
	const exited = new Promise((resolve) => host.once("exit", resolve));
	host.kill("SIGTERM");
	await exited;
	await database.close();
	rmSync(shipyardHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\nFAILED (${failures.length}):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log("\nAll checks passed.");
