import { createServer, type Server } from "node:http";

import type { Pool } from "pg";

import { createJsonRpcApp, type AuthProvider } from "@agent-issues/core";

import { PgStore } from "./pg-store.js";

export type { AuthIdentity, AuthProvider } from "@agent-issues/core";
export { createJsonRpcApp, type CreateJsonRpcAppOptions } from "@agent-issues/core";
export { EntraIdAuthProvider, type EntraIdAuthProviderOptions } from "./auth/entra-id-auth-provider.js";
export { LocalAuthProvider, type LocalAuthProviderOptions } from "@agent-issues/core";
export { createPgPool, migratePgDatabase, installInstructionBundle } from "./db/connection.js";

export type ApiAuthMetadata = {
	provider: "entra";
	tenantId: string;
	clientId: string;
};

/**
 * Configuration for the agent-issues cloud API host: the single Postgres
 * gate (ADR13). `pool` and `authProvider` are required with no defaults, so
 * the gate can never silently start without both real Postgres access and a
 * real auth seam (ADR12).
 */
export interface ApiServerOptions {
	host?: string;
	port?: number;
	pool: Pool;
	authProvider: AuthProvider;
	authMetadata: ApiAuthMetadata;
}

export interface ApiServerHandle {
	server: Server;
	url: string;
}

export function createApiServer(options: ApiServerOptions): ApiServerHandle {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4400;

	const app = createJsonRpcApp({
		authProvider: options.authProvider,
		createStore: (identity, projectIdentity) => new PgStore(options.pool, identity.tenantId, projectIdentity)
	});
	app.get("/.well-known/agent-issues", (_request, response) => {
		response.json({ auth: options.authMetadata });
	});
	const server = createServer(app);

	server.listen(port, host);

	return { server, url: `http://${host}:${port}` };
}
