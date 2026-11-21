import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCases, type Case } from "./cases.ts";
import { checkCoverage, indexCases, inventorySurfaces, SliceFileError, validateSliceFile, type CoverageInventory, type SliceFile } from "./coverage.ts";
import { validateRemovals } from "./surfaces.ts";

const netRoot = path.resolve(import.meta.dir, "../..");
const read = (file: string) => JSON.parse(readFileSync(path.join(netRoot, file), "utf8"));
const inventory = read("contract/inventory.json") as CoverageInventory;
const removals = validateRemovals(read("contract/surface-rules.json"), inventory, path.resolve(netRoot, ".."));
const cases = loadCases(path.join(netRoot, "contract/cases"));
const sliceFile = validateSliceFile(read("contract/slices.json"));
const clone = <T>(value: T): T => structuredClone(value);
const development = (overrides: { cases?: Case[]; sliceFile?: SliceFile } = {}) =>
	checkCoverage({ inventory, removals, cases, sliceFile, mode: "development", ...overrides }).errors;
const without = (...ids: string[]) => cases.filter((testCase) => !ids.includes(testCase.id));

test("the committed corpus covers every claimed surface and classifies every inventory surface", () => {
	expect(development()).toEqual([]);
});

test("the walking skeleton claim is limited to the surfaces that it implements", () => {
	const claimed = sliceFile.slices.find((slice) => slice.id === "walking-skeleton")!;
	expect(claimed.claimed).toBe(true);
	expect(claimed.surfaces).toContain("cli:project-identity");
	expect(claimed.surfaces).toContain("rpc:createEntity");
	// Their output lists every command, so they match the TypeScript result only when all commands are ported.
	for (const notClaimed of ["cli:capabilities", "cli:help", "cli:(default)", "mcp:resource_show", "cli:auth login"]) expect(claimed.surfaces).not.toContain(notClaimed);
	const pending = new Set(sliceFile.notYetPorted.flatMap((entry) => entry.surfaces));
	for (const notClaimed of ["cli:capabilities", "cli:help", "mcp:resource_show", "cli:auth login"]) expect(pending.has(notClaimed)).toBe(true);
});

test("deleting a required case fails the check for the claimed slice", () => {
	const expectations: [string[], string][] = [
		[["cli/init-json"], "cli:init needs a --json success case"],
		[["cli/init-human"], "cli:init needs a human output case"],
		[["cli/init-help", "cli/init-command-help"], "cli:init needs a --help or help <command> case"],
		[["cli/init-unknown-option"], "cli:init needs an error case"],
		[["cli/schema-unknown-option"], "cli:schema needs an error case"],
		[["cli/project-identity-unknown-option"], "cli:project-identity needs an error case"],
		[["cli/show-not-found"], "cli:show needs an error case"],
		[["rpc/list-entities"], "rpc:listEntities needs an RPC case"],
		[["mcp/project-identity"], "mcp:project_identity needs an MCP tools/call case"],
		[["mcp/tool-list"], "mcp:tools/list needs an MCP tools/list case"]
	];
	for (const [deleted, message] of expectations) {
		const errors = development({ cases: without(...deleted) });
		expect(errors.some((error) => error.includes(message))).toBe(true);
	}
});

test("registering an uncovered surface in a claimed slice fails the check", () => {
	const claim = (surface: string) => {
		const changed = clone(sliceFile);
		changed.slices[0].surfaces.push(surface);
		for (const entry of changed.notYetPorted) entry.surfaces = entry.surfaces.filter((item) => item !== surface);
		changed.notYetPorted = changed.notYetPorted.filter((entry) => entry.surfaces.length > 0);
		return development({ sliceFile: changed });
	};
	expect(claim("cli:auth list").some((error) => error.includes("cli:auth list needs a --help or help <command> case"))).toBe(true);
	expect(claim("rpc:applyRelations")).toContain("slice walking-skeleton: rpc:applyRelations needs an RPC case");
	expect(claim("mcp:resource_show")).toContain("slice walking-skeleton: mcp:resource_show needs an MCP tools/call case");
	expect(claim("mcp-resource:ui://agent-issues/issue-preview.html")).toContain("slice walking-skeleton: mcp-resource:ui://agent-issues/issue-preview.html needs an MCP resources/read case");
	expect(claim("route:GET /api/entity-detail").some((error) => error.includes("needs a site case"))).toBe(true);
});

