import { defineConfig } from "vite";

// The Development API host URL comes from the shared Aspire composition (AGENT_LOGBOOK_API_URL).
const apiUrl = process.env.AGENT_LOGBOOK_API_URL;
const proxiedPaths = ["/api", "/events", "/health", "/.well-known/agent-logbook"];

export default defineConfig({
	server: {
		host: "127.0.0.1",
		port: Number(process.env.PORT ?? 5174),
		strictPort: true,
		proxy: apiUrl ? Object.fromEntries(proxiedPaths.map((path) => [path, { target: apiUrl, changeOrigin: true }])) : undefined
	}
});
