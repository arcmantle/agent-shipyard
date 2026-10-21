import { compare, gt, valid } from "semver";

export type InstructionKind = "agent" | "skill" | "fragment";

export function splitInstructionMarkdown(markdown: string): { frontmatter: string; body: string } {
	const frontmatter = markdown.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0] ?? "";
	return { frontmatter, body: markdown.slice(frontmatter.length) };
}

export type InstructionBundle = {
	version: string;
	items: Array<{ key: string; kind: InstructionKind; body: string }>;
};

export function normalizeInstructionBundle(bundle: InstructionBundle): InstructionBundle {
	if (!bundle || typeof bundle.version !== "string" || !bundle.version.trim() || !Array.isArray(bundle.items) || !bundle.items.length) {
		throw new Error("Invalid instruction bundle.");
	}
	const keys = new Set<string>();
	const items = bundle.items.map((item) => {
		if (!item || !["agent", "skill", "fragment"].includes(item.kind)
			|| typeof item.key !== "string" || !new RegExp(`^${item.kind}/[a-z0-9][a-z0-9._/-]*$`).test(item.key)
			|| typeof item.body !== "string" || keys.has(item.key)) {
			throw new Error("Invalid instruction item or duplicate key.");
		}
		keys.add(item.key);
		return { key: item.key, kind: item.kind, body: item.body };
	}).sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0);
	return { version: bundle.version, items };
}

export type RetrieveInstructionInput = { version: string; key: string };
export type ReadInstructionRevisionInput = RetrieveInstructionInput & { revision: number };
export type RestoreInstructionRevisionInput = ReadInstructionRevisionInput & { expectedRevision: number };
export type ResetInstructionSourceInput = RetrieveInstructionInput & { expectedRevision: number };
export type InstructionHistory = RetrieveInstructionInput & { revisions: InstructionSourceResult[] };
export type PreviewInstructionInput = RetrieveInstructionInput & { changes: Array<{ key: string; body: string }> };
export type SaveInstructionSourceInput = RetrieveInstructionInput & { body: string; expectedRevision: number };
export type CreateInstructionFragmentInput = RetrieveInstructionInput & { body: string };
export type RemoveInstructionFragmentInput = RetrieveInstructionInput & { expectedRevision: number };
export type InstructionChange =
	| { operation: "save"; key: string; body: string; expectedRevision: number }
	| { operation: "remove"; key: string; expectedRevision: number };
export type CommitInstructionChangesInput = { version: string; changes: InstructionChange[] };
export type InstructionChangesResult = {
	version: string;
	changes: Array<{ operation: "save" | "remove"; source: InstructionSourceResult }>;
};

export type InstructionSource =
	| { type: "default"; revision: number; contentHash: string }
	| { type: "personal"; revision: number; contentHash: string }
	| { type: "override"; revision: number; contentHash: string; defaultVersion: string };

export type InstructionSnapshotItem = {
	key: string;
	kind: InstructionKind;
	body: string;
	source: InstructionSource;
};

export type RetrievedInstruction = InstructionSnapshotItem & {
	version: string;
	fragments: Array<{ key: string; source: InstructionSource }>;
};
export type InstructionReleaseChanges = {
	defaultVersion: string;
	newerDefaultAvailable: boolean | null;
	defaultChanged: boolean;
	dependencies: { added: string[]; removed: string[]; changed: string[] };
};
export type InstructionManagedItem = InstructionSnapshotItem & { releaseChanges?: InstructionReleaseChanges };
export type InstructionSourceResult = InstructionManagedItem & { version: string };
export type InstructionCatalog = { version: string; items: InstructionManagedItem[] };
export type InstructionComparison = RetrieveInstructionInput & {
	currentSource: InstructionSourceResult;
	defaultSource: InstructionSourceResult | null;
	different: boolean | null;
	newerDefaultVersions: string[];
};
export type InstructionDependencyInspection = RetrieveInstructionInput & {
	source: InstructionSource;
	dependencies: Array<{ key: string; direct: boolean; source: InstructionSource | null; reason?: "missing" | "not-fragment" }>;
	affectedInstructions: string[];
	modifiedFragments: string[];
};
export type InstructionPreview = RetrievedInstruction & { pending: true; pendingKeys: string[] };
export type InstructionResetInspection = RetrieveInstructionInput & {
	currentSource: InstructionSourceResult;
	proposedSource: InstructionSourceResult;
	affectedInstructions: string[];
	modifiedFragments: string[];
};
export type ResetInstructionAllInput = {
	version: string;
	expectedRevisions: Array<{ key: string; sourceType: "override" | "personal"; expectedRevision: number }>;
};
export type InstructionOwner = { type: "local" } | { type: "cloud"; tenantId: string; userId: string };
export type InstructionResetAllInspection = {
	version: string;
	owner: InstructionOwner;
	overrides: Array<{ currentSource: InstructionSourceResult; proposedSource: InstructionSourceResult | null }>;
	personalFragments: InstructionSourceResult[];
	affectedInstructions: string[];
	expectedRevisions: ResetInstructionAllInput["expectedRevisions"];
};

