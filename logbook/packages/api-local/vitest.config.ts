import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		maxWorkers: 1
	},
	resolve: {
		alias: {
			"@agent-issues/core/storage-driver-contract": fileURLToPath(
				new URL("../core/src/features/storage-driver/storage-driver-contract.ts", import.meta.url)
			),
			"@agent-issues/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url))
		}
	}
});
