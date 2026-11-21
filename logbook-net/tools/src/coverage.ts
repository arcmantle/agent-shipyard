// Coverage check for Port slices.
// Usage (from logbook-net/tools): bun src/coverage.ts [--release] [--list]
//   Joins contract/inventory.json to contract/cases, contract/slices.json and contract/surface-rules.json.
//   Every inventory surface must be removed (approved rule), claimed by a slice, or listed as not yet ported.
//   A claimed slice fails when a surface it claims has no required case.
//   --release also refuses every not-yet-ported entry, every unclaimed slice and every partial storage claim.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type Case } from "./cases.ts";
import { routeNames, validateRemovals, type Inventory, type Removal } from "./surfaces.ts";

/** The parts of inventory.json that the coverage check adds to the ones that `surfaces.ts` reads. */
export type CoverageInventory = Inventory & {
	cli: { commands: { id: string; path: string[]; requirements: { help: boolean; jsonSuccess: boolean; error: boolean; humanOutput: boolean } }[] };
	mcp: { tools: { name: string }[]; toolList: { order: string[] }; resources: { uri: string }[] };
	storageContract: { groups: string[] };
};

export type StorageClaim = { group: string; tests: string[] | "all"; remainder?: string };
export type Slice = { id: string; claimed: boolean; description: string; surfaces: string[]; storage: StorageClaim[] };
export type NotYetPorted = { group: string; reason: string; surfaces: string[] };
export type SliceFile = { slices: Slice[]; notYetPorted: NotYetPorted[] };

export class SliceFileError extends Error {}

export type Mode = "development" | "release";
export type Disposition = "removed" | "claimed" | "not-yet-ported" | "unclassified";
export type SurfaceKind = "cli" | "rpc" | "mcp-tool" | "mcp-tools-list" | "mcp-resource" | "host-route" | "website-route" | "storage";
export type Surface = { id: string; kind: SurfaceKind };

export const MCP_TOOLS_LIST = "mcp:tools/list";

/** Every surface of the inventory that a Port slice can own. */
export function inventorySurfaces(inventory: CoverageInventory): Surface[] {
	const websiteRoutes = new Set([inventory.website.routes, inventory.website.liveSiteRoutes].flatMap((routes) => routes.flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))));
	const surfaces: Surface[] = [
		...inventory.cli.commands.map((command): Surface => ({ id: command.id, kind: "cli" })),
		...inventory.rpc.methods.map((method): Surface => ({ id: `rpc:${method.name}`, kind: "rpc" })),
		...inventory.mcp.tools.map((tool): Surface => ({ id: `mcp:${tool.name}`, kind: "mcp-tool" })),
		{ id: MCP_TOOLS_LIST, kind: "mcp-tools-list" },
		...inventory.mcp.resources.map((resource): Surface => ({ id: `mcp-resource:${resource.uri}`, kind: "mcp-resource" })),
		...[...new Set(routeNames(inventory))].map((route): Surface => ({ id: `route:${route}`, kind: websiteRoutes.has(route) ? "website-route" : "host-route" })),
		...inventory.storageContract.groups.map((group): Surface => ({ id: `storage:${group}`, kind: "storage" }))
	];
	const seen = new Set<string>();
	for (const surface of surfaces) {
		if (seen.has(surface.id)) throw new SliceFileError(`inventory.json: the surface ${surface.id} appears twice`);
		seen.add(surface.id);
	}
	return surfaces;
}

