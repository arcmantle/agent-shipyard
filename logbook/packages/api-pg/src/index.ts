import { createServer, type Server } from "node:http";

import type { ErrorRequestHandler } from "express";
import type { Pool } from "pg";

import { createJsonRpcApp, type AuthProvider } from "@agent-issues/core";

import { PgStore } from "./pg-store.js";

export type { AuthIdentity, AuthProvider } from "@agent-issues/core";
export { createJsonRpcApp, type CreateJsonRpcAppOptions } from "@agent-issues/core";
export { EntraIdAuthProvider, type EntraIdAuthProviderOptions } from "./auth/entra-id-auth-provider.js";
export { LocalAuthProvider, type LocalAuthProviderOptions } from "@agent-issues/core";
export { createPgPool, migratePgDatabase, installInstructionBundle } from "./db/connection.js";
export { configurePgRoles, type PgRoles, type PgRolePasswords } from "./db/roles.js";

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
	readinessCheck?: () => Promise<void>;
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
	const readinessCheck = options.readinessCheck;
	if (readinessCheck) {
		app.get("/health/live", (_request, response) => {
			response.json({ status: "live" });
		});
		app.get("/health/ready", async (_request, response) => {
			response.setHeader("Cache-Control", "no-store");
			try {
				await readinessCheck();
				response.json({ status: "ready" });
			} catch {
				response.status(503).json({ status: "not-ready" });
			}
		});
	}
	const requestErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
		if (response.headersSent) {
			response.end();
			return;
		}
		const candidate = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
		const status = typeof candidate === "number" && [400, 413, 415].includes(candidate) ? candidate : 500;
		response.status(status).json({ error: status < 500 ? "Invalid request." : "Internal server error." });
	};
	app.use(requestErrorHandler);
	const server = createServer(app);

	server.listen(port, host);

	return { server, url: `http://${host}:${port}` };
}