export class InstructionResetAllError extends Error {
	constructor(reason: "revision-conflict" | "invalid-source", message: string, currentInspection?: InstructionResetAllInspection) {
		super(message);
		this.name = "InstructionResetAllError";
		this.reason = reason;
		this.currentInspection = currentInspection;
	}

	public readonly reason: "revision-conflict" | "invalid-source";
	public readonly currentInspection: InstructionResetAllInspection | undefined;
}

export function inspectInstructionResetAll(input: { version: string }, items: InstructionSnapshotItem[], defaults: InstructionSnapshotItem[], owner: InstructionOwner): InstructionResetAllInspection {
	try {
		validateInstructionGraph(defaults);
	} catch (error) {
		throw new InstructionResetAllError("invalid-source", error instanceof Error ? error.message : "Invalid instruction graph.");
	}
	const catalog = new Map(defaults.map((item) => [item.key, item]));
	const changed = items.filter((item) => item.source.type !== "default").sort((first, second) => first.key.localeCompare(second.key));
	const changedKeys = new Set(changed.map((item) => item.key));
	const overrides = changed.filter((item) => item.source.type === "override").map((item) => {
		const defaultItem = catalog.get(item.key);
		return {
			currentSource: { ...item, version: input.version },
			proposedSource: defaultItem ? { ...defaultItem, version: input.version, source: { ...defaultItem.source, revision: item.source.revision + 1 } } : null
		};
	});
	const affectedInstructions = [...new Set([items, defaults].flatMap((sources) => sources.filter((item) => item.kind !== "fragment"
		&& (changedKeys.has(item.key) || inspectInstructionDependencies({ ...input, key: item.key }, sources).dependencies.some((dependency) => changedKeys.has(dependency.key))))
		.map((item) => item.key)))].sort();
	return {
		version: input.version, owner, overrides,
		personalFragments: changed.filter((item) => item.source.type === "personal").map((item) => ({ ...item, version: input.version })),
		affectedInstructions,
		expectedRevisions: changed.map((item) => ({ key: item.key, sourceType: item.source.type === "personal" ? "personal" as const : "override" as const, expectedRevision: item.source.revision }))
	};
}

export function prepareInstructionResetAll(input: ResetInstructionAllInput, items: InstructionSnapshotItem[], defaults: InstructionSnapshotItem[], owner: InstructionOwner): InstructionResetAllInspection {
	const inspection = inspectInstructionResetAll(input, items, defaults, owner);
	if (!Array.isArray(input.expectedRevisions) || input.expectedRevisions.some((item) => !item || typeof item.key !== "string" || !["override", "personal"].includes(item.sourceType) || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1)
		|| new Set(input.expectedRevisions.map((item) => `${item.sourceType}:${item.key}`)).size !== input.expectedRevisions.length) throw new InstructionResetAllError("invalid-source", "Invalid Reset All revisions.", inspection);
	const expected = new Map(input.expectedRevisions.map((item) => [`${item.sourceType}:${item.key}`, item.expectedRevision]));
	if (expected.size !== inspection.expectedRevisions.length || inspection.expectedRevisions.some((item) => expected.get(`${item.sourceType}:${item.key}`) !== item.expectedRevision)) {
		throw new InstructionResetAllError("revision-conflict", "Instruction Reset All revision conflict. Inspect the complete set again before confirmation.", inspection);
	}
	return inspection;
}

