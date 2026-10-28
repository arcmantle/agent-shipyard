import { randomInt } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import type { InstructionBundle } from "@agent-issues/core";

import { runDatabaseSetup } from "./database-setup.js";
import { createApiServer, createPgPool, EntraIdAuthProvider, type AuthProvider } from "./index.js";
import { verifyPgRuntimeRole } from "./db/roles.js";

type ProductionOptions = {
	environment: NodeJS.ProcessEnv;
	pool?: Pool;
	instructionBundle?: InstructionBundle;
	authProvider?: AuthProvider;
	setupDatabase?: typeof runDatabaseSetup;
};

const BUNDLE_URL = new URL("../instruction-defaults.json", import.meta.url);

function readInstructionBundle(): InstructionBundle | undefined {
	return existsSync(BUNDLE_URL) ? JSON.parse(readFileSync(BUNDLE_URL, "utf8")) as InstructionBundle : undefined;
}

function invalidConfiguration(name: string): never {
	throw new Error(`Invalid production configuration: ${name}`);
}

function readHostedSite(bundle: InstructionBundle | undefined) {
	const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
	if (!existsSync(`${publicDirectory}index.html`) || !bundle) return undefined;
	// Instruction reads are keyed by the bundle release installed from this image.
	return { publicDirectory, instructionVersion: bundle.version };
}

function readConfiguration(environment: NodeJS.ProcessEnv) {
	const connectionString = environment.DATABASE_URL;
	try {
		const database = new URL(connectionString ?? "");
		if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || !database.username || database.password || database.pathname.length < 2
			|| database.searchParams.getAll("sslmode").length !== 1 || database.searchParams.get("sslmode") !== "verify-full"
			|| [...database.searchParams.keys()].some((key) => key !== "sslmode")) {
			invalidConfiguration("DATABASE_URL");
		}
	} catch {
		invalidConfiguration("DATABASE_URL");
	}
	const tenantId = environment.ENTRA_TENANT_ID ?? "";
	const clientId = environment.ENTRA_CLIENT_ID ?? "";
	const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const managedIdentityClientId = environment.DATABASE_MANAGED_IDENTITY_CLIENT_ID ?? "";
	if (!identifier.test(managedIdentityClientId)) invalidConfiguration("DATABASE_MANAGED_IDENTITY_CLIENT_ID");
	if (!identifier.test(tenantId)) invalidConfiguration("ENTRA_TENANT_ID");
	if (!identifier.test(clientId)) invalidConfiguration("ENTRA_CLIENT_ID");
	const host = environment.HOST ?? "0.0.0.0";
	if (!isIP(host) && host !== "localhost") invalidConfiguration("HOST");
	const portValue = environment.PORT ?? "8080";
	if (!/^\d+$/.test(portValue) || Number(portValue) > 65535) invalidConfiguration("PORT");
	const shutdownValue = environment.SHUTDOWN_TIMEOUT_MS ?? "10000";
	if (!/^\d+$/.test(shutdownValue) || Number(shutdownValue) < 1 || Number(shutdownValue) > 30000) {
		invalidConfiguration("SHUTDOWN_TIMEOUT_MS");
	}
	const setup = readSetupConfiguration(environment);
	return { connectionString: connectionString!, managedIdentityClientId, tenantId, clientId, host, port: Number(portValue), shutdownTimeoutMs: Number(shutdownValue), setup };
}

function readSetupConfiguration(environment: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
	if (environment.DATABASE_SETUP_CONFIG === undefined) return undefined;
	try {
		const value = JSON.parse(environment.DATABASE_SETUP_CONFIG) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// Reported below without the configuration text.
	}
	return invalidConfiguration("DATABASE_SETUP_CONFIG");
}

export async function startProductionApi(options: ProductionOptions) {
	const configuration = readConfiguration(options.environment);
	const bundle = options.instructionBundle ?? readInstructionBundle();
	if (configuration.setup) {
		// Each start creates and removes its own tenant-isolation probe table.
		const verificationTable = `logbook_role_check_${Math.floor(Date.now() / 1000)}_${randomInt(1, 1_000_000_000)}`;
		await (options.setupDatabase ?? runDatabaseSetup)({
			DATABASE_SETUP_PHASE: "migrate",
			DATABASE_SETUP_CONFIG: JSON.stringify({ ...configuration.setup, verification_table: verificationTable })
		}, undefined, bundle);
	}
	const pool = options.pool ?? createPgPool({
		connectionString: configuration.connectionString,
		managedIdentityClientId: configuration.managedIdentityClientId,
		connectionTimeoutMillis: 2000,
		queryTimeoutMillis: 2000
	});
	const onPoolError = () => { process.stderr.write("Database connection failed.\n"); };
	pool.on("error", onPoolError);
	let closing: Promise<void> | undefined;
	const handle = createApiServer({
		host: configuration.host,
		port: configuration.port,
		pool,
		authProvider: options.authProvider ?? new EntraIdAuthProvider(configuration),
		authMetadata: { provider: "entra", tenantId: configuration.tenantId, clientId: configuration.clientId },
		site: readHostedSite(bundle),
		readinessCheck: async () => {
			if (closing) throw new Error("API is stopping.");
			await verifyPgRuntimeRole(pool);
		}
	});
	try {
		await once(handle.server, "listening");
	} catch (error) {
		await pool.end();
		throw error;
	}
	const address = handle.server.address();
	if (!address || typeof address === "string") throw new Error("API listener is unavailable.");
	const hostname = isIP(configuration.host) === 6 ? `[${configuration.host}]` : configuration.host;
	return {
		url: `http://${hostname}:${address.port}`,
		close() {
			closing ??= (async () => {
				let timer: NodeJS.Timeout | undefined;
				let endingPool: Promise<void> | undefined;
				const closePool = () => {
					endingPool ??= pool.end().finally(() => { pool.removeListener("error", onPoolError); });
					return endingPool;
				};
				const deadline = new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						handle.server.closeAllConnections();
						void closePool().catch(() => {});
						reject(new Error("API shutdown timed out."));
					}, configuration.shutdownTimeoutMs);
				});
				const drain = async () => {
					await new Promise<void>((resolve, reject) => {
						handle.server.close((error) => error ? reject(error) : resolve());
					});
					await closePool();
				};
				try {
					await Promise.race([drain(), deadline]);
				} finally {
					clearTimeout(timer);
				}
			})();
			return closing;
		}
	};
}