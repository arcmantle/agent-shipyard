// Approved removals.
// Usage (from logbook-net/tools): bun src/surfaces.ts
//   Checks contract/surface-rules.json against contract/inventory.json. `coverage.ts` joins the removals to the slices and the cases.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RETAINED_INPUTS } from "./rename.ts";

export type Removal = { id: string; kind: "cli-command" | "host-route" | "legacy-name" | "component"; name: string; category?: string; decision: string; reason: string };

export class SurfaceRuleError extends Error {}

/** The parts of inventory.json that the check reads. */
export type Inventory = {
	cli: { commands: { id: string; path: string[] }[] };
	rpc: { methods: { name: string }[]; endpoints: { path: string; methods: string[] }[] };
	mcp: { tools: { name: string }[] };
	website: { routes: { path: string; methods: string[] }[]; liveSiteRoutes: { path: string; methods: string[] }[] };
	hostRoutes: { path: string; methods: string[] }[];
};

const KINDS = ["cli-command", "host-route", "legacy-name", "component"];

export function routeNames(inventory: Inventory): string[] {
	return [inventory.hostRoutes, inventory.rpc.endpoints, inventory.website.routes, inventory.website.liveSiteRoutes].flatMap((routes) => routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`)));
}

/**
 * Checks the removal rules. Each rule names exactly one thing. A removal cannot use a wildcard, so it cannot hide a retained surface.
 * A command or route must exist in the inventory, a component must exist in the repository, and no removal may name a retained input.
 * `repoRoot` is the folder that contains `logbook/`.
 */
export function validateRemovals(value: unknown, inventory: Inventory, repoRoot: string): Removal[] {
	const fail = (message: string): never => {
		throw new SurfaceRuleError(`surface-rules.json: ${message}`);
	};
	const list = (value as { removed?: unknown } | null)?.removed;
	if (!Array.isArray(list)) return fail("removed must be an array");
	const commands = new Set(inventory.cli.commands.map((command) => command.id));
	const routes = new Set(routeNames(inventory));
	const ids = new Set<string>();
	const names = new Set<string>();
	return list.map((entry, index) => {
		const rule = entry as Record<string, unknown>;
		const label = `removal ${index + 1}${typeof rule?.id === "string" ? ` (${rule.id})` : ""}`;
		for (const key of ["id", "kind", "name", "decision", "reason"]) {
			if (typeof rule?.[key] !== "string" || (rule[key] as string).trim() === "") return fail(`${label}: ${key} must be a non-empty string`);
		}
		const item = rule as unknown as Removal;
		if (ids.has(item.id)) return fail(`${label}: duplicate id`);
		ids.add(item.id);
		if (names.has(`${item.kind} ${item.name}`)) return fail(`${label}: ${item.kind} ${item.name} is removed twice`);
		names.add(`${item.kind} ${item.name}`);
		if (!KINDS.includes(item.kind)) return fail(`${label}: kind must be one of ${KINDS.join(", ")}`);
		if (!/^PLAN_ENTRY_[0-9A-Z]+$/.test(item.decision)) return fail(`${label}: decision must be a Plan entry reference`);
		if (/[*?]/.test(item.name) || item.name.trim() !== item.name) return fail(`${label}: name must be one exact name, with no wildcard`);
		if (item.kind === "cli-command" && !commands.has(item.name)) return fail(`${label}: ${item.name} is not a command in the inventory`);
		if (item.kind === "host-route" && !routes.has(item.name)) return fail(`${label}: ${item.name} is not a route in the inventory`);
		if (item.kind === "component" && !existsSync(path.join(repoRoot, item.name))) return fail(`${label}: ${item.name} does not exist`);
		if (item.kind === "legacy-name" && (typeof item.category !== "string" || item.category === "")) return fail(`${label}: a legacy-name removal needs a category`);
		const retained = RETAINED_INPUTS.find((input) => item.name === input || input.includes(item.name) || item.name.includes(input));
		if (retained !== undefined) return fail(`${label}: ${item.name} overlaps the retained input ${retained}`);
		return item;
	});
}

if (import.meta.main) {
	const netRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const inventory = JSON.parse(readFileSync(path.join(netRoot, "contract/inventory.json"), "utf8")) as Inventory;
	const removals = validateRemovals(JSON.parse(readFileSync(path.join(netRoot, "contract/surface-rules.json"), "utf8")), inventory, path.resolve(netRoot, ".."));
	console.log(`${removals.length} removal rules are valid`);
}
