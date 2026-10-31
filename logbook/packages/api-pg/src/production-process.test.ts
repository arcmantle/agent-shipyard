import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const entry = resolve(packageRoot, "dist/main.js");
const environment: NodeJS.ProcessEnv = {
	PATH: process.env.PATH,
	DATABASE_URL: "postgres://runtime@127.0.0.1:1/logbook?sslmode=verify-full",
	DATABASE_MANAGED_IDENTITY_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
	ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
	ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
	HOST: "127.0.0.1",
	PORT: "0"
};

beforeAll(async () => {
	const execute = promisify(execFile);
	await execute("pnpm", ["--dir", workspaceRoot, "--filter", "@agent-issues/core", "build"]);
	await execute("pnpm", ["--dir", packageRoot, "build"]);
}, 60000);

describe("production command", () => {
	it.each<[string, string | undefined]>([
		["DATABASE_URL", undefined],
		["DATABASE_URL", "https://runtime:private-password@example.test/logbook"],
		["DATABASE_URL", "postgres://runtime:private-password@example.test/logbook?sslmode=verify-full"],
		["DATABASE_URL", "postgres://runtime@example.test/logbook?sslmode=require"],
		["DATABASE_URL", "postgres://runtime@example.test/logbook?sslmode=verify-full&options=-c%20role%3Downer"],
		["DATABASE_MANAGED_IDENTITY_CLIENT_ID", undefined],
		["DATABASE_MANAGED_IDENTITY_CLIENT_ID", "private-invalid-identity"],
		["ENTRA_TENANT_ID", undefined],
		["ENTRA_CLIENT_ID", "private-invalid-client"],
		["HOST", "http://private-host"],
		["PORT", "65536"],
		["PORT", "-1"],
		["PORT", "1.5"],
		["SHUTDOWN_TIMEOUT_MS", "0"]
	])("exits safely when %s is invalid", async (name, value) => {
		const child = spawn(process.execPath, [entry], {
			cwd: packageRoot,
			env: { ...environment, [name]: value },
			stdio: ["ignore", "pipe", "pipe"]
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		const [exitCode] = await once(child, "close");
		expect(exitCode).toBe(1);
		expect(output).toBe("Production API startup failed.\n");
	});

	it("reports the failed database setup stage without the setup configuration", async () => {
		const child = spawn(process.execPath, [entry], {
			cwd: packageRoot,
			env: { ...environment, DATABASE_SETUP_CONFIG: JSON.stringify({ tenant_id: "private-setup-value" }) },
			stdio: ["ignore", "pipe", "pipe"]
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		const [exitCode] = await once(child, "close");
		expect(exitCode).toBe(1);
		expect(output).toBe(`${JSON.stringify({ event: "database-setup-failed", stage: "validate configuration", message: "Invalid database setup configuration." })}\nProduction API startup failed.\n`);
	});

	it.for(["SIGTERM", "SIGINT"] as const)("serves probes and stops on %s without local CLI state", { timeout: 15000 }, async (signal, context) => {
		const child = spawn(process.execPath, [entry], {
			cwd: packageRoot,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"]
		});
		const exited = once(child, "close");
		context.onTestFinished(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		});
		let errors = "";
		child.stderr.on("data", (chunk) => { errors += chunk; });
		let startup = "";
		for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
			startup += chunk;
			if (startup.includes("\n")) break;
		}
		const event = JSON.parse(startup.trim()) as { event: string; port: number };
		expect(event.event).toBe("api-started");
		const url = `http://127.0.0.1:${event.port}`;
		expect((await fetch(`${url}/health/live`)).status).toBe(200);
		const ready = await fetch(`${url}/health/ready`);
		expect(ready.status).toBe(503);
		expect(await ready.json()).toEqual({ status: "not-ready" });
		const malformed = await fetch(`${url}/rpc`, {
			method: "POST", headers: { "content-type": "application/json" }, body: "private-request-value"
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).not.toContain("private-request-value");
		child.kill(signal);
		const [exitCode, exitSignal] = await exited;
		expect(exitCode).toBe(0);
		expect(exitSignal).toBeNull();
		expect(errors).toBe("");
	});
});