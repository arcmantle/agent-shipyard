---
name: next-work
description: Selects and recommends the next workable issue from a tracked scope, then reports the reason to work on it next. Use after completing an issue or when choosing the next implementation slice.
argument-hint: Initiative or issue ID
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

# Next Work

Select work. Do not implement it or change the issue status.

## Input

Accept the active initiative, or an issue whose initiative you can resolve from its relations.

## Selection

1. Run the **Next Work** recipe with the supplied initiative or descendant. This operation resolves the owning initiative and returns up to five next-in-line candidates, total available and blocked counts, and `hasMore`.
2. A candidate is **workable** when it appears in `available`. The command excludes issues with an open `blocks` source and parent issues with unfinished decomposed children.
3. Use `unfinishedUnblockCount` to prefer work that releases the most unfinished issues. This count includes an unfinished decomposed parent that the child can release. The server orders candidates by this count, then by immutable issue ID. It does not choose the recommendation.
4. Choose the thinnest tracer-bullet slice among the returned candidates with the largest unblock count. Use the candidates' **Entity Body Read** references only for finalists whose authored outcome or acceptance criteria you need to compare. Use immutable issue ID when those comparisons still tie.
5. Select from the returned list without reading every available issue. `hasMore` is not a request to fetch more. Set an explicit `limit` up to 20 only if the current candidates do not support the selection, and state the reason. Do not increase the limit only to compare more tied issues.
6. Run the selected issue's **Relation Query** recipe for its parent or leaf classification, user stories it `fixes`, and blocker details. Run the **Initiative Read** recipe only for a separate, planned initiative-wide decision.

Use the refreshed graph each time. Do not rely on state you captured before the previous issue finished.

## Result

When one or more issues are workable, always return one explicit recommendation. Do not ask the user to choose between workable issues. The caller can ask for confirmation before it starts the recommended issue.

Return, in this order:

1. **Recommendation:** The selected issue's reference and title.
2. **Why this issue:** A short comparison that states its unfinished unblock count and the tracer-bullet tie-break used against the other returned candidates.
3. **Other candidates:** The other returned candidates, with their references and titles. When `hasMore` is true, state that the returned list is not the complete available list. Do not fetch the remaining issues to report them.
4. The selected issue's:

- Reference and title.
- parent or leaf classification
- user stories it `fixes`
- open blockers

When only one candidate is returned, still label it as the recommendation. Call it the only current choice only when `counts.available` is one.

If no issue is workable, return one of:

- **Complete:** `counts.available` and `counts.blocked` are both zero. No unfinished, non-deferred issue work remains, no matter what the initiative's manual status says.
- **Blocked:** `counts.available` is zero and `counts.blocked` is positive. Report the blocked count. Use the **Entity List** and filtered **Relation Query** recipes only when the caller needs a blocker chain.

Do not set the selected issue to `in-progress`. The caller decides whether to start it.
