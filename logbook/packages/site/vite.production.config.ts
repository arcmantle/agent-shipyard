import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
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
	}
});