test("a surface in no list fails, so a surface cannot be removed silently", () => {
	const changed = clone(sliceFile);
	for (const entry of changed.notYetPorted) entry.surfaces = entry.surfaces.filter((item) => item !== "cli:auth login");
	changed.notYetPorted = changed.notYetPorted.filter((entry) => entry.surfaces.length > 0);
	expect(development({ sliceFile: changed })).toEqual(["cli:auth login is not removed, claimed by a slice, or listed as not yet ported"]);
});

test("a stale, duplicate, or contradictory entry fails", () => {
	const stale = clone(sliceFile);
	stale.notYetPorted[0].surfaces.push("cli:no-such-command");
	expect(development({ sliceFile: stale })).toContain("notYetPorted CLI family: fallback: cli:no-such-command is not a surface in the inventory");

	const duplicate = clone(sliceFile);
	duplicate.notYetPorted[0].surfaces.push("cli:project-identity");
	expect(development({ sliceFile: duplicate }).some((error) => error.startsWith("cli:project-identity is listed twice"))).toBe(true);

	const contradiction = clone(sliceFile);
	contradiction.notYetPorted[0].surfaces.push("cli:daemon");
	contradiction.slices[0].surfaces.push("cli:synchronize");
	const errors = development({ sliceFile: contradiction });
	expect(errors.some((error) => error.includes("cli:daemon is removed by daemon-command, so it is not a development exception"))).toBe(true);
	expect(errors.some((error) => error.includes("cli:synchronize is removed by synchronize-command, so it cannot be claimed"))).toBe(true);
});

test("a claimed storage test that the contract lost fails", () => {
	const source = `it(${JSON.stringify(sliceFile.slices[0].storage[0].tests[0])}, async () => {})`;
	const errors = checkCoverage({ inventory, removals, cases, sliceFile, mode: "development", contractSource: source }).errors;
	expect(errors.length).toBe(sliceFile.slices[0].storage.flatMap((claim) => (claim.tests === "all" ? [] : claim.tests)).length - 1);
	expect(errors.every((error) => error.includes("the storage-driver contract has no test titled"))).toBe(true);
});

test("the full-release mode refuses every not-yet-ported exception, unclaimed slice and partial storage claim", () => {
	const errors = checkCoverage({ inventory, removals, cases, sliceFile, mode: "release" }).errors;
	expect(errors.some((error) => error.startsWith("release mode refuses the not-yet-ported entry"))).toBe(true);
	expect(errors.filter((error) => error.startsWith("release mode refuses the not-yet-ported entry")).length).toBe(sliceFile.notYetPorted.length);
	expect(errors.some((error) => error.includes("release mode needs all tests of the storage group entity lifecycle"))).toBe(true);

	const unclaimed = clone(sliceFile);
	unclaimed.slices[0].claimed = false;
	expect(checkCoverage({ inventory, removals, cases, sliceFile: unclaimed, mode: "release" }).errors).toContain("slice walking-skeleton: release mode needs every slice to be claimed");
});

