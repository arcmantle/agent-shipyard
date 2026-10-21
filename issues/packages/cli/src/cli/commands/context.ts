import { Option } from "clipanion";
import { ContextTermConflictError } from "@agent-issues/core";

import {
	renderContextDetails,
	renderContextForgetResult,
	renderContextList,
	renderContextOutput,
	renderContextSearchTermsOnly,
	renderContextTermResult,
	toContextSearchTermsOnly
} from "../../context/context-cli.js";
import {
	toCompactContextDefineAcknowledgement,
	toCompactContextForgetAcknowledgement,
	toCompactContextSetAcknowledgement
} from "../../context/entity-projection.js";

import {
	CONTEXT_SUBCOMMANDS,
	TenantCommand,
	parseContextView,
	parseCsvOption,
	parseEntityView,
	requireOption,
	requirePositional,
	resolveMarkdownFileOption,
	withStore
} from "../shared.js";

export class ContextCommand extends TenantCommand {
	public static paths = [["context"]];

	public avoid = Option.String("--avoid");
	public bodyFile = Option.String("--body-file");
	public positionals = Option.Rest();
	public query = Option.String("--query");
	public scope = Option.String("--scope");
	public termsOnly = Option.Boolean("--terms-only", false);
	public title = Option.String("--title");
	public view = Option.String("--view");

	public async execute(): Promise<number> {
		const firstPositional = this.positionals[0];
		const subcommand = !firstPositional || CONTEXT_SUBCOMMANDS.has(firstPositional) ? firstPositional ?? "show" : "show";
		const isMutation = subcommand === "set" || subcommand === "define" || subcommand === "forget";
		if (!isMutation && (this.view === "compact" || this.view === "full")) {
			throw new Error(`--view ${this.view} is only valid for context set, define, and forget.`);
		}
		const mutationView = isMutation
			? parseEntityView(this.view)
			: undefined;
		const contextView = mutationView === undefined ? parseContextView(this.view) : "all";
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const showScopeRef = subcommand === "show"
				? this.scope ?? (firstPositional && !CONTEXT_SUBCOMMANDS.has(firstPositional) ? firstPositional : this.positionals[1])
				: this.scope;

			if (subcommand === "list") {
				const result = await store.listContexts();
				this.print(result, renderContextList(result));
				return 0;
			}

			if (subcommand === "show") {
				if (showScopeRef && (this.query || contextView !== "all")) {
					throw new Error("`context show <scope>` does not support --query or --view. Use `context search` for filtered project-wide discovery.");
				}

				const context = showScopeRef
					? await store.getContextDetails({ scopeRef: showScopeRef })
					: await store.queryContextDirectory({ query: this.query, view: contextView });
				this.print(context, renderContextOutput(context));
				return 0;
			}

			if (subcommand === "search") {
				const query = this.query ?? this.positionals[1];
				if (!query) {
					throw new Error("Missing argument. Usage: context search <query> [--view <all|global|initiatives>]");
				}

				const result = await store.queryContextDirectory({ query, view: contextView });
				if (this.termsOnly) {
					const compactResult = toContextSearchTermsOnly(result);
					this.print(compactResult, renderContextSearchTermsOnly(compactResult));
					return 0;
				}

				this.print(result, renderContextOutput(result));
				return 0;
			}

			if (this.termsOnly) {
				throw new Error("`--terms-only` is only supported for `context search`.");
			}

			if (subcommand === "conflicts") {
				if (contextView === "global") {
					throw new Error("`context conflicts` does not support --view global because shared-only context cannot conflict across scopes.");
				}

				const result = await store.queryContextDirectory({
					conflictsOnly: true,
					query: this.query ?? this.positionals[1],
					view: contextView
				});
				this.print(result, renderContextOutput(result));
				return 0;
			}

			if (subcommand === "set") {
				const current = await store.getContextDetails({ scopeRef: this.scope });
				const result = await store.upsertContext({
					scopeRef: this.scope,
					title: requireOption(this.title, "--title is required for context set."),
					summary: requireOption(await resolveMarkdownFileOption(this.bodyFile, "--body-file"), "--body-file is required for context set."),
					...(current.context.exists && {
						expectedRevision: current.context.revision,
						expectedContentHash: current.context.contentHash
					})
				});

				const details = await store.getContextDetails({ scopeRef: this.scope });
				this.print(this.asJson && mutationView === "compact" ? toCompactContextSetAcknowledgement(result) : details, renderContextDetails(details));
				return 0;
			}

			if (subcommand === "define") {
				const term = requirePositional(this.positionals, 1, "context define <term> --body-file <path|-> [--avoid <comma-separated terms>]");
				const current = (await store.getContextDetails({ scopeRef: this.scope })).terms.find((candidate) => candidate.term === term);
				const input = {
					scopeRef: this.scope,
					term,
					definition: requireOption(await resolveMarkdownFileOption(this.bodyFile, "--body-file"), "--body-file is required for context define."),
					avoid: parseCsvOption(this.avoid),
					...(current && { expectedRevision: current.revision, expectedContentHash: current.contentHash })
				};
				let result;
				try {
					result = await store.defineContextTerm(input);
				} catch (error) {
					if (!(error instanceof ContextTermConflictError) || current) {
						throw error;
					}
					const activeAfterConflict = (await store.getContextDetails({ scopeRef: this.scope })).terms.some((candidate) => candidate.term === term);
					if (activeAfterConflict) {
						throw error;
					}
					result = await store.defineContextTerm({
						...input,
						expectedRevision: error.currentRevision,
						expectedContentHash: error.currentContentHash
					});
				}

				const details = await store.getContextDetails({ scopeRef: this.scope });
				const storedTerm = details.terms.find((candidate) => candidate.id === result.term.id);
				if (!storedTerm) {
					throw new Error(`Context term not found after definition: ${result.term.id}`);
				}
				const fullResult = { context: details.context, term: storedTerm, created: result.created };
				this.print(this.asJson && mutationView === "compact" ? toCompactContextDefineAcknowledgement(result) : fullResult, renderContextTermResult(fullResult));
				return 0;
			}

			if (subcommand === "forget") {
				const term = requirePositional(this.positionals, 1, "context forget <term>");
				const current = (await store.getContextDetails({ scopeRef: this.scope })).terms.find((candidate) => candidate.term === term);
				const input = {
					scopeRef: this.scope,
					term,
					...(current && { expectedRevision: current.revision, expectedContentHash: current.contentHash })
				};
				let result;
				try {
					result = await store.forgetContextTerm(input);
				} catch (error) {
					if (!(error instanceof ContextTermConflictError) || current) {
						throw error;
					}
					result = await store.forgetContextTerm({
						...input,
						expectedRevision: error.currentRevision,
						expectedContentHash: error.currentContentHash
					});
				}

				this.print(this.asJson && mutationView === "compact" ? toCompactContextForgetAcknowledgement(result) : result, renderContextForgetResult(result));
				return 0;
			}

			throw new Error(`Unknown context subcommand: ${subcommand}`);
		});
	}
}
