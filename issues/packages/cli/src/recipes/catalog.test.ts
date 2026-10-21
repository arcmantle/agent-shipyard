import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps typed facts and graph relations outside recipe body prose", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toMatch(/typed facts.*outside.*body prose/i);
	expect(catalog).toMatch(/graph relations.*outside.*body prose/i);
});

it("distinguishes authored placeholders from generated content", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toMatch(/<angle brackets>.*authored placeholders/i);
	expect(catalog).toContain("Not derived from tracker metadata.");
});

it("links each current recipe from the catalog index", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[Context Summary](./context-summary.md)");
	expect(catalog).toContain("[Context Term](./context-term.md)");
	expect(catalog).toContain("[Issue Comment](./issue-comment.md)");
	expect(catalog).toContain("[Pioneer Map](./pioneer-map.md)");
	expect(catalog).toContain("[Pioneer Ticket](./pioneer-ticket.md)");
});

it("links each management recipe from the catalog index", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[Project](./project.md)");
	expect(catalog).toContain("[Epic](./epic.md)");
	expect(catalog).toContain("[Version](./version.md)");
	expect(catalog).toContain("[Initiative](./initiative.md)");
});

it("links the PRD recipe from the catalog index", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[PRD](./prd.md)");
});

it("provides a PRD recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/prd.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Problem Statement");
	expect(recipe).toContain("## Solution");
	expect(recipe).toContain("Child `userStory` entities are authoritative");
	expect(recipe).not.toContain("## User Stories");
	expect(recipe).toContain("## Implementation Decisions");
	expect(recipe).toContain("## Testing Decisions");
	expect(recipe).toContain("## Out of Scope");
	expect(recipe).toContain("## Further Notes");
});

it("provides a discoverable user-story recipe", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/user-story.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[User Story](./user-story.md)");
	expect(recipe).toContain("As an <actor>, I want a <feature>, so that <benefit>");
	expect(recipe).toContain("## Acceptance Criteria");
	expect(recipe).toContain("## Boundaries");
});

it("provides a discoverable issue recipe with its required headings", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/issue.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[Issue](./issue.md)");
	expect(recipe).toContain("## Work Mode");
	expect(recipe).toContain("## Outcome");
	expect(recipe).toContain("## Scope");
	expect(recipe).toContain("## Work Plan");
	expect(recipe).toContain("## Acceptance Criteria");
	expect(recipe).toContain("## Verification");
	expect(recipe).toContain("## Notes");
});

it("provides a discoverable ADR recipe with its current short form", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/adr.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[ADR](./adr.md)");
	expect(recipe).toContain("## Status");
	expect(recipe).toContain("## Context");
	expect(recipe).toContain("## Decision");
	expect(recipe).toContain("## Consequences");
});

it("provides a discoverable handoff recipe with continuity details", () => {
	const catalog = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/README.md", import.meta.url)),
		"utf8"
	);
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/handoff.md", import.meta.url)),
		"utf8"
	);

	expect(catalog).toContain("[Handoff](./handoff.md)");
	expect(recipe).toContain("## Focus");
	expect(recipe).toContain("## Current State");
	expect(recipe).toContain("## Tracked Scope");
	expect(recipe).toContain("## Blockers");
	expect(recipe).toContain("## Relevant Files");
	expect(recipe).toContain("## Suggested Skills");
});

it("provides a project recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/project.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Purpose");
	expect(recipe).toContain("## Scope");
	expect(recipe).toContain("## Success Conditions");
	expect(recipe).toContain("## Non-Goals");
});

it("provides an epic recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/epic.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Purpose");
	expect(recipe).toContain("## Scope");
	expect(recipe).toContain("## Success Conditions");
	expect(recipe).toContain("## Non-Goals");
});

it("provides a version recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/version.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Release Intent");
	expect(recipe).toContain("## Compatibility and Migration Notes");
});

it("provides an initiative recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/initiative.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Purpose");
	expect(recipe).toContain("## Scope");
	expect(recipe).toContain("## Success Conditions");
	expect(recipe).toContain("## Non-Goals");
});

it("provides a context-summary recipe with its required headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/context-summary.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Purpose");
	expect(recipe).toContain("## Boundaries");
	expect(recipe).toContain("## Working Agreements");
});

it("provides a compact context-term recipe without section headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/context-term.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).not.toMatch(/^#{2,}\s/m);
});

it("provides an issue-comment recipe with optional supporting sections", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/issue-comment.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Evidence");
	expect(recipe).toContain("## Proposed Action");
	expect(recipe).toContain("optional");
});

it("provides a Pioneer map recipe with its current headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/pioneer-map.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Destination");
	expect(recipe).toContain("## Notes");
	expect(recipe).toContain("## Decisions so far");
	expect(recipe).toContain("## Not yet specified");
	expect(recipe).toContain("## Out of scope");
});

it("provides a Pioneer ticket recipe with its current headings", () => {
	const recipe = readFileSync(
		fileURLToPath(new URL("../../skills/recipes/pioneer-ticket.md", import.meta.url)),
		"utf8"
	);

	expect(recipe).toContain("## Ticket type");
	expect(recipe).toContain("## Question");
	expect(recipe).toContain("## Resolution");
});

it("links each body-writing skill to only its applicable recipes", () => {
	const expectedRecipesByFile = new Map([
		["domain-modeling/ADR-FORMAT.md", ["adr.md"]],
		["domain-modeling/CONTEXT-FORMAT.md", ["context-summary.md", "context-term.md"]],
		["handoff/SKILL.md", ["handoff.md"]],
		["migrate-docs/SKILL.md", ["adr.md", "context-summary.md", "context-term.md", "initiative.md", "issue.md", "prd.md", "user-story.md"]],
			["prototype/SKILL.md", ["issue.md"]],
		["to-issues/SKILL.md", ["issue.md"]],
		["to-prd/SKILL.md", ["prd.md", "user-story.md"]],
			["pioneer/SKILL.md", ["pioneer-map.md", "pioneer-ticket.md"]]
	]);

	for (const [skillFile, expectedRecipes] of expectedRecipesByFile) {
		const skill = readFileSync(
			fileURLToPath(new URL(`../../skills/${skillFile}`, import.meta.url)),
			"utf8"
		);
		const recipes = [...skill.matchAll(/(?:\.\.\/)+recipes\/([\w-]+\.md)/g)]
			.map((match) => match[1])
			.sort();

		expect(recipes).toEqual(expectedRecipes);
	}
});

it("requires Issue Preview approval before to-issues creates records", () => {
	const skill = readFileSync(
		fileURLToPath(new URL("../../skills/to-issues/SKILL.md", import.meta.url)),
		"utf8"
	);

	expect(skill).toMatch(/validate every parent and relation reference/i);
	expect(skill).toContain("Issue Preview");
	expect(skill).toContain("issue_breakdown_create");
	expect(skill).toContain("issue_breakdown_preview");
	expect(skill).toContain("explicit chat confirmation");
	expect(skill).toContain("authoritative approval operation");
});

it("documents Issue Breakdown and Plan Preview recipes", () => {
	const contract = readFileSync(
		fileURLToPath(new URL("../../skills/agent-issues-operating-contract.md", import.meta.url)),
		"utf8"
	);

	expect(contract).toContain("### Issue Breakdown");
	expect(contract).toContain("issue_breakdown_create({ targetId, issues })");
	expect(contract).toContain("### Plan Preview");
	expect(contract).toContain("plan_preview({ planId })");
});