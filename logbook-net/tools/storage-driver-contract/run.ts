import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateSliceFile } from "../src/coverage.ts";

const netRoot = path.resolve(import.meta.dir, "../..");
const here = import.meta.dir;
const apiUrl = process.argv[2] ?? process.env.AGENT_LOGBOOK_API_URL;
if (!apiUrl) {
	console.error("usage: bun tools/storage-driver-contract/run.ts <api-url>   (a .NET API host with a fresh database)");
	process.exit(2);
}

const contractSource = readFileSync(path.join(netRoot, "../logbook/packages/core/src/features/storage-driver/storage-driver-contract.ts"), "utf8");
// The claimed slices of contract/slices.json select what applies: whole groups, or the listed tests of a group.
const claims = validateSliceFile(JSON.parse(readFileSync(path.join(netRoot, "contract/slices.json"), "utf8"))).slices.filter((slice) => slice.claimed).flatMap((slice) => slice.storage);
const titles = claims.flatMap((claim) => (claim.tests === "all" ? [] : claim.tests));
const groups = claims.filter((claim) => claim.tests === "all").map((claim) => claim.group);
const missing = titles.filter((title) => !contractSource.includes(`it(${JSON.stringify(title)}`));
if (missing.length > 0) {
	console.error(`these tests are not in the storage-driver contract any more:\n${missing.join("\n")}`);
	process.exit(2);
}

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = [...(titles.length > 0 ? [`(${titles.map(escape).join("|")})$`] : []), ...groups.map((group) => `storage-driver seam: ${escape(group)} \\(`)].join("|");
const result = spawnSync(
	"pnpm",
	["--dir", path.join(netRoot, "../logbook"), "exec", "vitest", "run", "--config", path.join(here, "vitest.config.mjs"), "--root", here, "-t", pattern, "--reporter", "verbose"],
	{ stdio: "inherit", env: { ...process.env, AGENT_LOGBOOK_API_URL: apiUrl } }
);
process.exit(result.status ?? 1);
