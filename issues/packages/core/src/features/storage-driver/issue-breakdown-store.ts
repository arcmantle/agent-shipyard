import type { ProposedIssueBreakdown, ProposedIssueSpecification } from "../issue-breakdown/issue-breakdown-snapshot.js";

export type IssueBreakdownDraftStatus = "active" | "approved" | "superseded";

export type IssueBreakdownDraft = ProposedIssueBreakdown & {
	id: string;
	status: IssueBreakdownDraftStatus;
	approvedAt: string | null;
	createdIssueReferences: string[];
};

export type IssueBreakdownApprovalResult =
	| { status: "approved"; targetReference: string; createdIssueReferences: string[] }
	| { status: "stale"; draft: IssueBreakdownDraft };

export interface IssueBreakdownStore {
	createIssueBreakdownDraft(input: { targetId: string; issues: ProposedIssueSpecification[] }): Promise<IssueBreakdownDraft>;
	getIssueBreakdownDraft(input: { draftId: string }): Promise<IssueBreakdownDraft>;
	getLatestIssueBreakdownDraft(input: { targetId: string }): Promise<IssueBreakdownDraft>;
	approveIssueBreakdownDraft(input: { draftId: string; snapshotDigest: string }): Promise<IssueBreakdownApprovalResult>;
}