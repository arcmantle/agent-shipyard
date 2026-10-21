import { createHash } from "node:crypto";

import type { EntityRecord } from "../entity-store/domain.js";
import { projectPlanEntries, type PlanCurrentGroup, type PlanEntryRecord } from "../plan-entry/plan-entry-types.js";

export type ProposedPlan = {
	reference: string;
	title: string;
	goal: string;
	context: string;
	current: PlanCurrentGroup[];
	hasActiveQuestions: boolean;
	snapshotDigest: string;
};

export function projectProposedPlan(plan: EntityRecord, entries: readonly PlanEntryRecord[]): ProposedPlan {
	const { goal, context } = projectPlanBody(plan.body);
	const currentEntries = projectPlanEntries(entries).current;
	const hasActiveQuestions = currentEntries.some((group) => group.key === "questions" && group.entries.length > 0);
	const current = currentEntries.filter((group) => group.entries.length > 0);

	return {
		reference: plan.reference,
		title: plan.title,
		goal,
		context,
		current,
		hasActiveQuestions,
		snapshotDigest: computeProposedPlanSnapshotDigest({ reference: plan.reference, title: plan.title, goal, context, current })
	};
}

export function projectPlanBody(body: string): { goal: string; context: string } {
	return {
		goal: extractPlanSection(body, "Goal"),
		context: extractPlanSection(body, "Context")
	};
}

export function computeProposedPlanSnapshotDigest(input: Pick<ProposedPlan, "reference" | "title" | "goal" | "context" | "current">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				reference: input.reference,
				title: input.title,
				goal: input.goal,
				context: input.context,
				current: input.current.map((group) => ({
					key: group.key,
					entries: group.entries.map((entry) => ({ role: entry.role, scopeDirection: entry.scopeDirection, body: entry.body ?? "" }))
				}))
			})
		)
		.digest("hex");
}

function extractPlanSection(body: string, heading: string): string {
	const match = new RegExp(`^## ${heading}\\s*$\\n?([\\s\\S]*?)(?=^## |$)`, "m").exec(body);
	return match?.[1].trim() ?? "";
}