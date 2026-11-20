import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// The tests of the shared storage-driver contract that the ported slices satisfy. A slice that ports more of the contract
// adds the titles here. Each title is a whole test title; the run fails when one of them no longer exists in the contract.
export const APPLICABLE_TESTS = [
	"creates an entity and reads it back through the async seam",
	"creates and resolves an entity by UUID or Canonical reference",
	"creation establishes revision-1 baseline with a correct content hash",
	"creates open debt with required metadata under a supported owner",
	"requires controlled debt metadata and permits it on other entity kinds",
	"requires Plans to have an initiative owner",
	"ignores caller-supplied statuses when creating a Plan",
	"rejects invalid Plan statuses and preserves supplied statuses for other kinds",
	"accepts a viewer short reference as a parent selector",
	"releases the underlying connection on close"
];

const netRoot = path.resolve(import.meta.dir, "../..");
const here = import.meta.dir;
const apiUrl = process.argv[2] ?? process.env.AGENT_LOGBOOK_API_URL;
if (!apiUrl) {
	console.error("usage: bun tools/storage-driver-contract/run.ts <api-url>   (a .NET API host with a fresh database)");
	process.exit(2);
}

const contractSource = readFileSync(path.join(netRoot, "../logbook/packages/core/src/features/storage-driver/storage-driver-contract.ts"), "utf8");
const missing = APPLICABLE_TESTS.filter((title) => !contractSource.includes(`it(${JSON.stringify(title)}`));
if (missing.length > 0) {
	console.error(`these tests are not in the storage-driver contract any more:\n${missing.join("\n")}`);
	process.exit(2);
}

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = `(${APPLICABLE_TESTS.map(escape).join("|")})$`;
const result = spawnSync(
	"pnpm",
	["--dir", path.join(netRoot, "../logbook"), "exec", "vitest", "run", "--config", path.join(here, "vitest.config.mjs"), "--root", here, "-t", pattern, "--reporter", "verbose"],
	{ stdio: "inherit", env: { ...process.env, AGENT_LOGBOOK_API_URL: apiUrl } }
);
process.exit(result.status ?? 1);
