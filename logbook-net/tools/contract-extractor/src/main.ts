import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildInventory, findRepoRoot, serializeInventory } from "./extract.ts";

// Usage: bun run src/main.ts [--check]
//   (no flag)  write logbook-net/contract/inventory.json
//   --check    fail when the committed inventory differs from the current registrations
const root = findRepoRoot(import.meta.dir);
const target = path.join(root, "logbook-net", "contract", "inventory.json");
const next = serializeInventory(await buildInventory(root));

if (process.argv.includes("--check")) {
	const current = existsSync(target) ? readFileSync(target, "utf8") : "";
	if (current !== next) {
		console.error("logbook-net/contract/inventory.json is out of date. Run `bun run extract` and commit the result.");
		process.exit(1);
	}
	console.log("Inventory is current.");
} else {
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, next);
	console.log(`Wrote ${path.relative(root, target)}`);
}
