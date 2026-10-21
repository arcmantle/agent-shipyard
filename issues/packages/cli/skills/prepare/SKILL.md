---
name: prepare
description: Given whatever the user provides — an ID, a topic, a description, a rough pointer — find all the surrounding tracker context and codebase context relevant to it, then stop for a conversation fork. Widens a single issue, story, or ADR out to its whole owning initiative instead of reporting on just that one entity. Does not narrow to one issue, change any status, or name what to do next. Use at the start of a work session to gather what forked conversations need without growing the session that will run them.
argument-hint: An ID, a topic, or a description of what to look into
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Prepare

One job: given whatever information the user hands you, build a durable orientation to the relevant initiative, so that any conversation forked from here has what it needs without redoing the discovery. This is an initiative briefing, not a snapshot of one issue.

When the input names or resolves to a single issue, user story, or ADR, do not stop at that one entity. Widen out to its whole owning initiative, because any conversation forked from here may end up working on a different issue inside the same initiative. The briefing is initiative-wide, not entity-wide.

Do not narrow the input down to a single issue to work on. Do not decide what gets built. Do not write production code, run tests, change any status, or start a build skill in this skill.

## Process

### 1. Take the input as given

Accept anything: an issue, user story, ADR, initiative, or handoff ID; a topic; a plain description; a fragment of a conversation. Do not force it into a single tracked entity first. If it names or describes one or more entities, run the **Entity Read** recipe to resolve them. If it is a handoff, run the **Handoff Read** recipe. If it is a description with no obvious ID, run the **Context Read** recipe with search input and the **Entity List** recipe. It is normal for this to surface zero, one, or many entities — report what exists, do not force a pick.

### 2. Widen each entity to its owning initiative

The briefing must cover the whole initiative an entity belongs to, not just that one entity. A conversation forked from here may end up working on any issue inside the initiative, not only the one the user named.

For every resolved entity that is not itself an initiative, project, or epic:

- Run the **Relation Query** recipe for incoming structural relation types: `tracks`, `decomposes`, `creates`, `owns`, or `records`. The source of the returned edge is the structural parent.
- Repeat on that parent until you reach an entity of kind `initiative`. An issue tracked directly by an initiative takes one hop; a decomposed sub-issue or a user story reached through a PRD can take two or three.
- Treat that initiative, not the original entity, as the scope for the rest of this skill. Keep a note of which entity started the search, so the briefing can say, for example, "started from ISS53, part of INIT7."

If an entity has no owning initiative (a standalone ADR, project, or epic), keep it as its own scope instead.

### 3. Load the whole initiative

For every initiative in scope:

- Run the **Initiative Read** recipe once. It returns the initiative plus every reachable PRD, user story, ADR, and issue, including deeply decomposed sub-issues, together with `fixLinks`, `subIssueLinks`, `blockerLinks`, and `constrainsLinks`. This is the ground truth for initiative scope. Do not rebuild it from separate entity and relation reads.
- Run the **Context Read** recipe for the matching initiative or project scope.
- Read open blockers directly from `blockerLinks`: a `source` whose status is not `done` means its `target` is still blocked. Do not query relations per issue for this.

Stay within the owning initiative. Follow a linked handoff only when it is the input or when it contains information that changes the initiative-level briefing. Do not expand into related initiatives or other linked records just because they are reachable.

### 4. Explore the codebase

Explore the codebase only when it is needed to explain the initiative's purpose, boundaries, or a shared contract. Report broad areas and owning abstractions, not a list of issue seams or likely files that will become stale after the next issue is done. Surface a hard-to-reverse design question only when it is still unresolved in the tracker and it blocks safe implementation; send it to `/agent-issues grill-with-docs` instead of deciding it yourself.

### 5. Report everything found

Return a compact, self-contained briefing so a fresh conversation does not need to redo discovery:

- The initiative's purpose, durable scope, and important boundaries.
- The purpose of the current open work, grouped by durable work area. Do not enumerate every issue or preserve exact issue counts and statuses unless they explain a blocker or a dependency that matters to the forked conversation.
- Only the relations that affect those work areas: open blockers, parent boundaries, user-story outcomes, and ADR constraints.
- The glossary terms and decisions that apply.
- Broad codebase areas and owning abstractions, only where they clarify the initiative's boundaries.
- Only open questions that are both unresolved in the tracker and blocking safe implementation. Do not repeat questions already answered by grilling, the PRD, an ADR, or another tracked decision. If none remain, say that there are no blocking open questions.

If the input named one entity inside the initiative, say so, but do not shrink the briefing back down to just that entity.

Do not recommend a single issue to build next, and do not set any status. Selecting the next issue is the `next-work` skill's job, not this one.

### 6. Stop for the fork

End your response with this instruction, and do not continue past it:

> Fork this conversation now. Pick up the next step in the new conversation with whatever this briefing points to.

Do not start a build skill yourself, even if asked to continue in the same reply. The fork is what keeps the next step's context small.

### 7. Handle replies that stay in this conversation

The user may answer an open question from the briefing right here instead of forking first. An answer is not an order to keep going.

- Treat the answer as new input for the briefing, not as authorization to build. Fold it in, restate the affected part of the briefing, and end with the same fork instruction from step 6 again.
- Only start a build skill, write code, run tests, or change status if the user's reply is an explicit instruction to do so (for example, "go ahead and implement it" or "start implement"). A reply that only answers a question, states a preference, or resolves ambiguity is not that instruction.
- If it is unclear whether the reply is an answer or an instruction to proceed, ask which one it is instead of guessing.
