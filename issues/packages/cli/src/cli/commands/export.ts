import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Option } from "clipanion";
import type { IssueCommentRecord } from "@agent-issues/core";

import { writeInitiativeDirectoryExport, writeProjectDirectoryExport } from "../../export/export-files.js";
import { renderInitiativeMarkdownExport, renderProjectMarkdownExport } from "../../export/export-markdown.js";

import { requirePositional, withStore } from "../shared.js";
import { MutableTenantCommand } from "../shared.js";

export class ExportCommand extends MutableTenantCommand {
	public static paths = [["export"]];

	public output = Option.String("--output");
	public positionals = Option.Rest();
	public singleFile = Option.Boolean("--single-file", false);

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const target = requirePositional(this.positionals, 0, "export <initiativeId|project>");
			const snapshot = await store.getDatabaseSnapshot();

			if (target === "project") {
				const commentsByIssueId = await collectIssueComments(store, snapshot.entities);
				const markdown = renderProjectMarkdownExport({ snapshot, commentsByIssueId });

				if (this.singleFile) {
					return this.emitSingleFileExport({
						markdown,
						payload: {
							generatedAt: snapshot.generatedAt,
							markdown,
							mode: "single-file",
							scope: "project"
						},
						target
					});
				}

				const result = writeProjectDirectoryExport({
					commentsByIssueId,
					snapshot,
					outputPath: this.resolveOutputPath(target),
					force: this.force
				});

				this.print(
					result,
					renderDirectorySummary(result)
				);
				return 0;
			}

			const bundle = await store.getInitiativeBundle(target);
			const commentsByIssueId = await collectIssueComments(store, bundle.issues);
			const relations = snapshot.relations;
			const context = await store.getContextDetails({ scopeRef: target });
			const markdown = renderInitiativeMarkdownExport({ bundle, commentsByIssueId, context, planEntries: snapshot.planEntries, relations, users: snapshot.users });

			if (this.singleFile) {
				return this.emitSingleFileExport({
					markdown,
					payload: {
						initiativeId: bundle.initiative.id,
						markdown,
						mode: "single-file",
						scope: "initiative"
					},
					target
				});
			}

			const result = writeInitiativeDirectoryExport({
				bundle,
				commentsByIssueId,
				context,
				outputPath: this.resolveOutputPath(target),
				planEntries: snapshot.planEntries,
				relations,
				users: snapshot.users,
				force: this.force
			});

			this.print(
				result,
				renderDirectorySummary(result)
			);
			return 0;
		});
	}

	protected emitSingleFileExport(input: {
		markdown: string;
		payload: { markdown: string; mode: "single-file"; scope: "initiative" | "project"; initiativeId?: string; generatedAt?: string };
		target: string;
	}): number {
		if (!this.output) {
			this.print(input.payload, input.markdown);
			return 0;
		}

		const outputPath = path.resolve(this.context.cwd, this.output);
		mkdirSync(path.dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, `${input.markdown.trimEnd()}\n`, "utf8");

		this.print(
			{ ...input.payload, outputPath },
			`Exported ${input.payload.scope} ${input.target} to ${outputPath}`
		);
		return 0;
	}

	protected resolveOutputPath(target: string): string {
		return path.resolve(this.context.cwd, this.output ?? path.join("agent-issues-export", target));
	}
}

async function collectIssueComments(
	store: { listIssueComments(input: { issueId: string; all?: boolean }): Promise<{ comments: IssueCommentRecord[] }> },
	entities: Array<{ id: string; kind: string }>
): Promise<Record<string, IssueCommentRecord[]>> {
	const issues = entities.filter((entity) => entity.kind === "issue");
	const pages = await Promise.all(issues.map(async (issue) => [issue.id, (await store.listIssueComments({ issueId: issue.id, all: true })).comments] as const));
	return Object.fromEntries(pages);
}

function renderDirectorySummary(result: { scope: "initiative" | "project"; outputPath: string; files: string[] }): string {
	return [
		`Exported ${result.scope} to ${result.outputPath}`,
		`Files: ${result.files.length}`
	].join("\n");
}