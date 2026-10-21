import { rmSync } from "node:fs";

import { build } from "esbuild";

rmSync("dist", { force: true, recursive: true });

await build({
	bundle: true,
	entryPoints: ["src/cli.ts"],
	format: "esm",
	outfile: "dist/bin/agent-issues-mcp.js",
	platform: "node",
	target: "node24"
});