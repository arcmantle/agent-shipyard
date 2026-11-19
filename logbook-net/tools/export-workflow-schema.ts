// Exports the workflow schema that `agent-logbook schema` serves.
// Run with Bun:
//   bun logbook-net/tools/export-workflow-schema.ts          write the embedded resource
//   bun logbook-net/tools/export-workflow-schema.ts --check  fail when the resource differs from a fresh export
//
// The source is the recorded TypeScript `schema --json` result (contract/golden/cli/schema-json.golden.json).
// The product-name rename of the Parity corpus is applied to its text. Nothing else changes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renameVisible } from "./src/rename.ts";

const netRoot = path.resolve(import.meta.dir, "..");
export const goldenFile = path.join(netRoot, "contract/golden/cli/schema-json.golden.json");
export const resourceFile = path.join(netRoot, "src/AgentLogbook.Core/WorkflowSchema/workflow-schema.json");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function rename(value: Json): Json {
	if (typeof value === "string") return renameVisible(value);
	if (Array.isArray(value)) return value.map(rename);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rename(item)]));
	return value;
}

export function exportWorkflowSchema(): string {
	const golden = JSON.parse(readFileSync(goldenFile, "utf8")) as { exitCode: number; stdout: Json };
	if (golden.exitCode !== 0 || typeof golden.stdout !== "object" || golden.stdout === null || Array.isArray(golden.stdout)) {
		throw new Error("The recorded schema result is not a successful JSON object.");
	}

	return `${JSON.stringify(rename(golden.stdout), null, "\t")}\n`;
}

if (import.meta.main) {
	const text = exportWorkflowSchema();
	if (process.argv.includes("--check")) {
		if (!existsSync(resourceFile) || readFileSync(resourceFile, "utf8") !== text) {
			console.error("workflow-schema.json differs from a fresh export. Run bun logbook-net/tools/export-workflow-schema.ts.");
			process.exit(1);
		}
		console.log("workflow-schema.json is current");
	} else {
		writeFileSync(resourceFile, text);
		console.log(`wrote ${path.relative(netRoot, resourceFile)}`);
	}
}