export function describeInstructionReleaseChanges(version: string, items: InstructionSnapshotItem[], defaults: Array<InstructionSnapshotItem & { version: string }>): InstructionManagedItem[] {
	const releases = new Map<string, Map<string, InstructionSnapshotItem>>();
	for (const item of defaults) {
		if (!releases.has(item.version)) releases.set(item.version, new Map());
		releases.get(item.version)!.set(item.key, item);
	}
	const ownerItems = new Map(items.map((item) => [item.key, item]));
	const dependencies = (key: string, catalog: Map<string, InstructionSnapshotItem>) => {
		const result = new Map<string, string>();
		const visited = new Set<string>();
		const pending = [key];
		while (pending.length) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			const item = catalog.get(current);
			const ownerItem = ownerItems.get(current);
			for (const body of new Set([item?.body, ownerItem?.body])) {
				if (body === undefined) continue;
				for (const marker of body.matchAll(includeMarker)) {
					const personal = ownerItems.get(marker[1]);
					const fragment = catalog.get(marker[1]) ?? (personal?.source.type === "personal" ? personal : undefined);
					if (fragment?.kind !== "fragment") continue;
					result.set(fragment.key, fragment.source.contentHash);
					pending.push(fragment.key);
				}
			}
		}
		return result;
	};
	return items.map((item) => {
		if (item.source.type !== "override" || item.source.defaultVersion === version) return item;
		const original = releases.get(item.source.defaultVersion);
		const current = releases.get(version);
		if (!original?.has(item.key)) throw new Error(`Instruction default metadata unavailable for baseline release ${item.source.defaultVersion}: ${item.key}`);
		if (!current?.has(item.key)) throw new Error(`Instruction default metadata unavailable for requesting release ${version}: ${item.key}`);
		const before = dependencies(item.key, original);
		const after = dependencies(item.key, current);
		return { ...item, releaseChanges: {
			defaultVersion: version,
			newerDefaultAvailable: valid(version) && valid(item.source.defaultVersion) ? gt(version, item.source.defaultVersion) : null,
			defaultChanged: original.get(item.key)!.source.contentHash !== current.get(item.key)!.source.contentHash,
			dependencies: {
				added: [...after.keys()].filter((key) => !before.has(key)).sort(),
				removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
				changed: [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key)).sort()
			}
		} };
	});
}

export function previewInstruction(input: PreviewInstructionInput, items: InstructionSnapshotItem[]): InstructionPreview {
	if (!input || !Array.isArray(input.changes) || !input.changes.length) throw new Error("Instruction preview requires pending changes.");
	const changes = new Map<string, string>();
	for (const change of input.changes) {
		if (!change || typeof change.key !== "string" || typeof change.body !== "string" || changes.has(change.key)) throw new Error("Invalid instruction preview change or duplicate key.");
		readInstructionSource({ version: input.version, key: change.key }, items);
		changes.set(change.key, change.body);
	}
	const candidates = items.map((item) => changes.has(item.key) ? { ...item, body: changes.get(item.key)! } : item);
	return { ...assembleInstruction(input, candidates), pending: true, pendingKeys: [...changes.keys()].sort() };
}

export class InstructionWriteError extends Error {
	constructor(reason: "revision-conflict" | "invalid-source", currentSource: InstructionSourceResult, message: string) {
		super(message);
		this.name = "InstructionWriteError";
		this.reason = reason;
		this.currentSource = currentSource;
	}

	public readonly reason: "revision-conflict" | "invalid-source";
	public readonly currentSource: InstructionSourceResult;
}

export function readInstructionSource(input: RetrieveInstructionInput, items: InstructionSnapshotItem[]): InstructionSourceResult {
	const item = items.find((item) => item.key === input.key);
	if (!item) throw new Error(`Instruction not found for release ${input.version}: ${input.key}`);
	return { ...item, version: input.version };
}