/** Checks the shape of slices.json. It does not compare it with the inventory. */
export function validateSliceFile(value: unknown): SliceFile {
	const fail = (message: string): never => {
		throw new SliceFileError(`slices.json: ${message}`);
	};
	const isText = (item: unknown): item is string => typeof item === "string" && item.trim() !== "";
	const root = value as { slices?: unknown; notYetPorted?: unknown } | null;
	if (!Array.isArray(root?.slices)) return fail("slices must be an array");
	if (!Array.isArray(root?.notYetPorted)) return fail("notYetPorted must be an array");
	const ids = new Set<string>();
	const slices = (root.slices as Record<string, unknown>[]).map((entry, index): Slice => {
		const label = `slice ${index + 1}${isText(entry?.id) ? ` (${entry.id})` : ""}`;
		if (!isText(entry?.id) || !/^[a-z0-9-]+$/.test(entry.id)) return fail(`${label}: id must be a lower-case name`);
		if (ids.has(entry.id)) return fail(`${label}: duplicate id`);
		ids.add(entry.id);
		if (typeof entry.claimed !== "boolean") return fail(`${label}: claimed must be true or false`);
		if (!isText(entry.description)) return fail(`${label}: description must be a non-empty string`);
		if (!Array.isArray(entry.surfaces) || !entry.surfaces.every(isText)) return fail(`${label}: surfaces must be an array of surface ids`);
		if (!Array.isArray(entry.storage)) return fail(`${label}: storage must be an array`);
		const storage = (entry.storage as Record<string, unknown>[]).map((claim): StorageClaim => {
			if (!isText(claim?.group)) return fail(`${label}: each storage claim needs a group`);
			const tests = claim.tests;
			if (tests !== "all" && !(Array.isArray(tests) && tests.length > 0 && tests.every(isText))) return fail(`${label}: storage ${claim.group} needs tests "all" or a non-empty list of test titles`);
			if (tests !== "all" && !isText(claim.remainder)) return fail(`${label}: storage ${claim.group} claims part of the group, so it needs a remainder that says where the other tests go`);
			return { group: claim.group, tests: tests as StorageClaim["tests"], ...(isText(claim.remainder) ? { remainder: claim.remainder } : {}) };
		});
		return { id: entry.id, claimed: entry.claimed, description: entry.description, surfaces: entry.surfaces as string[], storage };
	});
	const notYetPorted = (root.notYetPorted as Record<string, unknown>[]).map((entry, index): NotYetPorted => {
		const label = `notYetPorted ${index + 1}${isText(entry?.group) ? ` (${entry.group})` : ""}`;
		if (!isText(entry?.group)) return fail(`${label}: group must be a non-empty string`);
		if (!isText(entry.reason)) return fail(`${label}: reason must be a non-empty string`);
		if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0 || !entry.surfaces.every(isText)) return fail(`${label}: surfaces must be a non-empty array of surface ids`);
		return { group: entry.group, reason: entry.reason, surfaces: entry.surfaces as string[] };
	});
	return { slices, notYetPorted };
}

type CliKind = "help" | "error" | "json" | "human";

/** Finds the command that a CLI case drives and what kind of case it is. A `help <command>` case is a help case of that command. */
export function classifyCliCase(testCase: Case & { surface: "cli" }, commands: CoverageInventory["cli"]["commands"]): { target: string; kind: CliKind } | null {
	const words: string[] = [];
	for (const arg of testCase.argv) {
		if (arg.startsWith("-")) break;
		words.push(arg);
	}
	const asHelp = testCase.argv.includes("--help") || testCase.argv.includes("-h");
	// `help <command>` is a help case of that command. `help --help` is the help case of the help command; `help` alone is a human output case of it.
	const search = words[0] === "help" ? words.slice(1) : words;
	let target = "cli:(default)";
	let length = 0;
	for (const command of commands) {
		const commandPath = command.path;
		if (commandPath.length > length && commandPath.every((word, index) => search[index] === word)) {
			target = command.id;
			length = commandPath.length;
		}
	}
	if (words[0] === "help" && length === 0) target = "cli:help";
	if (asHelp || (words[0] === "help" && length > 0)) return { target, kind: "help" };
	const exitCode = testCase.expectExitCode ?? 0;
	if (exitCode !== 0) return { target, kind: "error" };
	return { target, kind: testCase.argv.includes("--json") ? "json" : "human" };
}

/** What the cases drive, indexed once for the whole check. */
export type CaseIndex = {
	cli: Map<string, Set<CliKind>>;
	rpc: Set<string>;
	mcpTools: Set<string>;
	mcpToolsList: boolean;
	mcpResources: Set<string>;
};

