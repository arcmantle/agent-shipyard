---
name: to-prd
description: Turn an explicit ready Plan into a PRD, create the tracked PRD in agent-issues, and create the user stories that the PRD commits to.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->

This skill turns an explicit ready Plan and relevant codebase knowledge into a PRD. Do not run an open-ended interview.

A PRD is not created until the `prd` entity exists and its user stories exist as child `userStory` entities.

## Process

1. A ready Plan is required. Resolve the supplied Plan reference when one exists. If no reference is supplied or it is unavailable in the current tracker scope, resolve the active initiative and list its Plans. Use the one ready Plan when exactly one exists. If no ready Plan exists, create one replacement Plan under the active initiative and start `plan` to make it ready; do not create a PRD until that work is complete. If more than one ready Plan exists, ask the user to select one. Do not use an unavailable reference for Plan-entry operations.

2. Run the **Entity Read** recipe for the Plan and the **Relation Query** recipe for its direct incoming `owns` relation. Reject a record that is not a Plan or is not `ready`. The Plan must have one initiative owner.

3. Run the **Plan Entry Read** recipe to read the Plan entries. Select active entries by excluding an entry with `tombstone: true` and an entry whose ID occurs in another entry's `supersededEntryIds`. Use only active Plan entries as the source for the PRD and user stories. Do not copy obsolete entry history.

4. If you have not explored the repo yet, do so now to understand the current state of the code. Choose seams where you will test the feature. Use the established vocabulary throughout the PRD and respect applicable ADRs.

5. Write the PRD from the [PRD recipe](../recipes/prd.md). Write each user story from the [User Story recipe](../recipes/user-story.md). Map active entry roles into the relevant product requirements, decisions, scope, constraints, preferences, considerations, and unresolved implementation questions. The child `userStory` entities are authoritative. Do not duplicate their story text in the PRD body.

6. Save the full PRD markdown from the template in the tracked record body. Run the **Entity Create And Edit** recipe to create the `prd` with its initiative parent and direct body text. This preserves initiative ownership of the PRD.

7. Run the **Entity Create And Edit** recipe to create one `userStory` entity for each approved numbered user story with the PRD as parent. The title can be short, but the body must keep the full committed user story sentence and any essential note tied to that story.

8. Run the **Plan Entry Issue Link** recipe to create the non-structural Plan `informs` PRD provenance relation. The MCP operation supports issue targets. If this Plan link targets a PRD, use the explicit CLI fallback in that recipe. Verify that the PRD has initiative ownership and Plan provenance.

9. Return the PRD content together with the tracked IDs you created. Do not create or update a markdown PRD file. The tracked `prd` and `userStory` records are the only canonical PRD representation for this workflow.

Do not treat a markdown document, chat response, or external issue as the source of truth on its own. Do not create a side markdown PRD as part of this workflow. Do not infer a Plan or reuse an existing PRD during conversion.