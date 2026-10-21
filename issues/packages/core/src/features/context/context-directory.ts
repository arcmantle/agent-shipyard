import Fuse from "fuse.js";

import type {
	ContextDetails,
	ContextDirectory,
	ContextDirectoryTerm,
	ContextDirectoryTermSource,
	ContextDirectoryView,
	QueryContextDirectoryInput,
	QueryContextDirectoryResult
} from "./context-types.js";

/**
 * Merges a tenant's shared context plus every initiative's context into one
 * `ContextDirectory` (ADR13's dialect-agnostic boundary): both concrete
 * stores fetch `ContextDetails` their own way (SQL vs sqlite queries), then
 * hand the results here so the merge/de-dupe/conflict-detection logic - pure
 * `ContextDetails[]` shape-crunching, no persistence involved - is written
 * and tested exactly once.
 */
export function mergeContextDirectory(shared: ContextDetails, initiatives: ContextDetails[]): ContextDirectory {
	const termsByKey = new Map<string, ContextDirectoryTerm>();

	for (const details of [shared, ...initiatives]) {
		for (const term of details.terms) {
			const key = term.term.toLowerCase();
			const existing = termsByKey.get(key);
			const source: ContextDirectoryTermSource = {
				avoid: [...term.avoid],
				contextKey: details.context.key,
				contextTitle: details.context.title,
				definition: term.definition,
				scopeEntityId: details.context.scopeEntityId,
				scopeKind: details.context.scopeKind,
				scopeLabel: details.context.scopeLabel,
				updatedAt: term.updatedAt
			};

			if (!existing) {
				termsByKey.set(key, {
					term: term.term,
					sources: [source],
					hasSharedSource: isSharedContextScope(details.context.scopeKind),
					hasDuplicates: false,
					hasConflictingDefinitions: false
				});
				continue;
			}

			existing.sources.push(source);
			existing.hasDuplicates = existing.sources.length > 1;
			existing.hasSharedSource = existing.hasSharedSource || isSharedContextScope(details.context.scopeKind);
			existing.hasConflictingDefinitions = hasConflictingDefinitions(existing.sources);
			if (term.term.localeCompare(existing.term) < 0) {
				existing.term = term.term;
			}
		}
	}

	const terms = [...termsByKey.values()]
		.map((entry) => ({ ...entry, sources: entry.sources.sort(compareContextDirectorySources) }))
		.sort((left, right) => left.term.localeCompare(right.term));

	return {
		shared,
		initiatives,
		terms,
		duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term)
	};
}

/**
 * Filters an already-merged `ContextDirectory` down to `input`'s
 * query/view/conflictsOnly - the other half of the dialect-agnostic
 * boundary alongside `mergeContextDirectory`. Both concrete stores build the
 * directory their own way, then delegate this identical filter/search logic
 * to a single shared implementation.
 */
export function filterContextDirectory(directory: ContextDirectory, input: QueryContextDirectoryInput = {}): QueryContextDirectoryResult {
	const view = input.view ?? "all";
	const query = input.query?.trim() ?? "";
	const conflictsOnly = input.conflictsOnly ?? false;
	const normalizedQuery = query.toLowerCase();

	const shared = view === "initiatives" ? null : filterContextDetails(directory.shared, normalizedQuery);
	const initiatives =
		view === "global"
			? []
			: directory.initiatives
					.map((details) => filterContextDetails(details, normalizedQuery))
					.filter((details): details is ContextDetails => details !== null);

	let terms = directory.terms
		.map((entry) => filterContextDirectoryTerm(entry, normalizedQuery, view))
		.filter((entry): entry is ContextDirectoryTerm => entry !== null);

	if (conflictsOnly) {
		terms = terms.filter((entry) => entry.hasDuplicates);
	}

	return {
		shared,
		initiatives,
		terms,
		duplicateTerms: terms.filter((entry) => entry.hasDuplicates).map((entry) => entry.term),
		query,
		view,
		conflictsOnly
	};
}

function hasConflictingDefinitions(sources: ContextDirectoryTermSource[]): boolean {
	const normalizedDefinitions = new Set(
		sources.map((source) => source.definition.trim().toLowerCase()).filter((definition) => definition.length > 0)
	);

	return normalizedDefinitions.size > 1;
}

function compareContextDirectorySources(left: ContextDirectoryTermSource, right: ContextDirectoryTermSource): number {
	if (left.scopeKind !== right.scopeKind) {
		return isSharedContextScope(left.scopeKind) ? -1 : 1;
	}

	if (left.scopeLabel !== right.scopeLabel) {
		return left.scopeLabel.localeCompare(right.scopeLabel);
	}

	return left.contextKey.localeCompare(right.contextKey);
}

function tokenizeContextSearch(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function buildContextQuery(queryTokens: string[]): { $and: Array<{ tokens: string }> } | { tokens: string } {
	if (queryTokens.length === 1) {
		return { tokens: `^${queryTokens[0]}` };
	}

	return { $and: queryTokens.map((token) => ({ tokens: `^${token}` })) };
}

function matchesContextQuery(text: string, normalizedQuery: string): boolean {
	const queryTokens = tokenizeContextSearch(normalizedQuery);

	if (queryTokens.length === 0) {
		return true;
	}

	const fuse = new Fuse([{ tokens: tokenizeContextSearch(text) }], {
		ignoreLocation: true,
		isCaseSensitive: false,
		keys: ["tokens"],
		threshold: 0,
		useExtendedSearch: true
	});

	return fuse.search(buildContextQuery(queryTokens)).length > 0;
}

function filterContextDetails(details: ContextDetails, normalizedQuery: string): ContextDetails | null {
	if (normalizedQuery.length === 0) {
		return details;
	}

	const contextMatches = matchesContextQuery(
		[details.context.key, details.context.scopeLabel, details.context.summary, details.context.title].join(" "),
		normalizedQuery
	);
	const terms = details.terms.filter((term) => matchesContextQuery([term.term, term.definition, ...term.avoid].join(" "), normalizedQuery));

	if (!contextMatches && terms.length === 0) {
		return null;
	}

	return {
		context: {
			...details.context,
			summary: contextMatches ? details.context.summary : ""
		},
		terms
	};
}

function filterContextDirectoryTerm(
	entry: ContextDirectoryTerm,
	normalizedQuery: string,
	view: ContextDirectoryView
): ContextDirectoryTerm | null {
	const sources = entry.sources.filter((source) => {
		if (view === "global" && !isSharedContextScope(source.scopeKind)) {
			return false;
		}

		if (view === "initiatives" && isSharedContextScope(source.scopeKind)) {
			return false;
		}

		if (normalizedQuery.length === 0) {
			return true;
		}

		return matchesContextQuery([entry.term, source.scopeLabel, source.contextTitle, source.definition, ...source.avoid].join(" "), normalizedQuery);
	});

	if (sources.length === 0) {
		return null;
	}

	return {
		term: entry.term,
		sources,
		hasSharedSource: sources.some((source) => isSharedContextScope(source.scopeKind)),
		hasDuplicates: sources.length > 1,
		hasConflictingDefinitions: hasConflictingDefinitions(sources)
	};
}

function isSharedContextScope(scopeKind: ContextDirectoryTermSource["scopeKind"]): boolean {
	return scopeKind === "default" || scopeKind === "project";
}
