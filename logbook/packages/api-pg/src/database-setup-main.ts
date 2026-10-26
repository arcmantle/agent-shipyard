import { databaseSetupStages, runDatabaseSetup, type DatabaseSetupFailure } from "./database-setup.js";

try {
	await runDatabaseSetup(process.env);
	process.stdout.write('{"event":"database-setup-complete"}\n');
} catch (error) {
	const failure = error as DatabaseSetupFailure & { code?: unknown };
	const phase = ["configure", "reconcile", "verify-denied"].find((value) => value === process.env.DATABASE_SETUP_PHASE);
	const stage = databaseSetupStages.find((value) => value === failure?.stage);
	const code = typeof failure?.code === "string" && /^[A-Z0-9_]{1,32}$/i.test(failure.code) ? failure.code : undefined;
	// Only fixed messages from setup code are printed; driver and network messages can contain private names.
	const message = failure instanceof Error && failure.constructor === Error && code === undefined && /^[A-Za-z .,-]{1,160}$/.test(failure.message) ? failure.message : undefined;
	const attributes = failure?.roleAttributes;
	const role_attributes = attributes && Object.fromEntries(["session_createrole", "administration_createrole", "session_inherits_administration"]
		.map((key) => [key, (attributes as Record<string, unknown>)[key] === true]));
	process.stderr.write(`${JSON.stringify({ event: "database-setup-failed", phase, stage, code, message, cleanup_failed: failure?.cleanupFailed === true, role_attributes })}\n`);
	process.exitCode = 1;
}