export function compareInstructionSource(input: RetrieveInstructionInput, currentSource: InstructionSourceResult, defaults: InstructionSourceResult[]): InstructionComparison {
	const defaultSource = currentSource.source.type === "personal" ? null : readInstructionSource(input, defaults.filter((item) => item.version === input.version));
	const newerDefaultVersions = [...new Set(defaults.filter((item) => item.key === input.key && valid(input.version) && valid(item.version) && gt(item.version, input.version)).map((item) => item.version))].sort(compare);
	return { ...input, currentSource, defaultSource, different: defaultSource === null ? null : currentSource.body !== defaultSource.body, newerDefaultVersions };
}

export function inspectInstructionDependencies(input: RetrieveInstructionInput, items: InstructionSnapshotItem[]): InstructionDependencyInspection {
	const current = readInstructionSource(input, items);
	const catalog = new Map(items.map((item) => [item.key, item]));
	const includes = new Map(items.map((item) => [item.key, [...item.body.matchAll(includeMarker)].map((marker) => marker[1])]));
	const direct = new Set(includes.get(input.key));
	const dependencies = new Set<string>();
	const pending = [...direct];
	while (pending.length) {
		const key = pending.pop()!;
		if (dependencies.has(key)) continue;
		dependencies.add(key);
		if (key.startsWith("fragment/") && catalog.get(key)?.kind === "fragment") pending.push(...(includes.get(key) ?? []));
	}
	const affected = new Set<string>([input.key]);
	const reverse = new Map<string, string[]>();
	for (const [key, targets] of includes) {
		for (const target of targets) {
			if (!target.startsWith("fragment/") || (catalog.has(target) && catalog.get(target)!.kind !== "fragment")) continue;
			if (!reverse.has(target)) reverse.set(target, []);
			reverse.get(target)!.push(key);
		}
	}
	const ancestors = [input.key];
	while (ancestors.length) {
		for (const key of reverse.get(ancestors.pop()!) ?? []) {
			if (affected.has(key)) continue;
			affected.add(key);
			ancestors.push(key);
		}
	}
	return {
		...input, source: current.source,
		dependencies: [...dependencies].sort().map((key) => {
			const item = catalog.get(key);
			if (!key.startsWith("fragment/") || (item && item.kind !== "fragment")) return { key, direct: direct.has(key), source: null, reason: "not-fragment" as const };
			if (!item) return { key, direct: direct.has(key), source: null, reason: "missing" as const };
			return { key, direct: direct.has(key), source: item.source };
		}),
		affectedInstructions: items.filter((item) => item.key !== input.key && item.kind !== "fragment" && affected.has(item.key)).map((item) => item.key).sort(),
		modifiedFragments: items.filter((item) => item.kind === "fragment" && item.source.type !== "default" && (item.key === input.key || dependencies.has(item.key))).map((item) => item.key).sort()
	};
}

