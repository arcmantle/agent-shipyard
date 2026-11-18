// Records golden files from the TypeScript implementation.
// Usage (from logbook-net/tools): bun src/record.ts [--out <dir>] [case-id-glob ...]
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type Case } from "./cases.ts";
import { recordCli, recordRpc, RecordingError, type Observation } from "./recorder.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const netRoot = path.resolve(here, "../..");
const logbookRoot = path.resolve(netRoot, "../logbook");

const args = process.argv.slice(2);
let goldenRoot = path.join(netRoot, "contract/golden");
const globs: string[] = [];
for (let index = 0; index < args.length; index++) {
	if (args[index] === "--out") goldenRoot = path.resolve(args[++index] ?? "");
	else globs.push(args[index]);
}
const matches = (id: string) => globs.length === 0 || globs.some((glob) => new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(id));

const ADMIN_URL = process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const APP_URL = process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

const cases = loadCases(path.join(netRoot, "contract/cases")).filter((testCase) => matches(testCase.id));
if (cases.length === 0) {
	console.error("no cases match");
	process.exit(1);
}

const api = await import(path.join(logbookRoot, "packages/api-pg/dist/index.js"));
const cleanup = await import(path.join(logbookRoot, "packages/api-pg/dist/db/test-tenant-cleanup.js"));
const adminPool = api.createPgPool({ connectionString: ADMIN_URL });
const appPool = api.createPgPool({ connectionString: APP_URL });
let server: { server: { close(): void; address(): unknown; once(event: string, listener: () => void): void }; url: string } | undefined;
let failures = 0;
try {
	await api.migratePgDatabase(adminPool);
	const authProvider = new api.LocalAuthProvider({ secret: "parity-recorder-only-secret" });
	server = api.createApiServer({
		authMetadata: { provider: "entra", tenantId: "tenant-a", clientId: "client-a" },
		authProvider,
		pool: appPool,
		port: 0
	});
	await new Promise<void>((resolve) => server!.server.once("listening", resolve));
	// The recorded process runs with an isolated HOME, so a version-manager shim for `node` would not work: use the real binary.
	const nodeBinary = Bun.spawnSync(["node", "-p", "process.execPath"]).stdout.toString().trim();
	if (!nodeBinary) throw new Error("cannot resolve the node binary");
	const cli = { command: [nodeBinary, path.join(logbookRoot, "packages/cli/dist/cli.js")] };
	const rpc = {
		url: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`,
		issueToken: (tenantId: string) => authProvider.issueToken({ userId: "parity-user", tenantId }) as Promise<string>,
		newTenantId: () => cleanup.createTestTenantId() as string
	};
	const record = (testCase: Case): Promise<Observation> => (testCase.surface === "cli" ? recordCli(cli, testCase) : recordRpc(rpc, testCase));
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
			console.error(`FAILED ${testCase.id}: ${error instanceof RecordingError ? error.message : (error as Error).stack}`);
		}
	}
} finally {
	server?.server.close();
	await cleanup.cleanupTestTenants(adminPool);
	await adminPool.end();
	await appPool.end();
}
process.exit(failures ? 1 : 0);