export function indexCases(cases: Case[], inventory: CoverageInventory): CaseIndex {
	const index: CaseIndex = { cli: new Map(), rpc: new Set(), mcpTools: new Set(), mcpToolsList: false, mcpResources: new Set() };
	for (const testCase of cases) {
		if (testCase.surface === "cli") {
			const found = classifyCliCase(testCase, inventory.cli.commands);
			if (found) index.cli.set(found.target, (index.cli.get(found.target) ?? new Set()).add(found.kind));
		} else if (testCase.surface === "rpc") {
			for (const step of testCase.steps) index.rpc.add(step.method);
		} else {
			for (const step of testCase.steps) {
				const params = (step.params ?? {}) as { name?: unknown; uri?: unknown };
				if (step.method === "tools/call" && typeof params.name === "string") index.mcpTools.add(params.name);
				if (step.method === "tools/list") index.mcpToolsList = true;
				if (step.method === "resources/read" && typeof params.uri === "string") index.mcpResources.add(params.uri);
			}
		}
	}
	return index;
}

/** The cases that a claimed surface still needs. An empty list means the surface is fully covered. */
export function missingCases(surface: Surface, inventory: CoverageInventory, index: CaseIndex): string[] {
	switch (surface.kind) {
		case "cli": {
			const requirements = inventory.cli.commands.find((command) => command.id === surface.id)!.requirements;
			const have = index.cli.get(surface.id) ?? new Set<CliKind>();
			return [
				...(requirements.help && !have.has("help") ? ["a --help or help <command> case"] : []),
				...(requirements.jsonSuccess && !have.has("json") ? ["a --json success case"] : []),
				...(requirements.error && !have.has("error") ? ["an error case (non-zero exit code and stderr)"] : []),
				...(requirements.humanOutput && !have.has("human") ? ["a human output case"] : [])
			];
		}
		case "rpc":
			return index.rpc.has(surface.id.slice("rpc:".length)) ? [] : ["an RPC case"];
		case "mcp-tool":
			return index.mcpTools.has(surface.id.slice("mcp:".length)) ? [] : ["an MCP tools/call case"];
		case "mcp-tools-list":
			return index.mcpToolsList ? [] : ["an MCP tools/list case"];
		case "mcp-resource":
			return index.mcpResources.has(surface.id.slice("mcp-resource:".length)) ? [] : ["an MCP resources/read case"];
		case "website-route":
			return ["a site case (the case format has no site surface yet, so a slice cannot claim a website route)"];
		case "host-route":
		case "storage":
			return [];
	}
}

export type CoverageReport = {
	errors: string[];
	dispositions: { surface: string; disposition: Disposition; owner?: string }[];
};

export type CoverageInput = {
	inventory: CoverageInventory;
	removals: Removal[];
	cases: Case[];
	sliceFile: SliceFile;
	mode: Mode;
	/** The text of the TypeScript storage-driver contract. Without it the claimed test titles are not checked. */
	contractSource?: string;
};