function prepareInstructionSourceChange(input: SaveInstructionSourceInput, items: InstructionSnapshotItem[], contentHash: string): InstructionSourceResult {
	const item = readInstructionSource(input, items);
	if (typeof input.body !== "string" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new InstructionWriteError("invalid-source", item, "Invalid instruction save.");
	if (item.source.revision !== input.expectedRevision) throw new InstructionWriteError("revision-conflict", item, `Instruction revision conflict: ${JSON.stringify(item)}`);
	return { ...item, body: input.body, source: item.source.type === "personal" ? {
		type: "personal" as const, revision: item.source.revision + 1, contentHash
	} : {
		type: "override" as const, revision: item.source.revision + 1, contentHash,
		defaultVersion: item.source.type === "override" ? item.source.defaultVersion : input.version
	} };
}

export function prepareInstructionSave(input: SaveInstructionSourceInput, items: InstructionSnapshotItem[], contentHash: string): InstructionSourceResult {
	const saved = prepareInstructionSourceChange(input, items, contentHash);
	try {
		validateInstructionGraph(items.map((current) => current.key === input.key ? saved : current));
	} catch (error) {
		throw new InstructionWriteError("invalid-source", readInstructionSource(input, items), error instanceof Error ? error.message : "Invalid instruction graph.");
	}
	return saved;
}

export function prepareInstructionReset(input: ResetInstructionSourceInput, items: InstructionSnapshotItem[], defaultItem: InstructionSnapshotItem): InstructionSourceResult {
	const current = readInstructionSource(input, items);
	if (current.source.type === "personal") throw new InstructionWriteError("invalid-source", current, "Personal fragments have no instruction default.");
	if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new InstructionWriteError("invalid-source", current, "Invalid instruction reset revision.");
	if (input.expectedRevision !== current.source.revision) throw new InstructionWriteError("revision-conflict", current, `Instruction revision conflict: ${JSON.stringify(current)}`);
	const reset: InstructionSourceResult = { ...defaultItem, version: input.version, source: { type: "default", revision: current.source.revision + 1, contentHash: defaultItem.source.contentHash } };
	try {
		validateInstructionGraph(items.map((item) => item.key === input.key ? reset : item));
	} catch (error) {
		throw new InstructionWriteError("invalid-source", current, error instanceof Error ? error.message : "Invalid instruction graph.");
	}
	return reset;
}

export function inspectInstructionReset(input: RetrieveInstructionInput, items: InstructionSnapshotItem[], defaultItem: InstructionSnapshotItem): InstructionResetInspection {
	const currentSource = readInstructionSource(input, items);
	const proposedSource = prepareInstructionReset({ ...input, expectedRevision: currentSource.source.revision }, items, defaultItem);
	const proposedItems = items.map((item) => item.key === input.key ? proposedSource : item);
	const currentCatalog = new Map(items.map((item) => [item.key, item]));
	const proposedCatalog = new Map(proposedItems.map((item) => [item.key, item]));
	const dependencies = (key: string, sources: Map<string, InstructionSnapshotItem>) => {
		const visited = new Set<string>();
		const pending = [key];
		while (pending.length) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			for (const marker of sources.get(current)?.body.matchAll(includeMarker) ?? []) pending.push(marker[1]);
		}
		return visited;
	};
	const affectedInstructions = items.filter((item) => item.kind !== "fragment"
		&& (dependencies(item.key, currentCatalog).has(input.key) || dependencies(item.key, proposedCatalog).has(input.key))).map((item) => item.key).sort();
	const included = new Set([input.key, ...affectedInstructions].flatMap((key) => [...dependencies(key, proposedCatalog)]));
	const modifiedFragments = proposedItems.filter((item) => item.kind === "fragment" && item.source.type !== "default" && included.has(item.key)).map((item) => item.key).sort();
	return { ...input, currentSource, proposedSource, affectedInstructions, modifiedFragments };
}

export class InstructionFragmentError extends Error {
	constructor(reason: "invalid-source" | "revision-conflict" | "referenced" | "already-exists" | "not-personal", message: string, currentSource?: InstructionSourceResult, affectedReferences: string[] = []) {
		super(message);
		this.name = "InstructionFragmentError";
		this.reason = reason;
		this.currentSource = currentSource;
		this.affectedReferences = affectedReferences;
	}

	public readonly reason: "invalid-source" | "revision-conflict" | "referenced" | "already-exists" | "not-personal";
	public readonly currentSource: InstructionSourceResult | undefined;
	public readonly affectedReferences: string[];
}

export function prepareInstructionFragmentCreate(input: CreateInstructionFragmentInput, items: InstructionSnapshotItem[], revision: number, contentHash: string): InstructionSourceResult {
	const existing = items.find((item) => item.key === input.key);
	if (existing) throw new InstructionFragmentError("already-exists", `Instruction already exists: ${input.key}`, { ...existing, version: input.version });
	const created: InstructionSourceResult = { ...input, kind: "fragment", source: { type: "personal", revision, contentHash } };
	try {
		normalizeInstructionBundle({ version: input.version, items: [created] });
		validateInstructionGraph([...items, created]);
	} catch (error) {
		throw new InstructionFragmentError("invalid-source", error instanceof Error ? error.message : "Invalid instruction fragment.");
	}
	return created;
}

