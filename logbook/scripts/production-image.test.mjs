import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.env.LOGBOOK_TEST_IMAGE ?? "logbook-api:local-check";
const environment = [
	"--env", "DATABASE_URL=postgres://runtime@127.0.0.1:1/logbook?sslmode=verify-full",
	"--env", "DATABASE_MANAGED_IDENTITY_CLIENT_ID=33333333-3333-4333-8333-333333333333",
	"--env", "ENTRA_TENANT_ID=11111111-1111-4111-8111-111111111111",
	"--env", "ENTRA_CLIENT_ID=22222222-2222-4222-8222-222222222222"
];
const docker = (args) => execute("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 });

test("the image rejects missing configuration without a stack trace", async () => {
	await assert.rejects(docker(["run", "--rm", image]), (error) => {
		assert.equal(error.code, 1);
		assert.equal(error.stdout, "");
		assert.equal(error.stderr, "Production API startup failed.\n");
		return true;
	});
});

test("the non-root image serves probes without PostgreSQL and stops cleanly", async () => {
	const name = `logbook-api-test-${randomUUID()}`;
	try {
		await docker([
			"run", "--detach", "--name", name, "--read-only", "--cap-drop", "ALL",
			"--security-opt", "no-new-privileges", "--publish", "127.0.0.1::8080", ...environment, image
		]);
		const { stdout: port } = await docker(["inspect", "--format", '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}', name]);
		const url = `http://127.0.0.1:${port.trim()}`;
		const deadline = Date.now() + 15000;
		while (true) {
			try {
				assert.equal((await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(1000) })).status, 200);
				break;
			} catch (error) {
				if (Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		const ready = await fetch(`${url}/health/ready`);
		assert.equal(ready.status, 503);
		assert.deepEqual(await ready.json(), { status: "not-ready" });
		const rpc = await fetch(`${url}/rpc`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemonHealth" })
		});
		assert.equal(rpc.status, 401);
		await docker(["exec", name, "node", "--input-type=module", "-e", `
			import assert from 'node:assert/strict';
			import { stat } from 'node:fs/promises';
			assert.notEqual(process.getuid(), 0);
			assert.equal(process.versions.node.split('.')[0], '24');
			assert.equal((await stat('/app/public')).isDirectory(), true);
			await assert.rejects(import('typescript'));
		`]);
		await docker(["stop", "--time", "3", name]);
		const { stdout: exitCode } = await docker(["inspect", "--format", "{{.State.ExitCode}}", name]);
		assert.equal(exitCode.trim(), "0");
		const logs = await docker(["logs", name]);
		assert.equal(logs.stderr, "");
		assert.doesNotMatch(logs.stdout, /test-password|DATABASE_URL|11111111/);
	} finally {
		await docker(["rm", "--force", name]);
	}
});

test("the packaged API accepts a test identity through its authenticated gate", async () => {
	await docker([
		"run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		...environment, "--env", "HOST=127.0.0.1", "--env", "PORT=0", "--entrypoint", "node", image,
		"--input-type=module", "-e", `
			import assert from 'node:assert/strict';
			import { LocalAuthProvider } from './dist/index.js';
			import { startProductionApi } from './dist/production.js';
			const authProvider = new LocalAuthProvider({ secret: 'image-test-only' });
			const handle = await startProductionApi({ environment: process.env, authProvider });
			try {
				const token = await authProvider.issueToken({ userId: 'image-test', tenantId: 'image-test' });
				const response = await fetch(handle.url + '/rpc', {
					method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemonHealth' })
				});
				assert.equal(response.status, 200);
				assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: { ready: true } });
			} finally {
				await handle.close();
			}
		`
	]);
});