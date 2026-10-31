import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Pool } from "pg";

import { ChangeEventBroadcaster, ConfirmationTokenStore, createJsonRpcApp, handleSiteRequest, type AuthIdentity, type AuthProvider, type OpenSiteStore } from "@agent-issues/core";

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
	/** Serves the built browser site from this directory; data routes require the caller's bearer token. */
	site?: { publicDirectory: string; instructionVersion: string };
}

export interface ApiServerHandle {
	server: Server;
	url: string;
}

export function createApiServer(options: ApiServerOptions): ApiServerHandle {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4400;

	const changeEvents = new ChangeEventBroadcaster();
	const app = createJsonRpcApp({
		authProvider: options.authProvider,
		changeEvents,
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
	if (options.site) {
		app.use(createHostedSite(options, options.site, changeEvents));
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

const SITE_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2"
};

const SITE_SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self' https://login.microsoftonline.com",
		"frame-src https://login.microsoftonline.com",
		"form-action 'self' https://login.microsoftonline.com",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"object-src 'none'"
	].join("; "),
	"Referrer-Policy": "no-referrer",
	"Strict-Transport-Security": "max-age=31536000",
	"X-Content-Type-Options": "nosniff"
};

function createHostedSite(options: ApiServerOptions, site: NonNullable<ApiServerOptions["site"]>, changeEvents: ChangeEventBroadcaster): RequestHandler {
	const root = realpathSync(path.resolve(site.publicDirectory));
	const confirmationTokens = new ConfirmationTokenStore(Date.now);
	const resolveAsset = (pathname: string) => {
		let relative: string;
		try {
			relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
		} catch {
			return undefined;
		}
		const file = path.resolve(root, relative);
		if (!file.startsWith(`${root}${path.sep}`) || !existsSync(file) || !realpathSync(file).startsWith(`${root}${path.sep}`) || !statSync(file).isFile()) return undefined;
		return { path: file, contentType: SITE_CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" };
	};
	return async (request, response, next) => {
		try {
			for (const [name, value] of Object.entries(SITE_SECURITY_HEADERS)) response.setHeader(name, value);
			let identity: AuthIdentity | undefined;
			if (request.path === "/site-config.json" || request.path.startsWith("/api/")) {
				const header = request.header("authorization");
				identity = header ? await options.authProvider.validateToken(header).catch(() => undefined) : undefined;
				if (!identity) {
					response.status(401).json({ error: "Sign-in required." });
					return;
				}
			}
			const signedIn = identity;
			// The token's tenant is the only tenant a hosted request can open, whatever the URL asks for.
			const openStore: OpenSiteStore = async (scope) => {
				if (!signedIn) throw new Error("Sign-in required.");
				const store = new PgStore(options.pool, signedIn.tenantId, scope.projectIdentity).withAuthenticatedIdentity(signedIn);
				return {
					// PgStore.close ends the shared pool, which the API owns for its whole lifetime.
					store: new Proxy(store, { get: (target, property) => property === "close" ? async () => {} : Reflect.get(target, property) }),
					dbPath: "",
					owner: { type: "cloud", tenantId: signedIn.tenantId, userId: signedIn.userId },
					backend: "cloud"
				};
			};
			await handleSiteRequest(request, response, {
				openStore,
				defaultTenant: signedIn?.tenantId ?? "",
				clients: new Set(),
				confirmationTokens,
				instructionVersion: () => site.instructionVersion,
				resolveAsset,
				onMutation: (event) => {
					if (signedIn) changeEvents.publishSnapshotChanged(signedIn.tenantId, event);
				}
			});
		} catch (error) {
			next(error);
		}
	};
}
