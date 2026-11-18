import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	scanContractGroups,
	scanExpressRoutes,
	scanInterfaceMethods,
	scanMcpResources,
	scanMcpTools,
	scanPathnameRoutes,
	scanStringConstants,
	scanStringSet,
	type HttpRoute
} from "./scanners.ts";

export const INVENTORY_VERSION = 1;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One representative argv for each command family registered by `command-loader.ts`. */
const FAMILY_ARGV: Readonly<Record<string, readonly string[]>> = {
	auth: ["auth"],
	backfill: ["backfill-bodies"],
	cloud: ["cloud"],
	comments: ["comment"],
	context: ["context"],
	daemon: ["daemon"],
	entities: ["create"],
	export: ["export"],
	fallback: ["fallback"],
	"issue-breakdowns": ["issue-breakdown"],
	instructions: ["instruction"],
	kanban: ["kanban"],
	meta: ["help"],
	"plan-entries": ["plan-entry"],
	plugin: ["agent"],
	site: ["site"],
	sql: ["sql"],
	synchronize: ["synchronize"],
	tenants: ["init"]
};

export type CliOption = { property: string; names: string[]; arity: number; required: boolean; allowBinding: boolean };
export type CliPositional = { property: string; name: string; required: boolean };

export type CliCommandItem = {
	id: string;
	path: string[];
	class: string;
	family: string;
	source: string;
	options: CliOption[];
	positionals: CliPositional[];
	rest: string | null;
	/** True when the `capabilities` help payload lists this path; false means the path is registered but undocumented there. */
	inCapabilities: boolean;
	requirements: { help: true; jsonSuccess: boolean; error: true; humanOutput: boolean };
};

export type Inventory = {
	inventoryVersion: number;
	cli: { commands: CliCommandItem[]; families: string[] };
	capabilities: unknown;
	rpc: { methods: { name: string; write: boolean; owner: string }[]; endpoints: HttpRoute[] };
	mcp: {
		toolList: { order: string[] };
		tools: { name: string; registration: string; readOnly: boolean; uiResourceUri: string | null }[];
		resources: { name: string; uri: string }[];
	};
	website: { routes: HttpRoute[]; projectMutationMethods: string[]; liveSiteRoutes: HttpRoute[] };
	hostRoutes: HttpRoute[];
	storageContract: { groups: string[] };
};

export class InventoryError extends Error {}

export function findRepoRoot(from: string): string {
	let current = path.resolve(from);
	while (!existsSync(path.join(current, "logbook", "packages", "cli", "package.json"))) {
		const parent = path.dirname(current);
		if (parent === current) throw new InventoryError(`No agent-issues checkout above ${from}.`);
		current = parent;
	}
	return current;
}

function read(root: string, relative: string): string {
	return readFileSync(path.join(root, relative), "utf8");
}

function listFiles(root: string, relativeDirectory: string, suffix: string): string[] {
	return readdirSync(path.join(root, relativeDirectory)).filter((file) => file.endsWith(suffix)).sort(compare).map((file) => `${relativeDirectory}/${file}`);
}

type Registration = { specs: Map<string, { definition: (builder: object, key: string) => void }> };
type CommandClass = { name: string; paths?: string[][] };

async function importFrom<T>(root: string, relative: string): Promise<T> {
	return await import(pathToFileURL(path.join(root, relative)).href) as T;
}

