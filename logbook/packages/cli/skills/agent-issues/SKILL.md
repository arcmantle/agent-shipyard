---
name: agent-issues
description: Internal orientation guide for agents working in repos that use agent-issues. Use when you need to understand the tracker model, MCP tool selection, or workflow before you act.
argument-hint: Which part of agent-issues do you need to review before you continue?
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Agent-Issues Tooling Guide

This is an internal reference skill for the agent. Use it before you continue with real work, when you need more information about how `agent-issues` operates.

Do not start this skill only because the repository uses `agent-issues`. Start it when you lack operational context: which tracker action to use, how entities relate, how statuses change, or which Agent Issues skill owns the next step.

## What to do

Start from the named recipes in the shared operating contract before you guess. Each recipe specifies the MCP tool, required input fields, and exact CLI fallback. Use available MCP tool names, descriptions, and typed inputs to validate the recipe against the running server.

Once you have this information, act. Do not keep explaining the task to yourself. Match the task to the smallest tracker action or Agent Issues skill that moves the work forward.

## Core mental model

`agent-issues` tracks work as a graph. It does not track work as loose markdown files.

- `initiative`: the top-level record.
- `plan`: the planning record that tracks questions and decisions before it becomes ready for PRD conversion.
- `prd`: the plan or product requirement for an initiative.
- `userStory`: the user-visible slice that the PRD commits to.
- `issue`: the unit of work you can execute.
- `adr`: a hard-to-reverse architecture decision.
- `context`: the database-backed glossary for shared, project-scoped, or initiative-scoped terms.

Issue comments are database records owned by an issue, not graph entities. Use comment tracker actions to read, create, edit, delete, and inspect comment history. Send authored text in the MCP body field.

An issue is not always a flat leaf. An issue can `decompose` into sub-issues.

- Create a sub-issue with another issue as parent.
- Move a sub-issue by changing its structural parent.
- Link `fixes` from leaf issues to user stories. Parent issues group work and can own sub-issues.

## Debt records

Debt records are reference-only records for accepted cost or risk. They do not represent committed work.

- A debt record has one project, epic, initiative, or issue owner. PRDs and user stories cannot own debt records.
- Debt lifecycle states are open, resolved, and archived. Lifecycle changes are manual and reversible.
- An epic, initiative, or issue can resolve debt. Resolver state does not change debt lifecycle state.
- Use the [Debt Recipe](../recipes/debt.md) before an authored debt body write. Keep category, priority, lifecycle, ownership, and graph relations outside the body.

Run the **Entity List** recipe to find records by kind and narrow by status, parent, or limit. Run the **Relation Query** recipe with direction and type filters. Run the **Entity Read** recipe only when you need authored content or a full record. Run the **Initiative Read** recipe only for a planned initiative-wide view.

For an entity's complete working context, run the **Relation Query** recipe once without direction or type filters. It includes the entity's full body and directly related records in both directions. Add filters only when a smaller result is needed. **Entity List** recipe results can include `openBlockers`, so candidate blocked state is visible without a relation query per candidate.

## Initiative reads

For real work, start with compact discovery and edge inspection. Use authored or initiative-wide content only when the task needs it:

- To resume tracked work, run the **Handoff Read** recipe. Its selected handoff body carries the session context.
- Use filtered compact lists and relations to move from the target to the active issue and its blockers.
- Run the **Initiative Read** recipe only when the task needs the whole initiative graph and authored records.
- Run the **Context Read** recipe with it, so your language and plan match the glossary.
- If a term remains unclear, run the **Context Read** recipe with search or conflict input for project-wide discovery.
- Run a narrower **Entity Read** recipe or **Relation Query** recipe only when the task needs one entity or edge set.

Default steps:

1. Run the **Entity List** recipe to find candidates.
2. Run the **Relation Query** recipe to navigate.
3. Run the **Entity Read** recipe for authored content when needed.
4. Run the **Initiative Read** recipe only when the whole initiative is a planned input.