/** A small inventory that one claimed slice can cover completely. */
const tiny: CoverageInventory = {
	cli: { commands: [{ id: "cli:x", path: ["x"], requirements: { help: true, jsonSuccess: true, error: true, humanOutput: true } }], families: [] },
	rpc: { methods: [{ name: "doX" }], endpoints: [{ path: "/rpc", methods: ["POST"] }] },
	mcp: { tools: [{ name: "x_tool" }], toolList: { order: ["x_tool"] }, resources: [] },
	website: { routes: [], liveSiteRoutes: [] },
	hostRoutes: [],
	storageContract: { groups: ["g"] }
} as unknown as CoverageInventory;
const tinySlices: SliceFile = {
	slices: [{ id: "all", claimed: true, description: "Everything", surfaces: ["cli:x", "rpc:doX", "mcp:x_tool", "mcp:tools/list", "route:POST /rpc"], storage: [{ group: "g", tests: "all" }] }],
	notYetPorted: []
};
const tinyCases: Case[] = [
	{ id: "cli/x-help", surface: "cli", workspace: { folder: "w" }, argv: ["help", "x"], stdout: "text" },
	{ id: "cli/x-json", surface: "cli", workspace: { folder: "w" }, argv: ["x", "--json"], stdout: "json" },
	{ id: "cli/x-human", surface: "cli", workspace: { folder: "w" }, argv: ["x"], stdout: "text" },
	{ id: "cli/x-error", surface: "cli", workspace: { folder: "w" }, argv: ["x", "--bogus"], stdout: "text", expectExitCode: 1 },
	{ id: "rpc/do-x", surface: "rpc", steps: [{ method: "doX" }] },
	{ id: "mcp/x", surface: "mcp", workspace: { folder: "w" }, steps: [{ method: "initialize" }, { method: "tools/list" }, { method: "tools/call", params: { name: "x_tool" } }] }
];

test("a release with every surface claimed and covered passes, and loses a case only by failing", () => {
	const release = (list: Case[], slices = tinySlices) => checkCoverage({ inventory: tiny, removals: [], cases: list, sliceFile: slices, mode: "release" }).errors;
	expect(release(tinyCases)).toEqual([]);
	expect(release(tinyCases.filter((testCase) => testCase.id !== "cli/x-error"))).toEqual(["slice all: cli:x needs an error case (non-zero exit code and stderr)"]);
	expect(release(tinyCases.filter((testCase) => testCase.id !== "rpc/do-x"))).toEqual(["slice all: rpc:doX needs an RPC case"]);
	const exception: SliceFile = { ...clone(tinySlices), notYetPorted: [{ group: "late", reason: "later", surfaces: ["cli:x"] }] };
	exception.slices[0].surfaces = exception.slices[0].surfaces.filter((surface) => surface !== "cli:x");
	expect(release(tinyCases, exception)).toEqual(["release mode refuses the not-yet-ported entry late (1 surfaces)"]);
});

test("a case is classified by the command that it drives", () => {
	const index = indexCases(cases, inventory);
	expect([...index.cli.get("cli:create")!].sort()).toEqual(["error", "help", "human", "json"]);
	// `help create` is a help case of create, `help` alone is a case of the help command, and a nested command keeps its own cases.
	expect(index.cli.get("cli:help")?.has("help")).toBe(true);
	const bare = (argv: string[], expectExitCode?: number): Case => ({ id: "cli/h", surface: "cli", workspace: { folder: "w" }, argv, stdout: "text", ...(expectExitCode ? { expectExitCode } : {}) });
	expect([...indexCases([bare(["help", "--help"])], inventory).cli.get("cli:help")!]).toEqual(["help"]);
	expect([...indexCases([bare(["help"])], inventory).cli.get("cli:help")!]).toEqual(["human"]);
	expect([...indexCases([bare(["help", "--bogus"], 1)], inventory).cli.get("cli:help")!]).toEqual(["error"]);
	expect(index.cli.get("cli:auth login")).toBeUndefined();
	expect(inventorySurfaces(inventory).filter((surface) => surface.kind === "website-route").length).toBeGreaterThan(30);
});

test("a malformed slices file is rejected", () => {
	const bad = (change: (file: ReturnType<typeof clone<SliceFile>>) => void) => () => {
		const file = clone(sliceFile);
		change(file);
		validateSliceFile(file);
	};
	expect(bad((file) => (file.slices[0].claimed = "yes" as unknown as boolean))).toThrow(SliceFileError);
	expect(bad((file) => file.slices.push(clone(file.slices[0])))).toThrow(/duplicate/);
	expect(bad((file) => (file.slices[0].storage[0].remainder = ""))).toThrow(/remainder/);
	expect(bad((file) => (file.slices[0].storage[0].tests = []))).toThrow(/tests/);
	expect(bad((file) => (file.notYetPorted[0].reason = " "))).toThrow(/reason/);
	expect(bad((file) => (file.notYetPorted[0].surfaces = []))).toThrow(/surfaces/);
	expect(() => validateSliceFile({})).toThrow(SliceFileError);
});
