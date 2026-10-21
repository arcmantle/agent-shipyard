import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const COMMAND_FAMILIES = [
	"auth",
	"backfill",
	"comments",
	"context",
	"daemon",
	"entities",
	"export",
	"fallback",
	"issue-breakdowns",
	"instructions",
	"kanban",
	"meta",
	"plan-entries",
	"plugin",
	"site",
	"sql",
	"synchronize",
	"tenants"
];
const MAX_BOOTSTRAP_BYTES = 10 * 1024;
const MAX_LIGHTWEIGHT_STARTUP_MS = 1_000;
const STARTUP_PROCESS_TIMEOUT_MS = 10_000;
const STARTUP_RUN_COUNT = 3;

export function validateCliBuild(outputDirectory) {
	const bootstrapPath = path.join(outputDirectory, "cli.js");
	const bootstrapSize = statSync(bootstrapPath).size;

	if (bootstrapSize > MAX_BOOTSTRAP_BYTES) {
		throw new Error(`CLI bootstrap is ${bootstrapSize} bytes; maximum is ${MAX_BOOTSTRAP_BYTES} bytes.`);
	}

	const bootstrapSource = readFileSync(bootstrapPath, "utf8");
	if (!bootstrapSource.includes('import("./cli-')) {
		throw new Error("CLI bootstrap must dynamically import the command dispatcher.");
	}

	const outputFiles = readdirSync(outputDirectory);
	for (const family of COMMAND_FAMILIES) {
		if (!outputFiles.some((fileName) => new RegExp(`^${escapeRegExp(family)}-[A-Z0-9]+\\.js$`).test(fileName))) {
			throw new Error(`CLI build has no deferred ${family} command-family chunk.`);
		}
	}

	const startupDurations = Array.from({ length: STARTUP_RUN_COUNT }, () => measureLightweightStartup(bootstrapPath));
	const startupDuration = Math.max(...startupDurations);
	if (startupDuration > MAX_LIGHTWEIGHT_STARTUP_MS) {
		throw new Error(
			`Lightweight CLI startup took ${startupDuration.toFixed(0)}ms; maximum is ${MAX_LIGHTWEIGHT_STARTUP_MS}ms.`
		);
	}

	console.log(
		`Validated CLI bootstrap (${bootstrapSize} bytes), ${COMMAND_FAMILIES.length} deferred command families, and lightweight startup (${startupDuration.toFixed(0)}ms maximum).`
	);
}

function measureLightweightStartup(bootstrapPath) {
	const startedAt = process.hrtime.bigint();
	const result = spawnSync(process.execPath, [bootstrapPath, "project-identity", "--json"], {
		encoding: "utf8",
		timeout: STARTUP_PROCESS_TIMEOUT_MS
	});
	const duration = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

	if (result.error) {
		throw new Error(`Could not measure lightweight CLI startup: ${result.error.message}`);
	}

	if (result.status !== 0) {
		throw new Error(`Lightweight CLI command failed during startup measurement: ${result.stderr}`);
	}

	const output = JSON.parse(result.stdout);
	if (output.command !== "project-identity") {
		throw new Error("Lightweight CLI command produced an unexpected startup measurement result.");
	}

	return duration;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}