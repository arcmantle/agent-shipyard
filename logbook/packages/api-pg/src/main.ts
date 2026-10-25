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
} catch {
	process.stderr.write("Production API startup failed.\n");
	process.exitCode = 1;
}