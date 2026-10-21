#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const packageDirectory = path.dirname(require.resolve("@arcmantle/agent-wayfinder/package.json"));
const command = path.join(packageDirectory, "bin", "agent-wayfinder.js");
const result = spawnSync(process.execPath, [command, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
	console.error(`agent-wayfinder could not start: ${result.error.message}`);
	process.exitCode = 1;
} else {
	process.exitCode = result.status ?? 1;
}