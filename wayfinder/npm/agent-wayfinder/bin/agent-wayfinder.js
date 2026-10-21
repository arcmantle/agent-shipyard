#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const binaryName = process.platform === "win32" ? "agent-wayfinder.exe" : "agent-wayfinder";
const binaryPath = path.join(__dirname, binaryName);
const result = spawnSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`agent-wayfinder could not start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}