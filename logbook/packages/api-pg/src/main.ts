import { startProductionApi } from "./production.js";

process.env.NODE_ENV = "production";

try {
	const handle = await startProductionApi({ environment: process.env });
	process.stdout.write(`${JSON.stringify({ event: "api-started", port: Number(new URL(handle.url).port) })}\n`);
	const shutdown = () => {
		void handle.close().then(() => {
			process.stdout.write('{"event":"api-stopped"}\n');
			process.exit(0);
		}, () => {
			process.stderr.write("Production API shutdown failed.\n");
			process.exit(1);
		});
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
} catch (error) {
	const failure = error as { stage?: unknown; code?: unknown; message?: unknown };
	if (typeof failure?.stage === "string") {
		const message = typeof failure.message === "string" ? failure.message.slice(0, 300) : undefined;
		const code = typeof failure.code === "string" ? failure.code : undefined;
		process.stderr.write(`${JSON.stringify({ event: "database-setup-failed", stage: failure.stage, code, message })}\n`);
	}
	process.stderr.write("Production API startup failed.\n");
	process.exitCode = 1;
}