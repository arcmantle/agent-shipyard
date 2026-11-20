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
			"@agent-logbook/core/instruction-store": fileURLToPath(new URL("../core/src/instruction-store.ts", import.meta.url))
		}
	}
});