function prepareInstructionFragmentRemovalSource(input: RemoveInstructionFragmentInput, items: InstructionSnapshotItem[]): InstructionSourceResult {
	const item = readInstructionSource(input, items);
	if (item.kind !== "fragment" || item.source.type !== "personal") throw new InstructionFragmentError("not-personal", `Only personal fragments can be removed: ${input.key}`, item);
	if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new InstructionFragmentError("invalid-source", "Invalid fragment removal revision.", item);
	if (item.source.revision !== input.expectedRevision) throw new InstructionFragmentError("revision-conflict", `Instruction revision conflict: ${input.key}`, item);
	return { ...item, source: { ...item.source, revision: item.source.revision + 1 } };
}

export function prepareInstructionFragmentRemove(input: RemoveInstructionFragmentInput, items: InstructionSnapshotItem[], savedReferences: Array<Pick<InstructionSnapshotItem, "key" | "body">> = items): InstructionSourceResult {
	const removed = prepareInstructionFragmentRemovalSource(input, items);
	validateInstructionRemovalReferences(readInstructionSource(input, items), savedReferences);
	validateInstructionGraph(items.filter((current) => current.key !== input.key));
	return removed;
}

function validateInstructionRemovalReferences(source: InstructionSourceResult, references: Array<Pick<InstructionSnapshotItem, "key" | "body">>): void {
	const affectedReferences = [...new Set(references.filter((item) => [...item.body.matchAll(includeMarker)].some((marker) => marker[1] === source.key)).map((item) => item.key))].sort();
	if (affectedReferences.length) throw new InstructionFragmentError("referenced", `Instruction fragment is referenced by: ${affectedReferences.join(", ")}`, source, affectedReferences);
}

export function prepareInstructionChanges(input: CommitInstructionChangesInput, items: InstructionSnapshotItem[], hash: (body: string) => string, savedReferences: Array<Pick<InstructionSnapshotItem, "key" | "body">> = items): InstructionChangesResult {
	if (!input || typeof input.version !== "string" || !Array.isArray(input.changes) || !input.changes.length) throw new Error("Invalid instruction changes.");
	const keys = new Set<string>();
	const changes = input.changes.map((change) => {
		if (!change || typeof change.key !== "string" || !["save", "remove"].includes(change.operation) || keys.has(change.key)) throw new Error("Invalid instruction change or duplicate key.");
		keys.add(change.key);
		const source = change.operation === "save"
			? prepareInstructionSourceChange({ ...change, version: input.version }, items, hash(typeof change.body === "string" ? change.body : ""))
			: prepareInstructionFragmentRemovalSource({ ...change, version: input.version }, items);
		return { operation: change.operation, source };
	});
	const changed = new Map(changes.map((change) => [change.source.key, change]));
	const finalItems = items.flatMap((item) => {
		const change = changed.get(item.key);
		return change?.operation === "remove" ? [] : [change?.source ?? item];
	});
	const finalReferences = [...finalItems, ...savedReferences.flatMap((item) => {
		const change = changed.get(item.key);
		return change?.operation === "remove" ? [] : [change?.source ?? item];
	})];
	for (const change of changes) {
		if (change.operation !== "remove") continue;
		validateInstructionRemovalReferences(readInstructionSource({ version: input.version, key: change.source.key }, items), finalReferences);
	}
	try {
		validateInstructionGraph(finalItems);
	} catch (error) {
		throw new InstructionWriteError("invalid-source", readInstructionSource({ version: input.version, key: changes[0].source.key }, items), error instanceof Error ? error.message : "Invalid instruction graph.");
	}
	return { version: input.version, changes };
}

const includeMarker = /<!--\s*include:([^\s]+)\s*-->/g;

