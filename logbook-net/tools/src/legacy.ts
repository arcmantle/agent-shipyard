import path from "node:path";
import type { CliTarget, RpcTarget } from "./recorder.ts";

export type Legacy = { cli: CliTarget; rpc: RpcTarget; close(): Promise<void> };

const ADMIN_URL = process.env.AGENT_ISSUES_TEST_PG_URL ?? "postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues";
const APP_URL = process.env.AGENT_ISSUES_TEST_PG_APP_URL ?? "postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues";

/** Starts the TypeScript implementation: an API host on a free port over real PostgreSQL, and the built CLI. */
export async function startLegacy(logbookRoot: string): Promise<Legacy> {
	const api = await import(path.join(logbookRoot, "packages/api-pg/dist/index.js"));
	const cleanup = await import(path.join(logbookRoot, "packages/api-pg/dist/db/test-tenant-cleanup.js"));
	const adminPool = api.createPgPool({ connectionString: ADMIN_URL });
	const appPool = api.createPgPool({ connectionString: APP_URL });
	let server: { server: { close(): void; address(): unknown; once(event: string, listener: () => void): void } } | undefined;
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
		return {
			cli: { command: [nodeBinary, path.join(logbookRoot, "packages/cli/dist/cli.js")] },
			rpc: {
				url: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`,
				issueToken: (tenantId: string) => authProvider.issueToken({ userId: "parity-user", tenantId }) as Promise<string>,
				newTenantId: () => cleanup.createTestTenantId() as string
			},
			async close() {
				server?.server.close();
				await cleanup.cleanupTestTenants(adminPool);
				await adminPool.end();
				await appPool.end();
			}
		};
	} catch (error) {
		server?.server.close();
		await adminPool.end();
		await appPool.end();
		throw error;
	}
}