Do not fetch full records and trim them with routine downstream filters. Use compact MCP inputs and structured results, or track the recurring capability gap.

## Tracker action selection

Use the exact named recipe for the job:

- Find entities: **Entity List** recipe, **Entity Read** recipe, **Relation Query** recipe, or **Initiative Read** recipe.
- Change tracked data: **Entity Create And Edit** recipe, **Entity State And Structure** recipe, **Entity Relations** recipe, **Entity Restore** recipe, or **Context Restore** recipe.
- Read revision history: **Revision Read** recipe. Record issue discussion: **Issue Comment Read** recipe or **Issue Comment Write** recipe.
- Manage vocabulary: **Context Read** recipe or **Context Write** recipe.
- Create or edit Plan entries: **Plan Entry Write** recipe. Read Plan entries: **Plan Entry Read** recipe. Link Plan entries: **Plan Entry Issue Link** recipe.
- Review and approve a proposed issue graph: **Issue Breakdown** recipe.
- Review and confirm a Proposed Plan: **Plan Preview** recipe.
- Preserve continuity: **Handoff Read** recipe or **Handoff Write** recipe.
- Use **Host Operations** recipe only for site lifecycle, agent or skill installation, and MCP installation.

## Workflow map

When you must choose the next packaged skill, pick it clearly:

1. `domain-modeling` to sharpen terms, boundaries, glossary context, and architecture decisions.
2. `grill-with-docs` to challenge and sharpen a plan one question at a time, with domain modeling.
3. `plan` for the same domain-modeling result at a faster pace, through batches of questions.
4. `to-prd` to capture the plan as a PRD and user stories.
5. `to-issues` to break the plan into issues you can execute.
6. `handoff` to record where the work stands for the next session.
7. `prepare` to resolve an initiative, issue, user story, or handoff and load its context, then stop for a conversation fork before the build starts.
8. `start-work` as the single-session alternative: it also selects the next workable issue, but it drives straight into a build skill without forking.
9. `tdd` to build one issue through a red-green-refactor loop, either started fresh after a `prepare` fork or handed off directly by `start-work`.
10. `implement` as the alternative to `tdd` for the same fork point or hand-off: thin, independently-verified vertical slices for changes that do not fit a red-green-refactor loop (broad refactors, config/infrastructure changes, multi-file migrations).
11. `migrate-docs` to import existing documentation into the tracker.

If you are unsure where the work sits in the workflow, inspect entity and relation summaries first. Use `show <initiativeId>` only if you must see the whole initiative to choose the workflow.

## Prepare-then-fork

Prefer `prepare` over `start-work` for real build sessions. Do not plan and build in the same conversation. `prepare` gathers context and reports a briefing, then the conversation forks before `tdd` or `implement` starts the build in a fresh conversation with a small context. This keeps a long build loop from growing the cost of a session that also carries the earlier planning and discovery. Use `start-work` only when the user explicitly wants one continuous session.

To save a handoff, run the **Handoff Write** recipe. Run the **Entity Create And Edit** recipe to fix its title or body.

## Initiative default

For new feature planning, assume a new initiative by default.

- A new grilling session for a new feature normally needs a new initiative.
- A new PRD for a new feature normally needs a new initiative.
- Reuse an existing initiative only when the user asks for that directly, or when the work is clearly a continuation of an initiative that is already tracked.

Do not add new feature work to an existing initiative only because the themes seem close.

## Working rules

- Act from real tracker results, not from memory.
- Keep `agent-issues` as the source of truth. Do not invent tracker state.
- If the task depends on a tenant or scope, provide the tenant or entity identifier directly to the named recipe.
- Do not turn this skill into a tutorial unless the user asks directly for an explanation of the tooling.
- If the next step is to execute rather than to explain, hand off right away to the matching `ai-*` skill.