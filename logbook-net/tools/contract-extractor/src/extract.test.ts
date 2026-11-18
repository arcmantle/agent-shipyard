import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildInventory, findRepoRoot, serializeInventory } from "./extract.ts";
import { scanContractGroups, scanExpressRoutes, scanInterfaceMethods, scanMcpResources, scanMcpTools, scanPathnameRoutes, scanStringSet } from "./scanners.ts";

const root = findRepoRoot(import.meta.dir);
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("scanners detect a deliberate registration change", () => {
	const mcp = source("logbook/packages/cli/src/mcp-server/index.ts");
	const siteRoutes = source("logbook/packages/core/src/site/site-routes.ts");

	test("a new MCP tool appears", () => {
		const before = scanMcpTools(mcp).map((tool) => tool.name);
		const after = scanMcpTools(`${mcp}\nserver.registerTool(\n"added_tool",\n{ annotations: { readOnlyHint: true } },\nasync () => ({}));`);
		expect(after.map((tool) => tool.name)).toEqual([...before, "added_tool"]);
		expect(after.at(-1)?.readOnly).toBe(true);
	});

	test("a new website route appears with its method", () => {
		const before = scanPathnameRoutes(siteRoutes).map((route) => route.path);
		const changed = siteRoutes.replace("\tif (requestUrl.pathname === \"/api/snapshot\") {", "\tif (requestUrl.pathname === \"/api/added\") {\n\t\treturn;\n\t}\n\n\tif (requestUrl.pathname === \"/api/snapshot\") {");
		const route = scanPathnameRoutes(changed).find((item) => item.path === "/api/added");
		expect(before).not.toContain("/api/added");
		expect(route).toEqual({ path: "/api/added", methods: ["GET"] });
	});

	test("a removed route disappears", () => {
		const changed = siteRoutes.replace("requestUrl.pathname === \"/api/project-debt\"", "requestUrl.pathname === \"/api/project-debt-renamed\"");
		const paths = scanPathnameRoutes(changed).map((route) => route.path);
		expect(paths).toContain("/api/project-debt-renamed");
		expect(paths).not.toContain("/api/project-debt");
	});

	test("a registration the scanners cannot read fails instead of being omitted", () => {
		expect(() => scanMcpTools(`${mcp}\nserver.registerTool(name, {}, async () => ({}));`)).toThrow();
		expect(() => scanPathnameRoutes(`${siteRoutes}\n\tif (requestUrl.pathname.startsWith("/api/x")) {\n\t}`)).toThrow();
		expect(() => scanPathnameRoutes(`${siteRoutes}\n\tif (requestUrl.pathname === route) {\n\t}`)).toThrow();
	});

	test("a new Express route appears", () => {
		const changed = `${source("logbook/packages/api-pg/src/index.ts")}\napp.post("/added", () => {});`;
		expect(scanExpressRoutes(changed)).toContainEqual({ path: "/added", methods: ["POST"] });
	});

	test("an interface method and a UI resource appear", () => {
		expect(scanInterfaceMethods("export interface Store {\n\treadonly tenantId: string;\n\tlistThings(): Promise<void>;\n\tmakeThing<T>(input: T): Promise<void>;\n}\n")).toEqual(["listThings", "makeThing"]);
		expect(scanMcpResources("const URI = \"ui://x/y.html\";\nregisterAppResource(\n\tserver,\n\t\"Y\",\n\tURI,\n\t{},\n\tasync () => ({})\n);")).toEqual([{ name: "Y", uri: "ui://x/y.html" }]);
	});

	test("contract groups and string sets are read from source", () => {
		expect(scanContractGroups("describe(`storage-driver seam: Search (${label})`, () => {});")).toEqual(["Search"]);
		expect(scanStringSet("const A = new Set([\n\t\"b\",\n\t\"a\"\n]);", "A")).toEqual(["a", "b"]);
	});
});

describe("inventory of the current registrations", async () => {
	const first = await buildInventory(root);
	const second = await buildInventory(root);

	test("repeated extraction from unchanged source gives equal data", () => {
		expect(serializeInventory(second)).toBe(serializeInventory(first));
	});

	test("the committed inventory is current", () => {
		expect(readFileSync(path.join(root, "logbook-net/contract/inventory.json"), "utf8")).toBe(serializeInventory(first));
	});

	test("each CLI path carries help, error, JSON and human requirements", () => {
		for (const command of first.cli.commands) {
			expect(command.requirements.help).toBe(true);
			expect(command.requirements.error).toBe(true);
			expect(command.requirements.jsonSuccess).toBe(command.options.some((option) => option.names.includes("--json")));
		}
		expect(first.cli.commands.find((command) => command.id === "cli:comment add")?.options.length).toBeGreaterThan(0);
	});

	test("the inventory reconciles with the capabilities command list", () => {
		const help = (first.capabilities as { help: { commands: { name: string }[] } }).help;
		const documented = new Set(help.commands.map((command) => command.name));
		expect(first.cli.commands.filter((command) => command.inCapabilities).length).toBeGreaterThanOrEqual(documented.size);
		// Registered but not listed by `capabilities`: the inventory still requires cases for them.
		expect(first.cli.commands.filter((command) => !command.inCapabilities).map((command) => command.id)).toEqual(["cli:(default)", "cli:cloud migrate", "cli:daemon", "cli:kanban", "cli:synchronize"]);
	});

	test("every RPC method has an owner and every write method has a handler", () => {
		expect(first.rpc.methods.length).toBeGreaterThan(80);
		for (const method of first.rpc.methods) expect(method.owner).not.toBe("unowned");
		expect(first.hostRoutes.map((route) => route.path)).toContain("/daemon/stop");
		expect(first.rpc.endpoints.map((route) => route.path)).toEqual(["/events", "/rpc"]);
	});

	test("MCP tools, the tool list, both UI resources and the website routes are present", () => {
		expect(first.mcp.toolList.order.length).toBe(first.mcp.tools.length);
		expect(first.mcp.resources.map((resource) => resource.uri)).toEqual(["ui://agent-issues/issue-preview.html", "ui://agent-issues/plan-preview.html"]);
		expect(first.mcp.tools.filter((tool) => tool.uiResourceUri).map((tool) => tool.uiResourceUri).sort()).toEqual(first.mcp.resources.map((resource) => resource.uri));
		const paths = first.website.routes.map((route) => route.path);
		for (const expected of ["/api/snapshot", "/events", "/site-config.json", "/api/project-mutation"]) expect(paths).toContain(expected);
		expect(first.website.routes.find((route) => route.path === "/api/instructions/reset/inspect")?.methods).toEqual(["GET"]);
		expect(first.website.routes.find((route) => route.path === "/api/instructions/reset")?.methods).toEqual(["POST"]);
	});
});
