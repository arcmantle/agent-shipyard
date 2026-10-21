---
name: to-issues
description: Break a plan or PRD into independently grabbable issues, then create and link those issues in agent-issues.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# To Issues

Break a plan into sequenced, independently verifiable issues. Use tracer-bullet vertical slices.

## Process

### 1. Gather context

Work from what is already in the conversation context. If the user gives an entity ID, run the **Entity Read** recipe to resolve it. If the user gives a file path, read the file first.

Run the **Initiative Read** recipe and the **Relation Query** recipe for the active scope to find:

- the parent initiative that must structurally own the new issues
- the PRD and user stories the issues must satisfy
- the required ready Plan and its active entries that each new issue implements
- any existing issues or blockers you must reuse instead of duplicate

If the supplied Plan reference is unavailable in the current tracker scope, report that fact and select an existing ready Plan under the active initiative. If none exists, create a replacement Plan under that initiative and start `plan`; do not create an issue breakdown until the Plan is ready. If more than one ready Plan exists, ask the user to select one.

### 2. Explore the codebase

If you have not explored the codebase yet, do so now to understand the current state of the code. Issue titles and descriptions must use the established vocabulary and respect the ADRs in the area you touch.

### 3. Draft vertical slices

List every testable behavior, contract, state, integration, and verification change in the plan. Draft one tracer-bullet issue per change. Dependencies remain linked issues; a shared feature outcome is not a reason to merge them.

A slice can be `HITL` or `AFK`. Prefer `AFK` over `HITL` when you can. If the choice matters to the user, state it in the text you present. Do not invent unsupported tracker fields.

Rules:

- Each slice delivers one narrow, complete change through the affected behavior.
- A finished slice is demoable or verifiable on its own.
- Merge changes only when they share one implementation boundary and one acceptance check.
- Use sub-issues when related changes must roll up under one parent issue. In this shape, leaf sub-issues normally carry the `fixes` links to user stories.

### Blocker direction

`A blocks B` means B cannot start until A is done. The `blocks` relation always points from the prerequisite to the dependent issue.

- If B is blocked by A, add `{ relationType: "blocks", targetKey: "B" }` to A's `relationReferences`.
- Do not add `{ relationType: "blocks", targetKey: "A" }` to B's `relationReferences`.
- Before you create a breakdown draft, list each edge as `blocker -> blocked` and check it against the proposed dependencies.
- Root issues have no incoming `blocks` relations. Each non-root issue has an incoming `blocks` relation from every stated prerequisite.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- Title
- Type: `HITL` or `AFK`
- Blocks
- Blocked by
- User stories covered

Ask whether the size of each slice and the dependencies feel right, whether to merge or split any slices, and whether the `HITL` and `AFK` split is correct.

Repeat until the user approves the breakdown.

### 5. Preview and approve the issue breakdown

After the user approves the proposed breakdown, write each proposed issue body from the [Issue recipe](../recipes/issue.md). Validate every parent and relation reference. For every issue, add its active Plan-entry IDs as `planEntryIds`. For every dependency, verify that the `blocks` source is the prerequisite and the target is the dependent issue. Run the **Issue Breakdown** recipe to create the complete server-side issue-breakdown draft from the validated graph. Do not create issue records at this point.

For an MCP host that can render apps:

1. Call `issue_breakdown_create` with the target ID and the complete proposed issue array.
2. Call `issue_breakdown_preview` with the returned draft ID immediately before issue creation.
3. Wait for the user to select Approve in Issue Preview.
4. The app calls `issue_breakdown_approve` with the displayed draft ID and snapshot digest. This authoritative operation creates the approved issue graph.

For an MCP host that cannot render apps:

1. Return the same complete proposed issue graph and snapshot digest as text and structured tool data.
2. Ask for explicit chat confirmation of that snapshot.
3. After confirmation, call the authoritative approval operation with the draft ID and snapshot digest.

When approval reports a changed snapshot, return the current draft for a new review. Do not create issue records outside the authoritative approval operation.

### 6. Publish the issues in agent-issues

After the authoritative approval operation creates the issue graph:

Return a short summary that shows each created issue ID, its linked Plan entries and user stories, and its blockers. Do not create or add links after approval because the approved graph already contains them.