import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

import { startLiveSite, type LiveSiteHandle } from "../cli/src/site/index.js";

const devBackendHost = process.env.AGENT_ISSUES_DEV_BACKEND_HOST ?? "127.0.0.1";
const devBackendPort = Number(process.env.AGENT_ISSUES_DEV_BACKEND_PORT ?? "4313");

function agentIssuesLiveBackendPlugin(): Plugin {
	let liveSiteHandle: LiveSiteHandle | null = null;

	return {
		name: "agent-issues-live-backend",
		apply: "serve",
		async configureServer(server) {
			if (liveSiteHandle) {
				return;
			}

			const portAvailable = await isPortAvailable(devBackendHost, devBackendPort);
			if (!portAvailable) {
				server.config.logger.info(
					`Using existing backend on http://${devBackendHost}:${devBackendPort} for snapshot and event APIs.`
				);
				return;
			}

			liveSiteHandle = await startLiveSite({
				dbPath: process.env.AGENT_ISSUES_DB,
				host: devBackendHost,
				port: devBackendPort
			});

			server.config.logger.info(
				`Started agent-issues backend on ${liveSiteHandle.info.url} for Vite development.`
			);

			server.httpServer?.once("close", () => {
				liveSiteHandle?.close();
				liveSiteHandle = null;
			});
		}
	};
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createNetServer();

		probe.once("error", () => {
			resolve(false);
		});

		probe.once("listening", () => {
			probe.close(() => {
				resolve(true);
			});
		});

		probe.listen(port, host);
	});
}

export default defineConfig({
	plugins: [agentIssuesLiveBackendPlugin()],
	build: {
		rollupOptions: {
			output: { inlineDynamicImports: true }
		}
	},
	resolve: {
		alias: {
			"@agent-issues/core/instruction-store": fileURLToPath(new URL("../core/src/features/storage-driver/instruction-store.ts", import.meta.url)),
			"@agent-issues/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url))
		}
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		proxy: {
			"/api": `http://${devBackendHost}:${devBackendPort}`,
			"/events": `http://${devBackendHost}:${devBackendPort}`,
			"/site-config.json": `http://${devBackendHost}:${devBackendPort}`
		}
	}
});