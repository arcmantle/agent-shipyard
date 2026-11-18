// Pure source scanners for registrations that exist only as code, not as data.
// Each scanner takes source text and returns sorted, location-free records, so
// that repeated extraction from unchanged source gives equal output.

export type McpTool = {
	name: string;
	registration: "registerTool" | "registerAppTool";
	readOnly: boolean;
	uiResourceUri: string | null;
};

export type McpResource = { name: string; uri: string };

export type HttpRoute = { path: string; methods: string[] };

export type RpcOwner = { method: string; owner: string };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function scanStringConstants(text: string): Map<string, string> {
	const constants = new Map<string, string>();
	for (const match of text.matchAll(/^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"\n]*)"\s*;?\s*$/gm)) {
		constants.set(match[1]!, match[2]!);
	}
	return constants;
}

/** MCP tools registered through `registerTool` and `registerAppTool`, in registration order. */
export function scanMcpTools(text: string): McpTool[] {
	const constants = scanStringConstants(text);
	const starts = [...text.matchAll(/\b(registerTool|registerAppTool)\(\s*(?:server\s*,\s*)?"([^"]+)"/g)];
	return starts.map((match, index) => {
		const end = starts[index + 1]?.index ?? text.length;
		const block = text.slice(match.index, end);
		const resource = /resourceUri:\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]*")/.exec(block)?.[1];
		const uiResourceUri = resource === undefined ? null : resource.startsWith("\"") ? resource.slice(1, -1) : (constants.get(resource) ?? null);
		return {
			name: match[2]!,
			registration: match[1] as McpTool["registration"],
			readOnly: /readOnlyHint:\s*true/.test(block),
			uiResourceUri
		};
	});
}

/** MCP UI resources registered through `registerAppResource(server, name, uri, ...)`. */
export function scanMcpResources(text: string): McpResource[] {
	const constants = scanStringConstants(text);
	const found: McpResource[] = [];
	for (const match of text.matchAll(/\bregisterAppResource\(\s*server\s*,\s*"([^"]+)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*|"[^"]*")/g)) {
		const raw = match[2]!;
		const uri = raw.startsWith("\"") ? raw.slice(1, -1) : constants.get(raw);
		found.push({ name: match[1]!, uri: uri ?? `unresolved:${raw}` });
	}
	return found.sort((a, b) => compare(a.uri, b.uri));
}

const METHOD_PATTERN = /"(GET|POST|PUT|PATCH|DELETE)"/g;

/**
 * Routes of a Node `http` handler that branches on `requestUrl.pathname`.
 * Paths come from `pathname === "/x"`, `pathname === NAME` and
 * `["/a", "/b"].includes(requestUrl.pathname)`. Methods come from `request.method`
 * comparisons in the same top-level statement; a top-level
 * `request.method !== "GET"` gate applies to every later statement.
 */
export function scanPathnameRoutes(text: string, externalConstants: ReadonlyMap<string, string> = new Map()): HttpRoute[] {
	const constants = new Map([...externalConstants, ...scanStringConstants(text)]);
	const lines = text.split("\n");
	const chunks: string[] = [];
	for (const line of lines) {
		if (/^\t(?:if|const|let|await|try)\b/.test(line) || chunks.length === 0) chunks.push(line);
		else chunks[chunks.length - 1] += `\n${line}`;
	}

	const routes = new Map<string, Set<string>>();
	let gate: string | undefined;
	for (const chunk of chunks) {
		const paths = new Set<string>();
		for (const match of chunk.matchAll(/pathname\s*===\s*("[^"]+"|[A-Z_][A-Z0-9_]*)/g)) {
			const raw = match[1]!;
			const path = raw.startsWith("\"") ? raw.slice(1, -1) : constants.get(raw);
			if (path?.startsWith("/")) paths.add(path);
		}
		for (const match of chunk.matchAll(/\[((?:\s*"\/[^"]*"\s*,?)+)\]\s*\.includes\(\s*requestUrl\.pathname\s*\)/g)) {
			for (const literal of match[1]!.matchAll(/"([^"]+)"/g)) paths.add(literal[1]!);
		}

		const methods = new Set<string>();
		for (const line of chunk.split("\n")) {
			if (!line.includes("request.method")) continue;
			for (const method of line.matchAll(METHOD_PATTERN)) methods.add(method[1]!);
		}
		if (/^\tif \(request\.method !== "GET"\) \{/.test(chunk)) gate = "GET";

		// `request.method !== (inspecting ? "GET" : "POST")`: the `/inspect` path reads, the other path writes.
		const inspectSplit = /\(\s*\w+\s*\?\s*"(GET|POST)"\s*:\s*"(GET|POST)"\s*\)/.exec(chunk);

		for (const path of paths) {
			const set = routes.get(path) ?? new Set<string>();
			const chosen = inspectSplit && methods.size === 2 ? [path.endsWith("/inspect") ? inspectSplit[1]! : inspectSplit[2]!] : methods.size > 0 ? [...methods] : gate ? [gate] : [];
			for (const method of chosen) set.add(method);
			routes.set(path, set);
		}
	}

	return [...routes]
		.map(([path, methods]) => ({ path, methods: [...methods].sort(compare) }))
		.sort((a, b) => compare(a.path, b.path));
}

/** Routes of an Express app registered as `app.get("/x", ...)`. */
export function scanExpressRoutes(text: string): HttpRoute[] {
	const routes = new Map<string, Set<string>>();
	for (const match of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g)) {
		const set = routes.get(match[2]!) ?? new Set<string>();
		set.add(match[1]!.toUpperCase());
		routes.set(match[2]!, set);
	}
	return [...routes]
		.map(([path, methods]) => ({ path, methods: [...methods].sort(compare) }))
		.sort((a, b) => compare(a.path, b.path));
}

/** Members of a `new Set<string>([...])` initializer, for example `PROJECT_MUTATION_METHODS`. */
export function scanStringSet(text: string, name: string): string[] {
	const match = new RegExp(`const\\s+${name}\\s*=\\s*new Set(?:<string>)?\\(\\[([\\s\\S]*?)\\]\\)`).exec(text);
	if (!match) return [];
	return [...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!).sort(compare);
}

/** Method names declared by every interface in a store source file. */
export function scanInterfaceMethods(text: string): string[] {
	const names = new Set<string>();
	for (const body of text.matchAll(/export interface [A-Za-z0-9_]+(?:<[^>]*>)?(?:\s+extends [^{]+)?\s*\{([\s\S]*?)\n\}/g)) {
		for (const member of body[1]!.matchAll(/^\t(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/gm)) names.add(member[1]!);
	}
	return [...names].sort(compare);
}

/** Group labels of the storage-driver contract suite, from its `describe` titles. */
export function scanContractGroups(text: string): string[] {
	const groups = new Set<string>();
	for (const match of text.matchAll(/describe\(\s*`storage-driver seam:\s*([^`$]*?)\s*\(\$\{label\}\)`/g)) groups.add(match[1]!);
	return [...groups].sort(compare);
}