export function validateInstructionGraph(items: InstructionSnapshotItem[]): void {
	const catalog = new Map(items.map((item) => [item.key, item]));
	const active = new Set<string>();
	const validated = new Set<string>();
	for (const item of items) {
		if (validated.has(item.key)) continue;
		active.add(item.key);
		const stack = [{ item, markers: item.body.matchAll(includeMarker) }];
		while (stack.length) {
			const frame = stack[stack.length - 1];
			const marker = frame.markers.next();
			if (marker.done) {
				active.delete(frame.item.key);
				validated.add(frame.item.key);
				stack.pop();
				continue;
			}
			const key = marker.value[1];
			if (!key.startsWith("fragment/")) throw new Error(`Instruction includes must target a fragment: ${key}`);
			const fragment = catalog.get(key);
			if (!fragment) throw new Error(`Instruction fragment not found: ${key}`);
			if (fragment.kind !== "fragment") throw new Error(`Instruction includes must target a fragment: ${key}`);
			if (active.has(key)) throw new Error(`Instruction fragment cycle: ${[...active, key].join(" -> ")}`);
			if (validated.has(key)) continue;
			active.add(key);
			stack.push({ item: fragment, markers: fragment.body.matchAll(includeMarker) });
		}
	}
}

export function assembleInstruction(input: RetrieveInstructionInput, items: InstructionSnapshotItem[]): RetrievedInstruction {
	const catalog = new Map(items.map((item) => [item.key, item]));
	const item = catalog.get(input.key);
	if (!item) throw new Error(`Instruction not found for release ${input.version}: ${input.key}`);
	validateInstructionGraph(items);
	const fragments = new Map<string, InstructionSource>();
	const chunks: string[] = [];
	const stack = [{ item, markers: item.body.matchAll(includeMarker), offset: 0 }];
	while (stack.length) {
		const frame = stack[stack.length - 1];
		const marker = frame.markers.next();
		if (marker.done) {
			chunks.push(frame.item.body.slice(frame.offset));
			stack.pop();
			continue;
		}
		chunks.push(frame.item.body.slice(frame.offset, marker.value.index));
		frame.offset = marker.value.index + marker.value[0].length;
		const key = marker.value[1];
		const fragment = catalog.get(key)!;
		fragments.set(key, fragment.source);
		stack.push({ item: fragment, markers: fragment.body.matchAll(includeMarker), offset: 0 });
	}
	return { ...item, body: chunks.join(""), version: input.version, fragments: [...fragments].map(([key, source]) => ({ key, source })) };
}

export interface InstructionStore {
	retrieveInstruction(input: RetrieveInstructionInput): Promise<RetrievedInstruction>;
	previewInstruction(input: PreviewInstructionInput): Promise<InstructionPreview>;
	listInstructionSources(input: { version: string }): Promise<InstructionCatalog>;
	readInstructionSource(input: RetrieveInstructionInput): Promise<InstructionSourceResult>;
	compareInstructionSource(input: RetrieveInstructionInput): Promise<InstructionComparison>;
	inspectInstructionDependencies(input: RetrieveInstructionInput): Promise<InstructionDependencyInspection>;
	listInstructionHistory(input: RetrieveInstructionInput): Promise<InstructionHistory>;
	readInstructionRevision(input: ReadInstructionRevisionInput): Promise<InstructionSourceResult>;
	restoreInstructionRevision(input: RestoreInstructionRevisionInput): Promise<InstructionSourceResult>;
	resetInstructionSource(input: ResetInstructionSourceInput): Promise<InstructionSourceResult>;
	inspectInstructionReset(input: RetrieveInstructionInput): Promise<InstructionResetInspection>;
	inspectInstructionResetAll(input: { version: string }): Promise<InstructionResetAllInspection>;
	resetInstructionAll(input: ResetInstructionAllInput): Promise<InstructionResetAllInspection>;
	saveInstructionSource(input: SaveInstructionSourceInput): Promise<InstructionSourceResult>;
	commitInstructionChanges(input: CommitInstructionChangesInput): Promise<InstructionChangesResult>;
	createInstructionFragment(input: CreateInstructionFragmentInput): Promise<InstructionSourceResult>;
	removeInstructionFragment(input: RemoveInstructionFragmentInput): Promise<InstructionSourceResult>;
}