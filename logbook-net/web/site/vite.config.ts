import { defineConfig } from "vite";

import productionConfig from "./vite.production.config.js";

// The Development API host URL comes from the shared Aspire composition (AGENT_LOGBOOK_API_URL).
// Without it there is no proxy, and the dev server does not guess a port.
const apiUrl = process.env.AGENT_LOGBOOK_API_URL;
const proxiedPaths = ["/api", "/events", "/site-config.json", "/health", "/.well-known/agent-logbook"];

export default defineConfig({
	...productionConfig,
	server: {
		host: "127.0.0.1",
		port: Number(process.env.PORT ?? 5173),
		strictPort: true,
		proxy: apiUrl ? Object.fromEntries(proxiedPaths.map((path) => [path, { target: apiUrl, changeOrigin: true }])) : undefined
	}
});