async function extractCli(root: string): Promise<Inventory["cli"] & { capabilities: unknown }> {
	const cliPackage = path.join(root, "logbook/packages/cli");
	const clipanion = await import(Bun.resolveSync("clipanion", cliPackage)) as { Cli: new (options: object) => { register(command: unknown): void; registrations: Map<CommandClass, Registration> } };
	const { registerCommandFamily } = await importFrom<{ registerCommandFamily(cli: unknown, argv: readonly string[]): Promise<void> }>(root, "logbook/packages/cli/src/cli/command-loader.ts");
	const { getCapabilitiesPayload } = await importFrom<{ getCapabilitiesPayload(): unknown }>(root, "logbook/packages/cli/src/cli/help.ts");

	// A family added to the router must also be mapped here; fail instead of omitting it.
	const routerFamilies = [...read(root, "logbook/packages/cli/src/cli/command-router.ts").matchAll(/^\t\| "([^"]+)"/gm)].map((match) => match[1]!).sort(compare);
	const mappedFamilies = Object.keys(FAMILY_ARGV).sort(compare);
	if (routerFamilies.join() !== mappedFamilies.join()) {
		throw new InventoryError(`Command families changed. Router: ${routerFamilies.join(", ")}. Extractor: ${mappedFamilies.join(", ")}.`);
	}

	const commandSources = new Map<string, { file: string; text: string }>();
	for (const file of listFiles(root, "logbook/packages/cli/src/cli/commands", ".ts")) {
		if (file.endsWith(".test.ts")) continue;
		const text = read(root, file);
		for (const match of text.matchAll(/^export class ([A-Za-z0-9_]+)/gm)) commandSources.set(match[1]!, { file, text });
	}

	const commands: CliCommandItem[] = [];
	for (const [family, argv] of Object.entries(FAMILY_ARGV)) {
		const cli = new clipanion.Cli({ binaryName: "agent-issues" });
		await registerCommandFamily(cli, argv);
		for (const [commandClass, registration] of cli.registrations) {
			const source = commandSources.get(commandClass.name);
			if (!source) throw new InventoryError(`No source file found for command class ${commandClass.name}.`);
			const options: CliOption[] = [];
			const positionals: CliPositional[] = [];
			let rest: string | null = null;
			for (const [property, spec] of registration.specs) {
				spec.definition({
					addOption: (option: { names: string[]; arity?: number; required?: boolean; allowBinding?: boolean }) => {
						options.push({ property, names: [...option.names].sort(compare), arity: option.arity ?? 0, required: option.required ?? false, allowBinding: option.allowBinding ?? true });
					},
					addPositional: (positional: { name?: string; required?: boolean }) => {
						positionals.push({ property, name: positional.name ?? property, required: positional.required ?? true });
					},
					addRest: () => {
						rest = property;
					},
					addProxy: () => {
						rest = property;
					}
				}, property);
			}
			options.sort((a, b) => compare(a.names[0]!, b.names[0]!));

			const classBody = source.text.slice(source.text.indexOf(`export class ${commandClass.name}`)).split(/\nexport class /)[0]!;
			const acceptsJson = options.some((option) => option.names.includes("--json"));
			const writesText = /this\.print\(|stdout\.write\(|printOutput\(/.test(classBody);
			const paths = commandClass.paths?.length ? commandClass.paths : [[]];
			for (const commandPath of paths) {
				commands.push({
					id: `cli:${commandPath.join(" ") || "(default)"}`,
					path: commandPath,
					class: commandClass.name,
					family,
					source: source.file,
					options,
					positionals,
					rest,
					inCapabilities: false,
					requirements: { help: true, jsonSuccess: acceptsJson, error: true, humanOutput: acceptsJson || writesText }
				});
			}
		}
	}

	const ids = commands.map((command) => command.id);
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
	if (duplicates.length > 0) throw new InventoryError(`Command path registered twice: ${[...new Set(duplicates)].join(", ")}.`);
	commands.sort((a, b) => compare(a.id, b.id));

	const capabilities = getCapabilitiesPayload() as { help: { commands: { name: string }[] } };
	const documented = capabilities.help.commands.map((command) => command.name);
	for (const command of commands) {
		const joined = command.path.join(" ");
		command.inCapabilities = documented.some((name) => joined === name || joined.startsWith(`${name} `));
	}
	const unregistered = documented.filter((name) => !commands.some((command) => command.path.join(" ") === name || command.path.join(" ").startsWith(`${name} `)));
	if (unregistered.length > 0) throw new InventoryError(`Capabilities lists commands that are not registered: ${unregistered.join(", ")}.`);

	return { commands, families: mappedFamilies, capabilities };
}

function ownersByMethod(root: string): Map<string, string> {
	const owners = new Map<string, string>();
	for (const file of listFiles(root, "logbook/packages/core/src/features/storage-driver", ".ts")) {
		if (file.endsWith(".test.ts") || file.endsWith("storage-driver-contract.ts")) continue;
		const owner = path.basename(file, ".ts");
		for (const method of scanInterfaceMethods(read(root, file))) {
			// The first declaring file in name order wins; storage-driver.ts only holds shared methods.
			if (!owners.has(method)) owners.set(method, owner);
		}
	}
	return owners;
}

async function extractRpc(root: string): Promise<Inventory["rpc"]> {
	const { rpcMethods, writeMethods } = await importFrom<{ rpcMethods: Record<string, unknown>; writeMethods: Set<string> }>(root, "logbook/packages/core/src/rpc/rpc-methods.ts");
	const owners = ownersByMethod(root);
	const methods = Object.keys(rpcMethods).sort(compare).map((name) => ({ name, write: writeMethods.has(name), owner: owners.get(name) ?? "unowned" }));
	const unknownWrites = [...writeMethods].filter((name) => !(name in rpcMethods));
	if (unknownWrites.length > 0) throw new InventoryError(`Write methods without a handler: ${unknownWrites.join(", ")}.`);
	return { methods, endpoints: scanExpressRoutes(read(root, "logbook/packages/core/src/rpc/create-json-rpc-app.ts")) };
}

function extractMcp(root: string): Inventory["mcp"] {
	const text = read(root, "logbook/packages/cli/src/mcp-server/index.ts");
	const tools = scanMcpTools(text);
	const order = tools.map((tool) => tool.name);
	const duplicates = order.filter((name, index) => order.indexOf(name) !== index);
	if (duplicates.length > 0) throw new InventoryError(`MCP tool registered twice: ${[...new Set(duplicates)].join(", ")}.`);
	return {
		toolList: { order },
		tools: tools.map(({ name, registration, readOnly, uiResourceUri }) => ({ name, registration, readOnly, uiResourceUri })).sort((a, b) => compare(a.name, b.name)),
		resources: scanMcpResources(text)
	};
}

function extractWebsite(root: string): Inventory["website"] {
	const siteRoutes = read(root, "logbook/packages/core/src/site/site-routes.ts");
	const liveServer = read(root, "logbook/packages/cli/src/site/server.ts");
	return {
		routes: scanPathnameRoutes(siteRoutes),
		projectMutationMethods: scanStringSet(siteRoutes, "PROJECT_MUTATION_METHODS"),
		liveSiteRoutes: scanPathnameRoutes(liveServer, scanStringConstants(liveServer))
	};
}

export async function buildInventory(root: string): Promise<Inventory> {
	const { capabilities, ...cli } = await extractCli(root);
	return {
		inventoryVersion: INVENTORY_VERSION,
		cli,
		capabilities,
		rpc: await extractRpc(root),
		mcp: extractMcp(root),
		website: extractWebsite(root),
		hostRoutes: scanExpressRoutes(read(root, "logbook/packages/api-pg/src/index.ts")),
		storageContract: { groups: scanContractGroups(read(root, "logbook/packages/core/src/features/storage-driver/storage-driver-contract.ts")) }
	};
}

export function serializeInventory(inventory: Inventory): string {
	return `${JSON.stringify(inventory, null, "\t")}\n`;
}
