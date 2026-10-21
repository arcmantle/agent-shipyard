import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environmentMatchGlobs: [["src/plan-preview/**/*.test.ts", "happy-dom"]],
		environment: "node",
		include: ["src/**/*.test.ts"],
		setupFiles: ["./src/vitest-setup.ts"],
		maxWorkers: 1
	},
	resolve: {
		alias: [
			{ find: "@agent-issues/core", replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
			{ find: "@agent-issues/api-local", replacement: fileURLToPath(new URL("../api-local/src/index.ts", import.meta.url)) },
			{ find: "@agent-issues/api-pg", replacement: fileURLToPath(new URL("../api-pg/src/index.ts", import.meta.url)) }
		]
	}
});
