import type {
	ContextDetails,
	ContextDirectoryTerm,
	ContextListResult,
	DefineContextTermResult,
	ForgetContextTermResult,
	QueryContextDirectoryResult
} from "@agent-issues/api-local";

export type ContextSearchTermsOnlyResult = {
	query: string;
	view: QueryContextDirectoryResult["view"];
	conflictsOnly: boolean;
	duplicateTerms: string[];
	terms: ContextDirectoryTerm[];
};

export function toContextSearchTermsOnly(result: QueryContextDirectoryResult): ContextSearchTermsOnlyResult {
	return {
		query: result.query,
		view: result.view,
		conflictsOnly: result.conflictsOnly,
		duplicateTerms: result.duplicateTerms,
		terms: result.terms
	};
}

export function renderContextDetails(details: ContextDetails): string {
	const lines = [
		`${details.context.title} (${details.context.key})`,
		`Scope: ${details.context.scopeKind} ${details.context.scopeEntityId ?? "default"} ${details.context.scopeLabel}`,
		`Stored in database: ${details.context.exists ? "yes" : "not yet initialized"}`,
		`Summary: ${details.context.summary}`,
		`Updated: ${details.context.updatedAt ?? "never"}`,
		"Terms:"
	];

	if (details.terms.length === 0) {
		lines.push("none");
		return lines.join("\n");
	}

	for (const term of details.terms) {
		lines.push(`- ${term.term}: ${term.definition}`);
		if (term.avoid.length > 0) {
			lines.push(`  Avoid: ${term.avoid.join(", ")}`);
		}
	}

	return lines.join("\n");
}

export function renderContextDirectory(directory: QueryContextDirectoryResult): string {
	const sharedTitle = directory.shared?.context.title ?? "Project Context";
	const sharedKey = directory.shared?.context.key ?? "default";
	const lines = [
		`${sharedTitle} (${sharedKey})`,
		"Scope: project directory",
		`View: ${directory.view}`,
		`Query: ${directory.query.length > 0 ? directory.query : "none"}`,
		`Conflicts only: ${directory.conflictsOnly ? "yes" : "no"}`,
		`Shared context stored in database: ${directory.shared?.context.exists ? "yes" : "not matched or not initialized"}`,
		`Shared summary: ${directory.shared?.context.summary && directory.shared.context.summary.length > 0 ? directory.shared.context.summary : "none"}`,
		`Shared terms: ${directory.shared?.terms.length ?? 0}`,
		`Initiative contexts: ${directory.initiatives.length}`,
		`Discovered terms: ${directory.terms.length}`,
		`Duplicate labels across scopes: ${directory.duplicateTerms.length}`
	];

	if (directory.view !== "global") {
		lines.push("", "Initiative contexts:");
	}

	if (directory.view !== "global" && directory.initiatives.length === 0) {
		lines.push("none");
	} else if (directory.view !== "global") {
		for (const details of directory.initiatives) {
			lines.push(
				`- ${details.context.scopeLabel} (${details.context.key}) ${details.context.exists ? "stored" : "implicit"} terms=${details.terms.length}`
			);
			if (details.context.summary.length > 0) {
				lines.push(`  ${details.context.summary}`);
			}
		}
	}

	lines.push("", "Discovered terms:");

	if (directory.terms.length === 0) {
		lines.push("none");
		return lines.join("\n");
	}

	for (const entry of directory.terms) {
		lines.push(...renderContextTermEntry(entry));
	}

	return lines.join("\n");
}

export function renderContextSearchTermsOnly(result: ContextSearchTermsOnlyResult): string {
	const lines = [
		"Matching context terms",
		`View: ${result.view}`,
		`Query: ${result.query.length > 0 ? result.query : "none"}`,
		`Conflicts only: ${result.conflictsOnly ? "yes" : "no"}`,
		`Matches: ${result.terms.length}`,
		`Duplicate labels across scopes: ${result.duplicateTerms.length}`,
		"",
		"Terms:"
	];

	if (result.terms.length === 0) {
		lines.push("none");
		return lines.join("\n");
	}

	for (const entry of result.terms) {
		lines.push(...renderContextTermEntry(entry));
	}

	return lines.join("\n");
}

export function renderContextOutput(details: ContextDetails | QueryContextDirectoryResult): string {
	return "shared" in details ? renderContextDirectory(details) : renderContextDetails(details);
}

export function renderContextList(result: ContextListResult): string {
	if (result.contexts.length === 0) {
		return "No contexts found.";
	}

	return result.contexts
		.map(
			(item) =>
				`${item.context.key} ${item.context.scopeKind} ${item.context.scopeEntityId ?? "default"} ${item.context.exists ? "stored" : "implicit"} terms=${item.termCount} ${item.context.scopeLabel}\n  ${item.context.summary}`
		)
		.join("\n");
}

export function renderContextTermResult(result: DefineContextTermResult): string {
	return [
		`${result.created ? "Defined" : "Updated"} ${result.term.term} in ${result.context.title} (${result.context.key})`,
		result.term.definition,
		result.term.avoid.length > 0 ? `Avoid: ${result.term.avoid.join(", ")}` : "Avoid: none"
	].join("\n");
}

export function renderContextForgetResult(result: ForgetContextTermResult): string {
	return result.removed
		? `Removed ${result.term} from ${result.context.title} (${result.context.key})`
		: `Context term not found: ${result.term}`;
}

function renderContextTermEntry(entry: ContextDirectoryTerm): string[] {
	const warnings: string[] = [];
	if (entry.hasDuplicates) {
		warnings.push(`defined in ${entry.sources.length} scopes`);
	}
	if (entry.hasConflictingDefinitions) {
		warnings.push("conflicting definitions");
	}

	const lines = [`- ${entry.term}${warnings.length > 0 ? ` [${warnings.join("; ")}]` : ""}`];
	for (const source of entry.sources) {
		lines.push(`  - ${source.scopeLabel}: ${source.definition}`);
		if (source.avoid.length > 0) {
			lines.push(`    Avoid: ${source.avoid.join(", ")}`);
		}
	}

	return lines;
}