export function checkCoverage(input: CoverageInput): CoverageReport {
	const { inventory, removals, sliceFile, mode } = input;
	const errors: string[] = [];
	const surfaces = inventorySurfaces(inventory);
	const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
	const removedBy = new Map(removals.filter((rule) => rule.kind === "cli-command" || rule.kind === "host-route").map((rule) => [rule.kind === "cli-command" ? rule.name : `route:${rule.name}`, rule.id]));

	const owners = new Map<string, string>();
	const claim = (surfaceId: string, owner: string, label: string) => {
		const first = owners.get(surfaceId);
		if (!byId.has(surfaceId)) errors.push(`${label}: ${surfaceId} is not a surface in the inventory`);
		else if (first !== undefined) errors.push(`${surfaceId} is listed twice: by ${first} and by ${label}`);
		else owners.set(surfaceId, label);
	};

	const claimed = new Set<string>();
	const pending = new Set<string>();
	const index = indexCases(input.cases, inventory);
	for (const slice of sliceFile.slices) {
		const label = `slice ${slice.id}`;
		const claims = [...slice.surfaces, ...slice.storage.map((storage) => `storage:${storage.group}`)];
		for (const surfaceId of claims) {
			claim(surfaceId, label, label);
			claimed.add(surfaceId);
			const surface = byId.get(surfaceId);
			if (surface === undefined) continue;
			if (removedBy.has(surfaceId)) errors.push(`${label}: ${surfaceId} is removed by ${removedBy.get(surfaceId)}, so it cannot be claimed`);
			if (slice.claimed) for (const need of missingCases(surface, inventory, index)) errors.push(`${label}: ${surfaceId} needs ${need}`);
		}
		for (const storage of slice.storage) {
			if (storage.tests === "all" || input.contractSource === undefined) continue;
			for (const title of storage.tests) {
				if (!input.contractSource.includes(`it(${JSON.stringify(title)}`)) errors.push(`${label}: the storage-driver contract has no test titled ${JSON.stringify(title)}`);
			}
		}
		if (mode === "release") {
			if (!slice.claimed) errors.push(`${label}: release mode needs every slice to be claimed`);
			for (const storage of slice.storage) if (storage.tests !== "all") errors.push(`${label}: release mode needs all tests of the storage group ${storage.group}, not a selection`);
		}
	}
	for (const entry of sliceFile.notYetPorted) {
		for (const surfaceId of entry.surfaces) {
			claim(surfaceId, `notYetPorted ${entry.group}`, `notYetPorted ${entry.group}`);
			pending.add(surfaceId);
			if (removedBy.has(surfaceId)) errors.push(`notYetPorted ${entry.group}: ${surfaceId} is removed by ${removedBy.get(surfaceId)}, so it is not a development exception`);
		}
		if (mode === "release") errors.push(`release mode refuses the not-yet-ported entry ${entry.group} (${entry.surfaces.length} surfaces)`);
	}

	const dispositions = surfaces.map((surface): CoverageReport["dispositions"][number] => {
		const removal = removedBy.get(surface.id);
		if (removal !== undefined) return { surface: surface.id, disposition: "removed", owner: removal };
		if (claimed.has(surface.id)) return { surface: surface.id, disposition: "claimed", owner: owners.get(surface.id) };
		if (pending.has(surface.id)) return { surface: surface.id, disposition: "not-yet-ported", owner: owners.get(surface.id) };
		errors.push(`${surface.id} is not removed, claimed by a slice, or listed as not yet ported`);
		return { surface: surface.id, disposition: "unclassified" };
	});
	return { errors, dispositions };
}

if (import.meta.main) {
	const netRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const read = (file: string) => JSON.parse(readFileSync(path.join(netRoot, file), "utf8"));
	const inventory = read("contract/inventory.json") as CoverageInventory;
	const removals = validateRemovals(read("contract/surface-rules.json"), inventory, path.resolve(netRoot, ".."));
	const contractFile = path.join(netRoot, "../logbook/packages/core/src/features/storage-driver/storage-driver-contract.ts");
	const mode: Mode = process.argv.includes("--release") ? "release" : "development";
	const report = checkCoverage({
		inventory,
		removals,
		cases: loadCases(path.join(netRoot, "contract/cases")),
		sliceFile: validateSliceFile(read("contract/slices.json")),
		mode,
		contractSource: existsSync(contractFile) ? readFileSync(contractFile, "utf8") : undefined
	});
	if (process.argv.includes("--list")) for (const entry of report.dispositions) console.log(`${entry.disposition.padEnd(14)} ${entry.surface}${entry.owner ? ` (${entry.owner})` : ""}`);
	const count = (disposition: Disposition) => report.dispositions.filter((entry) => entry.disposition === disposition).length;
	console.log(`${mode} mode: ${count("claimed")} claimed, ${count("removed")} removed, ${count("not-yet-ported")} not yet ported, ${count("unclassified")} unclassified`);
	if (report.errors.length > 0) {
		console.error(`coverage check failed:\n${report.errors.map((error) => `  - ${error}`).join("\n")}`);
		process.exit(1);
	}
}
