import { createHash } from "node:crypto";

export type IssueBreakdownRelationReference = {
	relationType: string;
	targetId?: string;
	targetKey?: string;
	targetReference?: string;
};

export type ProposedIssueSpecification = {
	key: string;
	title: string;
	outcome: string;
	scope: string[];
	workMode: string;
	acceptanceCriteria: string[];
	parentKey?: string;
	planEntryIds?: string[];
	relationReferences: IssueBreakdownRelationReference[];
};

export type ProposedIssueBreakdown = {
	targetId: string;
	targetReference: string;
	issues: ProposedIssueSpecification[];
	snapshotDigest: string;
};

export function projectProposedIssueBreakdown(input: Omit<ProposedIssueBreakdown, "snapshotDigest">): ProposedIssueBreakdown {
	const issues = input.issues.map((issue) => ({
		...issue,
		scope: [...issue.scope],
		acceptanceCriteria: [...issue.acceptanceCriteria],
		...(issue.planEntryIds === undefined ? {} : { planEntryIds: [...issue.planEntryIds] }),
		relationReferences: issue.relationReferences.map((relation) => ({ ...relation }))
	}));

	return {
		targetId: input.targetId,
		targetReference: input.targetReference,
		issues,
		snapshotDigest: computeProposedIssueBreakdownSnapshotDigest({ ...input, issues })
	};
}

export function computeProposedIssueBreakdownSnapshotDigest(input: Omit<ProposedIssueBreakdown, "snapshotDigest">): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}