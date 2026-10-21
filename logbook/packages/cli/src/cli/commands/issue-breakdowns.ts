import { readFile } from "node:fs/promises";

import { Option } from "clipanion";

import type { ProposedIssueSpecification } from "@agent-issues/core";

import { BaseCommand, TenantCommand, requireOption, requirePositional, withStore } from "../shared.js";
import { getHelpPayload, renderHelp } from "../help.js";

type IssueBreakdownInput = {
	issues: ProposedIssueSpecification[];
};

export class IssueBreakdownCommand extends BaseCommand {
	public static paths = [["issue-breakdown"]];

	public async execute(): Promise<number> {
		const payload = getHelpPayload("issue-breakdown");
		this.print(payload, renderHelp(payload));
		return 0;
	}
}

export class CreateIssueBreakdownCommand extends TenantCommand {
	public static paths = [["issue-breakdown", "create"]];

	public inputFile = Option.String("--input-file");
	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const target = await store.getEntityDetails(requirePositional(this.positionals, 0, "issue-breakdown create <targetId> --input-file <path>"));
			const input = await readIssueBreakdownInput(requireOption(this.inputFile, "--input-file is required for issue-breakdown create."));
			const draft = await store.createIssueBreakdownDraft({ issues: input.issues, targetId: target.entity.id });
			this.print(draft, renderIssueBreakdownDraft(draft));
			return 0;
		});
	}
}

export class ShowIssueBreakdownCommand extends TenantCommand {
	public static paths = [["issue-breakdown", "show"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const draft = await store.getIssueBreakdownDraft({ draftId: requirePositional(this.positionals, 0, "issue-breakdown show <draftId>") });
			this.print(draft, renderIssueBreakdownDraft(draft));
			return 0;
		});
	}
}

export class LatestIssueBreakdownCommand extends TenantCommand {
	public static paths = [["issue-breakdown", "latest"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const target = await store.getEntityDetails(requirePositional(this.positionals, 0, "issue-breakdown latest <targetId>"));
			const draft = await store.getLatestIssueBreakdownDraft({ targetId: target.entity.id });
			this.print(draft, renderIssueBreakdownDraft(draft));
			return 0;
		});
	}
}

export class ApproveIssueBreakdownCommand extends TenantCommand {
	public static paths = [["issue-breakdown", "approve"]];

	public positionals = Option.Rest();
	public snapshotDigest = Option.String("--snapshot-digest");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const snapshotDigest = requireOption(this.snapshotDigest, "--snapshot-digest is required for issue-breakdown approve.");
			if (!/^[a-f0-9]{64}$/.test(snapshotDigest)) {
				throw new Error("--snapshot-digest must be a 64-character lowercase SHA-256 digest.");
			}
			const result = await store.approveIssueBreakdownDraft({
				draftId: requirePositional(this.positionals, 0, "issue-breakdown approve <draftId> --snapshot-digest <digest>"),
				snapshotDigest
			});
			this.print(result, result.status === "approved"
				? `Approved issue breakdown for ${result.targetReference}: ${result.createdIssueReferences.join(", ")}`
				: renderIssueBreakdownDraft(result.draft));
			return 0;
		});
	}
}

async function readIssueBreakdownInput(filePath: string): Promise<IssueBreakdownInput> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read issue-breakdown input ${filePath}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || !("issues" in parsed) || !Array.isArray(parsed.issues) || parsed.issues.length === 0) {
		throw new Error("Issue-breakdown input must be a JSON object with a non-empty issues array.");
	}

	for (const [index, issue] of parsed.issues.entries()) {
		if (!isProposedIssueSpecification(issue)) {
			throw new Error(`Issue-breakdown input has an invalid issue at index ${index}.`);
		}
	}

	return parsed as IssueBreakdownInput;
}

function isProposedIssueSpecification(value: unknown): value is ProposedIssueSpecification {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const issue = value as Record<string, unknown>;
	return isNonEmptyString(issue.key)
		&& isNonEmptyString(issue.title)
		&& isNonEmptyString(issue.outcome)
		&& isNonEmptyString(issue.workMode)
		&& isStringArray(issue.scope)
		&& isStringArray(issue.acceptanceCriteria)
		&& Array.isArray(issue.relationReferences)
		&& issue.relationReferences.every(isIssueBreakdownRelationReference)
		&& (issue.parentKey === undefined || isNonEmptyString(issue.parentKey));
}

function isIssueBreakdownRelationReference(value: unknown): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const relation = value as Record<string, unknown>;
	return isNonEmptyString(relation.relationType)
		&& (relation.targetId === undefined || isNonEmptyString(relation.targetId))
		&& (relation.targetKey === undefined || isNonEmptyString(relation.targetKey))
		&& (relation.targetReference === undefined || isNonEmptyString(relation.targetReference));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function renderIssueBreakdownDraft(draft: { id: string; status: string; targetReference: string; snapshotDigest: string; issues: Array<{ key: string; title: string }> }): string {
	return `${draft.id} ${draft.status} ${draft.targetReference}\nSnapshot: ${draft.snapshotDigest}\n${draft.issues.map((issue) => `${issue.key}: ${issue.title}`).join("\n")}`;
}