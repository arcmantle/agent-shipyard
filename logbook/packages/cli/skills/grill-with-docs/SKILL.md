---
name: grill-with-docs
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

<!-- include:fragment/agent-issues-language -->
<!-- include:fragment/agent-issues-operating-contract -->
Run this interview with the `domain-modeling` skill.

## Persist Plan State

At the start of a new grilling effort, run the **Entity Read** recipe for the active initiative. A Plan is required. If the user gives an explicit Plan reference, resolve it first. Resume it when it is a Plan owned by the active initiative. If it is unavailable in the current tracker scope, state that fact and create one replacement initiative-owned Plan with a stable Goal and Context body. Otherwise, create one initiative-owned Plan. Do not use an unavailable reference for Plan-entry operations or create a duplicate Plan.

Use the **Plan Entry Write** recipe to record planning state as it changes:

- Record each design question as a `question` entry before asking it.
- Record each durable user answer before continuing. When an answer resolves a design question, add a `decision` entry that supersedes the question reference.
- Record each durable fact from code or tool output before it affects later planning. Use the approved role that describes the fact.
- Replace a changed entry by superseding it. A decision targets a question or decision. Edit only corrections.
- Add no entry for transient conversation that does not change planning state.

Before you ask the user to confirm shared understanding, the Grill skill must coordinate the **architecture-capture gate**. Review every active Plan decision, constraint, and durable fact. The Grill skill owns classification and keeps the final classification list. `domain-modeling` owns the context-summary, term, and ADR writes. Complete the gate in this order:

- Classify each active Plan decision, constraint, and durable fact as context, ADR, or Plan-only.
- Classify an item as Plan-only when it is reversible and limited to the current Plan or implementation slice. When a classification is uncertain, resolve it before readiness.
- Direct `domain-modeling` to create or update the initiative context summary with the durable purpose, boundaries, and working agreements that grilling established.
- Define or update an initiative context term for stable domain language, non-obvious system facts, and shared integration contracts that will recur outside this Plan.
- Create an initiative-owned ADR for each settled decision that is hard to reverse, surprising without context, and based on a real trade-off. Do not defer qualifying ADRs to `to-prd` or `to-issues`.
- Keep pilot sequencing, temporary scope, and local implementation details as Plan entries only.

The gate is complete only after `domain-modeling` reports the context and ADR records it wrote, and the Grill skill reports the classification list to the user as the shared-understanding summary. First confirm that the planning frontier is empty. Then complete and report the gate. Then ask the user to confirm shared understanding. Only after confirmation, run the **Entity State And Structure** recipe to set the Plan to `ready`. A ready Plan can retain only explicit implementation-discovery questions.

Interview the user closely about the plan until you reach a shared understanding. Walk down each branch of the design tree. Resolve the dependencies between decisions one by one. For each question, give your recommended answer.

Ask one question at a time. Wait for the user's answer before you ask the next question. Do not ask more than one question at a time. This confuses the user.

If you can answer a question by exploring the codebase, explore the codebase instead.

End the session when the planning frontier is empty and the architecture-capture gate is complete. Do not leave any assumption unstated. Do not act until the user confirms that you and the user have the same understanding.